import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-changes-test-"));
const { addGitignoreRules, backupText, configBefore, defaultConfig, loadConfig, readChanges, recordChange, removeGitignoreRules, saveConfig, undoChange, writeEnvFile } = await import("../index.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-changes-root-"));
function project(name: string, files: Record<string, string> = {}): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name }));
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
  return dir;
}
saveConfig({ ...defaultConfig(), projectsRoots: [root] });

test("changes are listed newest first, each with what it is and whether it can be undone", () => {
  recordChange({ by: "dx", kind: "a", what: "First" });
  recordChange({ by: "you", kind: "b", what: "Second", permanent: true });
  const list = readChanges();
  assert.deepEqual(list.slice(0, 2).map((c) => c.what), ["Second", "First"]);
  assert.ok(list[0].id && list[0].at);
  assert.notEqual(list[0].id, list[1].id);
  const file = path.join(process.env.DX_HOME!, "changes.jsonl");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600, "kept private");
});

test("taking back .gitignore rules removes exactly what dx added, and the file it made", async () => {
  const shop = project("shop-website", { ".gitignore": "node_modules\ndist\n" });
  const added = addGitignoreRules(shop, [".env", "*.pem"]);
  assert.ok(added.length >= 2);
  const change = recordChange({ by: "dx", kind: "gitignore", dir: shop, what: "rules", undo: { kind: "gitignore-rules", data: { dir: shop, lines: added, created: false } } });
  assert.match(fs.readFileSync(path.join(shop, ".gitignore"), "utf8"), /\.env/);
  await undoChange(change.id);
  assert.equal(fs.readFileSync(path.join(shop, ".gitignore"), "utf8").replace(/\r\n/g, "\n"), "node_modules\ndist\n", "what was there is untouched");
  assert.ok(readChanges().find((c) => c.id === change.id)?.undone, "marked as taken back");
  await assert.rejects(() => undoChange(change.id), /already taken back/);

  const bare = project("todo-app");
  const lines = addGitignoreRules(bare, [".env"]);
  const made = recordChange({ by: "dx", kind: "gitignore", dir: bare, what: "rules", undo: { kind: "gitignore-rules", data: { dir: bare, lines, created: true } } });
  await undoChange(made.id);
  assert.equal(fs.existsSync(path.join(bare, ".gitignore")), false, "a file dx created goes with its rules");
});

test("rules that someone else changed are left alone", () => {
  const dir = project("api-gateway", { ".gitignore": "dist\n" });
  assert.equal(removeGitignoreRules(dir, [".env"]), false, "nothing of dx's there");
  assert.equal(removeGitignoreRules(dir, ["dist"]), false, "only rules dx knows how to add can be taken out");
  assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), "dist\n");
});

test("settings come back as they were, and only settings dx knows", async () => {
  saveConfig({ ...defaultConfig(), projectsRoots: [root], editor: "code", activityDays: 7 });
  const before = loadConfig();
  const after = { ...before, editor: "cursor", activityDays: 30 };
  saveConfig(after);
  const { previous, changed } = configBefore(before, after);
  assert.deepEqual(changed.sort(), ["activityDays", "editor"]);
  const change = recordChange({ by: "you", kind: "config", what: "settings", undo: { kind: "config", data: { previous: { ...previous, projectsRoots: ["/somewhere/else"] } } } });
  await undoChange(change.id);
  const now = loadConfig();
  assert.equal(now.editor, "code");
  assert.equal(now.activityDays, 7);
  assert.deepEqual(now.projectsRoots, [root], "a key outside the list is never written");
});

test("a saved .env comes back from its backup, and only inside a project dx knows", async () => {
  const dir = project("env-app", { ".env": "A=1\n" });
  const backup = backupText("A=1\n");
  writeEnvFile(dir, ".env", "A=2\n");
  const change = recordChange({ by: "you", kind: "env-file", dir, what: "saved", undo: { kind: "env-file", data: { dir, name: ".env", backup } } });
  await undoChange(change.id);
  assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), "A=1\n");

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dx-changes-outside-"));
  fs.writeFileSync(path.join(outside, ".env"), "B=1\n");
  const sneaky = recordChange({ by: "you", kind: "env-file", dir: outside, what: "saved", undo: { kind: "env-file", data: { dir: outside, name: ".env", backup } } });
  await assert.rejects(() => undoChange(sneaky.id), /isn't in your projects folders/);
  assert.equal(fs.readFileSync(path.join(outside, ".env"), "utf8"), "B=1\n", "nothing outside the projects is written");
});

test("a missing backup is said, and permanent changes say they can't be undone", async () => {
  const dir = project("old-backup", { ".env": "A=1\n" });
  const change = recordChange({ by: "you", kind: "env-file", dir, what: "saved", undo: { kind: "env-file", data: { dir, name: ".env", backup: "gone" } } });
  await assert.rejects(() => undoChange(change.id), /isn't kept any more/);
  const push = recordChange({ by: "you", kind: "git-push", what: "pushed", permanent: true });
  await assert.rejects(() => undoChange(push.id), /can't be undone from dx/);
  await assert.rejects(() => undoChange("nope"), /isn't in the list any more/);
});
