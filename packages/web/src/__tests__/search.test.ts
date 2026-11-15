import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// Code search through the dashboard: the routes, what they refuse, and the page in a real browser.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-search-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-search-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0 }));

function project(name: string, files: Record<string, string>): string {
  const dir = path.join(root, name);
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  const run = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "octocat@example.com");
  run("config", "user.name", "octocat");
  return dir;
}
const shop = project("shop-website", {
  "package.json": JSON.stringify({ name: "shop-website" }),
  "src/cart.ts": "export function cartTotal(items: number[]) {\n  // the total\n  return items.reduce((a, b) => a + b, 0);\n}\n",
  "src/pay.ts": "import { cartTotal } from './cart';\nexport const pay = () => cartTotal([1, 2]);\n",
  ".env": "API_KEY=sk-live-do-not-show\n",
});
const todo = project("todo-app", { "package.json": JSON.stringify({ name: "todo-app" }), "src/list.ts": "export const cartLike = 1;\n" });

const { startDashboard } = await import("../server.js");
const { checkPage, findBrowser } = await import("@dx/core");
let dashboard: Awaited<ReturnType<typeof startDashboard>>;
before(async () => {
  dashboard = await startDashboard({ port: 0 });
});
after(async () => {
  await dashboard.close();
});

async function get(p: string) {
  const res = await fetch(new URL(p, dashboard.url), { headers: { "X-DX-Token": dashboard.token } });
  return { status: res.status, json: (await res.json()) as any };
}
const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

test("a search of one project finds files and lines, and says how long it took", async () => {
  const r = await get(`/api/search?${q({ dir: shop, q: "cartTotal" })}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.scope, "project");
  assert.deepEqual(r.json.files.map((f: { path: string }) => f.path).sort(), ["src/cart.ts", "src/pay.ts"]);
  const cart = r.json.files.find((f: { path: string }) => f.path === "src/cart.ts");
  assert.equal(cart.hits[0].kind, "definition");
  assert.ok(r.json.totals.ms >= 0 && r.json.facets.ext.some((f: { value: string }) => f.value === "ts"));
  const names = await get(`/api/search?${q({ dir: shop, q: "pay", mode: "files" })}`);
  assert.equal(names.json.files[0].path, "src/pay.ts");
});

test("every project at once, each file with its project", async () => {
  const r = await get(`/api/search?${q({ q: "cart", scope: "all", mode: "content" })}`);
  assert.equal(r.status, 200);
  assert.deepEqual([...new Set(r.json.files.map((f: { project: string }) => f.project))].sort(), ["shop-website", "todo-app"]);
  assert.ok(r.json.projects.length >= 2);
});

test("a secrets file is found by name and never read, and the preview refuses it", async () => {
  const content = await get(`/api/search?${q({ dir: shop, q: "do-not-show" })}`);
  assert.deepEqual(content.json.files, []);
  assert.ok(!JSON.stringify(content.json).includes("sk-live"));
  const name = await get(`/api/search?${q({ dir: shop, q: ".env", mode: "files" })}`);
  assert.ok(name.json.files.some((f: { path: string }) => f.path === ".env"));
  assert.equal((await get(`/api/search/preview?${q({ dir: shop, file: ".env" })}`)).status, 404);
});

test("the preview gives a window of a listed file, and nothing outside the project", async () => {
  const w = await get(`/api/search/preview?${q({ dir: shop, file: "src/cart.ts", line: "3", around: "3" })}`);
  assert.equal(w.status, 200);
  assert.deepEqual(w.json.lines.map((l: { line: number }) => l.line), [1, 2, 3, 4]);
  assert.equal(w.json.total, 4);
  for (const file of ["../todo-app/src/list.ts", "/etc/passwd", "..\\todo-app\\package.json", "src/missing.ts", ""]) {
    assert.equal((await get(`/api/search/preview?${q({ dir: shop, file })}`)).status, 404, file);
  }
  assert.equal((await get(`/api/search/preview?${q({ dir: path.join(root, "nope"), file: "src/cart.ts" })}`)).status, 404);
});

test("a bad mode, an unknown project and a bad pattern are told apart", async () => {
  assert.equal((await get(`/api/search?${q({ dir: shop, q: "x", mode: "everything" })}`)).status, 400);
  assert.equal((await get(`/api/search?${q({ dir: path.join(root, "nope"), q: "x" })}`)).status, 404);
  const bad = await get(`/api/search?${q({ dir: shop, q: "(oops", regex: "1", mode: "content" })}`);
  assert.equal(bad.status, 200);
  assert.ok(bad.json.patternError);
  const empty = await get(`/api/search?${q({ dir: shop, q: "" })}`);
  assert.deepEqual(empty.json.files, []);
});

test("filters narrow by kind and folder, and an unsafe folder is dropped", async () => {
  const ts = await get(`/api/search?${q({ dir: shop, q: "cart", ext: "ts" })}`);
  assert.ok(ts.json.files.every((f: { ext: string }) => f.ext === "ts"));
  const none = await get(`/api/search?${q({ dir: shop, q: "cart", ext: "css" })}`);
  assert.deepEqual(none.json.files, []);
  const escape = await get(`/api/search?${q({ dir: shop, q: "cart", folder: "../todo-app" })}`);
  assert.equal(escape.status, 200);
  assert.ok(escape.json.files.every((f: { path: string }) => !f.path.includes("list.ts")), "a folder with .. isn't used");
});

test("the search page draws results, marks the matches and previews the selected line", { skip: findBrowser() ? false : "no Chrome, Edge, Chromium or Brave here", timeout: 90_000 }, async () => {
  const r = await checkPage({ url: `${dashboard.url}#/search?${q({ dir: shop, q: "cartTotal" })}`, steps: [{ waitFor: ".result" }, { waitFor: ".pv-line" }], timeoutMs: 40_000 });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.deepEqual(r.exceptions, []);
  assert.match(r.text ?? "", /src\/cart\.ts/);
  assert.match(r.text ?? "", /2 files/);
  assert.match(r.text ?? "", /Lines 1 to \d+ of \d+/, "the preview shows the file around the selected match");
  assert.doesNotMatch(r.text ?? "", /(?<![a-z])null(?![a-z])|\bundefined\b|\[object /);
  assert.ok(!(r.text ?? "").includes("sk-live"));
});
