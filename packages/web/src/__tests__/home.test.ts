import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-home-test-"));
const { defaultConfig, recordRun, saveConfig } = await import("@dx/core");
const { apiRoutes } = await import("../api.js");

const call = (key: string, dir?: string) => apiRoutes()[key]({ query: new URLSearchParams(dir ? { dir } : {}), body: {} } as never) as Promise<Record<string, unknown>>;

function project(root: string, name: string, files: Record<string, string> = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, scripts: { test: "node --test" } }));
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("Home lists what needs you across projects, with the one-click fix and what already works", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-home-root-"));
  const shop = project(root, "shop-website", { ".env": "SECRET=1\n" });
  project(root, "archive");
  saveConfig({ ...defaultConfig(), projectsRoots: [root] });
  recordRun("test", false, "shop-website: 47 passed, 1 failed", "web", { project: "shop-website" });

  const home = (await call("GET /api/home")) as { projects: number; quiet: number; items: { kind: string; project: string; actions: { label: string; post?: { path: string; body: { patterns?: string[] } } }[] }[]; started: { steps: { done: boolean }[] }; running: unknown[] };
  assert.equal(home.projects, 2);
  assert.deepEqual(home.items.map((i) => `${i.kind}:${i.project}`), ["env:shop-website", "tests:shop-website"]);
  assert.equal(home.quiet, 1, "the other project is quiet");
  const env = home.items[0];
  assert.equal(env.actions[0].label, "Fix it");
  assert.equal(env.actions[0].post?.path, "/api/env/gitignore");
  assert.ok(env.actions[0].post?.body.patterns?.includes(".env"), "the rules it lacks go with the action");
  assert.equal(home.started.steps[0].done, true, "projects were found");
  assert.equal(home.started.steps[3].done, true, "tests have been run through dx");
  assert.deepEqual(home.running, []);

  const summary = (await call("GET /api/project/summary", shop)) as { project: string; server?: unknown; health: { tests?: { failed: number }; secrets: string }; code?: { changed: number }; activity: { requests: number }; next: { label: string }[] };
  assert.equal(summary.project, "shop-website");
  assert.equal(summary.server, undefined, "not running");
  assert.equal(summary.health.secrets, "exposed");
  assert.equal(summary.health.tests?.failed, 1);
  assert.equal(summary.activity.requests, 0);
  assert.ok(summary.next.some((s) => s.label === "Keep .env out of git"));

  const next = (await call("GET /api/next", shop)) as { steps: { label: string }[] };
  assert.deepEqual(next.steps.map((s) => s.label), summary.next.map((s) => s.label));
  await assert.rejects(async () => call("GET /api/project/summary", path.join(root, "nope")), /isn't in your projects folders/);
});
