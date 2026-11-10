import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-nav-test-"));
const { defaultConfig, saveConfig } = await import("@dx/core");
const { navRoutes } = await import("../navapi.js");

const ask = (dir: string) => navRoutes["GET /api/nav"]({ query: new URLSearchParams({ dir }) } as never) as Promise<{ agents: number; tools: number; data: boolean; env: number }>;

test("the sidebar's optional pages are decided by counts: nothing for a bare project, a warning count for an exposed .env", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-nav-root-"));
  const bare = path.join(root, "todo-app");
  const exposed = path.join(root, "shop-website");
  for (const dir of [bare, exposed]) {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  }
  fs.writeFileSync(path.join(exposed, ".env"), "SECRET=1\n");
  saveConfig({ ...defaultConfig(), projectsRoots: [root] });

  const a = await ask(bare);
  assert.deepEqual({ tools: a.tools, data: a.data }, { tools: 0, data: false });
  assert.equal(a.env, 0, "no .env, nothing to warn about");
  assert.equal(a.agents, 0, "a test's DX_HOME doesn't read the real Claude folder");

  const b = await ask(exposed);
  assert.ok(b.env >= 1, "a .env git would commit shows up as something to look at");

  // A folder dx doesn't know gets zeros, not an error.
  assert.deepEqual(await ask(path.join(root, "not-a-project")), { agents: 0, tools: 0, data: false, env: 0 });
});
