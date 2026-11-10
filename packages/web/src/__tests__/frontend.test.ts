import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

// The page's own scripts: each one must parse (a typo in one page used to fail only when you opened
// it), and every page in the sidebar must open in a real browser without a script error.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-frontend-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-frontend-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0, activity: false }));
fs.mkdirSync(path.join(root, "todo-app"));
fs.writeFileSync(path.join(root, "todo-app", "package.json"), JSON.stringify({ name: "todo-app", scripts: { dev: "node server.js" } }));

const publicDir = fileURLToPath(new URL("../../public/", import.meta.url));
const { startDashboard } = await import("../server.js");
const { checkPage, findBrowser } = await import("@dx/core");
let dashboard: Awaited<ReturnType<typeof startDashboard>>;
before(async () => {
  dashboard = await startDashboard({ port: 0 });
});
after(async () => {
  await dashboard.close();
});

test("every script in the public folder parses", () => {
  const scripts = fs.readdirSync(publicDir).filter((f) => f.endsWith(".js"));
  assert.ok(scripts.includes("app.js") && scripts.includes("recorder.js"), scripts.join(", "));
  for (const f of scripts) {
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(publicDir, f), "utf8"), { filename: f }), f);
  }
});

test("every page in the sidebar is registered once, with a title", () => {
  const source = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");
  const ids = [...source.matchAll(/\{ id: "([a-z-]+)", label: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 15, ids.join(", "));
  assert.equal(new Set(ids).size, ids.length, `a page id is used twice: ${ids.join(", ")}`);
});

test("each page opens in a real browser without a script error", { skip: findBrowser() ? false : "no Chrome, Edge, Chromium or Brave here", timeout: 180_000 }, async () => {
  const source = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");
  const ids = [...source.matchAll(/\{ id: "([a-z-]+)", label: "([^"]+)"/g)].map((m) => m[1]);
  // A browser each, four at a time: a page's own polling keeps the network from ever being quiet, so one session walking the routes would wait on every step.
  const problems: string[] = [];
  for (let i = 0; i < ids.length; i += 4) {
    await Promise.all(
      ids.slice(i, i + 4).map(async (id) => {
        const r = await checkPage({ url: `${dashboard.url}#/${id}`, timeoutMs: 40_000 });
        if (r.error) problems.push(`${id}: ${r.error}`);
        for (const e of r.exceptions) problems.push(`${id}: ${e.text}`);
        if (!r.title || !/ · dx$/.test(r.title)) problems.push(`${id}: the page's title is "${r.title}"`);
      }),
    );
  }
  assert.deepEqual(problems, [], "a page threw, didn't load, or didn't draw");
});
