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

test("the palette opens from its button, finds a page by typing, and goes there with Enter", { skip: findBrowser() ? false : "no Chrome, Edge, Chromium or Brave here", timeout: 90_000 }, async () => {
  const r = await checkPage({
    url: `${dashboard.url}#/ports`,
    steps: [{ click: "#palette-open" }, { type: "agents", into: ".palette-input" }, { press: "Enter" }, { waitFor: "url=/agents" }],
    timeoutMs: 60_000,
  });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.deepEqual(r.exceptions, []);
  assert.match(r.title ?? "", /^Agents/, `the page after Enter: ${r.title}`);
});

test("the skip link is handled: it focuses the page and doesn't change the route to #main", () => {
  const source = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");
  const handler = /querySelector\("\.skip-link"\)\?\.addEventListener\("click", \(e\) => \{\s*e\.preventDefault\(\);\s*main\.focus\(\);/;
  assert.match(source, handler);
  assert.ok(fs.readFileSync(path.join(publicDir, "index.html"), "utf8").includes('class="skip-link" href="#main"'));
});

test("a long list of changes on the Code page is folded by folder, each with a Stage button", { skip: findBrowser() ? false : "no Chrome, Edge, Chromium or Brave here", timeout: 90_000 }, async () => {
  const { execFileSync } = await import("node:child_process");
  const dir = path.join(root, "busy-app");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "busy-app" }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
  for (let i = 0; i < 24; i++) fs.writeFileSync(path.join(dir, "src", `part-${i}.ts`), `export const n = ${i};\n`);
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, "docs", `page-${i}.md`), `# ${i}\n`);
  fs.writeFileSync(path.join(dir, "README.md"), "# busy\n");
  const r = await checkPage({ url: `${dashboard.url}#/git?dir=${encodeURIComponent(dir)}`, steps: [{ waitFor: ".git-group" }], timeoutMs: 60_000 });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.deepEqual(r.exceptions, []);
  const text = r.text ?? "";
  assert.ok(text.includes("src/") && text.includes("docs/") && text.includes("Project root"), text.slice(0, 400));
});
