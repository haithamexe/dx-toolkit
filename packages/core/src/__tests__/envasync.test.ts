import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// The .env audit has one set of steps and two ways to run them: the synchronous calls (CLI, MCP,
// tests) and ones that leave the dashboard free while git runs. They must give the same answer,
// and the async one must not hold the event loop.
process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-envasync-home-"));
const { auditEnv, auditEnvAsync, checkEnv, checkEnvAsync, mapLimit } = await import("../index.js");

function repo(withSecret = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-envasync-proj-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=octocat", "-c", "user.email=octocat@example.com", ...a], { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, ".env.example"), "API_URL=\nDB_PASSWORD=\nTOKEN=\n");
  fs.writeFileSync(path.join(dir, ".env"), "API_URL=http://localhost\nDB_PASSWORD=\n");
  fs.writeFileSync(path.join(dir, ".env.local"), "X=1\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules\n");
  // A key-shaped string built from pieces, so this file holds no key either.
  if (withSecret) fs.writeFileSync(path.join(dir, "config.js"), `module.exports = { key: "${"gh" + "p_"}${"a1B2c3D4e5".repeat(4).slice(0, 36)}" };\n`);
  git("add", ".env", ".env.example", ".gitignore", ...(withSecret ? ["config.js"] : []));
  git("commit", "-qm", "start");
  return dir;
}

test("the async audit gives the sync audit's answer: tracked and unignored .env files, missing values, a committed key", async () => {
  const dir = repo();
  const sync = auditEnv(dir, { secrets: true });
  const async_ = await auditEnvAsync(dir, { secrets: true });
  assert.deepEqual(async_, sync);
  assert.equal(sync.git, true);
  assert.ok(sync.files.find((f) => f.name === ".env")?.tracked, ".env is committed");
  assert.ok(sync.files.find((f) => f.name === ".env.local")?.notIgnored, ".env.local isn't ignored");
  assert.deepEqual(sync.missingVars, ["TOKEN"]);
  assert.equal(sync.secrets.length, 1);
  assert.equal(sync.secrets[0].kind, "GitHub token");
  assert.ok(!JSON.stringify(sync.secrets).includes("a1B2c3D4e5a1B2"), "never the whole value");
  assert.deepEqual(await checkEnvAsync(dir), checkEnv(dir));
  assert.deepEqual(await checkEnvAsync(dir, { secrets: false }), checkEnv(dir, { secrets: false }));
});

test("outside git there's nothing to ask git, and both ways agree", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-envasync-plain-"));
  fs.writeFileSync(path.join(dir, ".env"), "A=1\n");
  assert.deepEqual(await auditEnvAsync(dir), auditEnv(dir));
  assert.equal((await auditEnvAsync(dir)).git, false);
});

test("while git runs for several projects the event loop is free", async () => {
  const dirs = Array.from({ length: 5 }, () => repo(false));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 2);
  await Promise.all(dirs.map((d) => auditEnvAsync(d, { secrets: true })));
  clearInterval(timer);
  assert.ok(ticks >= 5, `${ticks} ticks of the event loop while 5 projects were audited`);
});

test("mapLimit keeps the order, never runs more than the limit at once, and a failure takes only its own item", async () => {
  let running = 0;
  let most = 0;
  const out = await mapLimit(
    [1, 2, 3, 4, 5, 6, 7],
    3,
    async (n) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      if (n === 4) throw new Error("bad");
      return n * 10;
    },
    (n) => -n,
  );
  assert.deepEqual(out, [10, 20, 30, -4, 50, 60, 70]);
  assert.ok(most <= 3 && most >= 2, `${most} at once`);
  await assert.rejects(mapLimit([1], 2, async () => Promise.reject(new Error("no fallback"))), /no fallback/);
  assert.deepEqual(await mapLimit([], 4, async (x) => x), []);
});
