import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-claudeapi-test-"));
const { defaultConfig, saveConfig } = await import("@dx/core");
const { apiRoutes } = await import("../api.js");

const call = (key: string, input: { dir?: string; undo?: boolean }) => (apiRoutes()[key]({ query: new URLSearchParams(input.dir ? { dir: input.dir } : {}), body: input } as never) as unknown) as Record<string, unknown>;

test("a project's Claude setup is read, made and taken back through the dashboard's API, for known projects only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-claudeapi-root-"));
  const dir = path.join(root, "todo-app");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  saveConfig({ ...defaultConfig(), projectsRoots: [root] });

  assert.equal(call("GET /api/claude", { dir }).on, false);
  const made = call("POST /api/claude", { dir });
  assert.equal((made.changed as string[]).length, 3);
  assert.equal(made.on, true);
  assert.equal(call("GET /api/claude", { dir }).on, true);
  const undone = call("POST /api/claude", { dir, undo: true });
  assert.equal((undone.changed as string[]).length, 3);
  assert.equal(undone.on, false);
  assert.ok(!fs.existsSync(path.join(dir, "CLAUDE.local.md")));

  assert.throws(() => call("POST /api/claude", { dir: path.join(root, "not-a-project") }), /isn't in your projects folders/);
  fs.mkdirSync(path.join(dir, ".claude"));
  fs.writeFileSync(path.join(dir, ".claude", "settings.local.json"), "{ nope");
  assert.throws(() => call("POST /api/claude", { dir }), /isn't valid JSON, so dx left it alone/);
});
