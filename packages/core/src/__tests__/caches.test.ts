import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { listCaches, cleanCache, measureFolder, CACHES, CacheError } = await import("../tools/caches.js");

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function cacheFolder(files: number): string {
  const dir = tmp("dx-cache-");
  for (let i = 0; i < files; i++) fs.writeFileSync(path.join(dir, `pkg-${i}.tgz`), "x".repeat(1000));
  return dir;
}

test("the caches this computer has are found by asking each tool, sized, biggest first; tools that aren't there are left out", async () => {
  const npm = cacheFolder(5);
  const go = cacheFolder(2);
  const run = async (command: string) => (command === "npm" ? `${npm}\n` : command === "go" ? `${go}\r\n` : "'pnpm' is not recognized as an internal or external command\n");
  const home = tmp("dx-cache-home-");
  const list = await listCaches({ run, home });
  assert.deepEqual(list.map((c) => c.id), ["npm", "go"]);
  assert.equal(list[0].bytes, 5000);
  assert.equal(list[1].bytes, 2000);
  assert.equal(list[0].command, "npm cache clean --force");
  // A tool with its cache in a known place under home (Bun) is found without asking it.
  fs.mkdirSync(path.join(home, ".bun", "install", "cache"), { recursive: true });
  fs.writeFileSync(path.join(home, ".bun", "install", "cache", "a"), "y".repeat(10));
  assert.ok((await listCaches({ run, home })).some((c) => c.id === "bun"));
});

test("an answer that isn't a folder that exists is never taken as a cache", async () => {
  const run = async () => "relative/path\n/definitely/not/a/folder\nnot a path at all\n";
  assert.deepEqual(await listCaches({ run, home: tmp("dx-cache-home-") }), []);
});

test("cleaning runs the tool's own command, and says what it freed", async () => {
  const npm = cacheFolder(8);
  const ran: string[] = [];
  const run = async (command: string) => (command === "npm" ? npm : "");
  const exec = async (command: string, args: string[]) => {
    ran.push([command, ...args].join(" "));
    for (const f of fs.readdirSync(npm).slice(0, 6)) fs.rmSync(path.join(npm, f));
    return "";
  };
  const r = await cleanCache("npm", { run, exec, home: tmp("dx-cache-home-") });
  assert.deepEqual(ran, ["npm cache clean --force"]);
  assert.equal(r.before, 8000);
  assert.equal(r.after, 2000);
  assert.equal(r.freed, 6000);
});

test("only a cache dx knows can be cleaned, and a tool's failure is said as it was", async () => {
  await assert.rejects(cleanCache("../etc"), (e: Error) => e instanceof CacheError && (e as InstanceType<typeof CacheError>).status === 404);
  await assert.rejects(cleanCache("docker"), CacheError);
  const npm = cacheFolder(1);
  const run = async () => npm;
  const exec = async () => {
    throw new Error("EACCES: permission denied");
  };
  await assert.rejects(cleanCache("npm", { run, exec, home: tmp("dx-cache-home-") }), /npm cache clean --force didn't work: EACCES/);
  assert.equal(fs.readdirSync(npm).length, 1, "nothing was deleted by dx itself");
  await assert.rejects(cleanCache("pip", { run: async () => "", exec, home: tmp("dx-cache-home-") }), /has no cache here/);
});

test("every cache is cleaned by a command of the tool's own, never a path, and the list is fixed", () => {
  assert.deepEqual(CACHES.map((c) => c.id), ["npm", "pnpm", "yarn", "bun", "pip", "go"]);
  for (const c of CACHES) {
    assert.ok(/^[a-z]+$/.test(c.clean[0]), c.id);
    assert.ok(c.clean[1].every((a) => /^[a-z-]+$/.test(a)), c.id);
  }
});

test("a folder is sized without following links", async () => {
  const dir = cacheFolder(3);
  const outside = cacheFolder(4);
  try {
    fs.symlinkSync(outside, path.join(dir, "link"), "junction");
  } catch {
    // no permission to link here: the test is about the size without it
  }
  assert.equal((await measureFolder(dir)).bytes, 3000);
});
