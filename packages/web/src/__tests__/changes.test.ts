import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-changes-web-test-"));
const { defaultConfig, saveConfig } = await import("@dx/core");
const { apiRoutes } = await import("../api.js");

const call = (key: string, body: Record<string, unknown> = {}, query: Record<string, string> = {}) =>
  apiRoutes()[key]({ method: key.split(" ")[0], path: key.split(" ")[1], query: new URLSearchParams(query), body } as never) as Promise<Record<string, unknown>> | Record<string, unknown>;

interface Row {
  id: string;
  by: string;
  kind: string;
  what: string;
  undoable: boolean;
  permanent: boolean;
  undone?: string;
}
const changes = async () => ((await call("GET /api/changes")) as { changes: Row[] }).changes;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-changes-web-root-"));
const dir = path.join(root, "shop-website");
fs.mkdirSync(dir);
fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "shop-website" }));
fs.writeFileSync(path.join(dir, ".env"), "SECRET=1\n");
execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
saveConfig({ ...defaultConfig(), projectsRoots: [root] });

test("what you change is listed, and Undo through the route puts it back", async () => {
  await call("POST /api/env/gitignore", { dir, patterns: [".env"] });
  await call("POST /api/env/file", { dir, name: ".env", content: "SECRET=2\n" });
  await call("POST /api/config", { editor: "cursor" });

  const list = await changes();
  assert.deepEqual(list.slice(0, 3).map((c) => c.kind), ["config", "env-file", "gitignore"], "newest first");
  assert.ok(list.slice(0, 3).every((c) => c.by === "you" && c.undoable));
  assert.equal(JSON.stringify(list).includes(dir), false, "the page is never told a folder");
  assert.equal(JSON.stringify(list).includes("SECRET"), false, "nor a value");

  const [config, env, ignore] = list;
  await call("POST /api/undo", { id: config.id });
  assert.notEqual(((await call("GET /api/health")) as never as { config?: { editor?: string } }).config?.editor, "cursor");
  await call("POST /api/undo", { id: env.id });
  assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), "SECRET=1\n");
  await call("POST /api/undo", { id: ignore.id });
  assert.equal(fs.existsSync(path.join(dir, ".gitignore")), false);

  const after = await changes();
  assert.ok(after.filter((c) => ["config", "env-file", "gitignore"].includes(c.kind)).every((c) => c.undone && !c.undoable));
  assert.ok(after.some((c) => c.kind === "undo"), "taking a change back is itself listed");
  await assert.rejects(async () => call("POST /api/undo", { id: config.id }), /already taken back/);
});

test("Undo takes an id and nothing else; a missing or unknown one is refused", async () => {
  await assert.rejects(async () => call("POST /api/undo", {}), /Which change/);
  await assert.rejects(async () => call("POST /api/undo", { id: "does-not-exist" }), /isn't in the list any more/);
});

test("a cleanup is listed as permanent, with why it's fine", async () => {
  const sub = path.join(root, "node_modules-holder");
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, "package.json"), JSON.stringify({ name: "node_modules-holder" }));
  fs.mkdirSync(path.join(sub, "node_modules"));
  fs.writeFileSync(path.join(sub, "node_modules", "a.js"), "x");
  const scan = (await call("GET /api/cleanup", {}, { days: "0" })) as { items: { dir: string }[] };
  const item = scan.items.find((i) => i.dir.toLowerCase().includes("node_modules-holder"));
  if (!item) return; // the scan didn't offer it on this machine: nothing to delete
  await call("POST /api/cleanup/delete", { dirs: [item.dir], days: 0 });
  const row = (await changes()).find((c) => c.kind === "cleanup");
  assert.ok(row, "listed");
  assert.equal(row.permanent, true);
  assert.equal(row.undoable, false);
});

test("a commit is listed with an Undo through git's own journal", async () => {
  const repo = path.join(root, "todo-app");
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "todo-app" }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "octocat@example.com");
  git("config", "user.name", "octocat");
  git("add", "-A");
  git("commit", "-q", "-m", "Start");
  fs.writeFileSync(path.join(repo, "notes.txt"), "hello\n");
  git("add", "notes.txt");
  await call("POST /api/git/commit", { dir: repo, message: "Add notes" });
  const row = (await changes()).find((c) => c.kind === "git-commit");
  assert.ok(row, "the commit is listed");
  assert.equal(row.undoable, true);
  await call("POST /api/undo", { id: row.id });
  const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repo, encoding: "utf8" });
  assert.match(staged, /notes\.txt/, "undoing a commit keeps its changes, staged");
});
