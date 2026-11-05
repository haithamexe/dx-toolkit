import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// The Tour page, proof for the pull request, trying an upgrade and queries per request, through the
// dashboard's routes: they take known projects only, check what they're given, and never act on
// text from the request. Our own dx home and projects only; nothing reaches GitHub or the registry.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-team-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-team-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0 }));

const app = path.join(root, "shop-website");
fs.mkdirSync(path.join(app, "src", "pages"), { recursive: true });
fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "shop-website", scripts: { dev: "node server.cjs" }, dependencies: { react: "^18.3.1" } }));
fs.writeFileSync(path.join(app, "src", "pages", "cart.tsx"), "export default function Cart() { return null; }\n");
fs.writeFileSync(path.join(app, ".env.example"), "API_KEY=\n");
fs.writeFileSync(path.join(app, ".env"), "API_KEY=never-shown-anywhere\n");
fs.writeFileSync(path.join(app, ".gitignore"), ".env\n");
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=octocat", "-c", "user.email=octocat@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: app, encoding: "utf8" });
git("init", "-q", "-b", "main");
git("add", "-A");
git("commit", "-qm", "Shop");
git("checkout", "-q", "-b", "fix-cart");

const { startDashboard } = await import("../server.js");
let dashboard: Awaited<ReturnType<typeof startDashboard>>;

async function call(p: string, body?: unknown) {
  const res = await fetch(new URL(p, dashboard.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-DX-Token": dashboard.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as any };
}
const q = `dir=${encodeURIComponent(app)}`;

before(async () => {
  dashboard = await startDashboard({ port: 0 });
});
after(async () => {
  await dashboard?.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test("the tour: pages from the code, settings by name only", async () => {
  const r = await call(`/api/tour?${q}`);
  assert.equal(r.status, 200);
  assert.ok(r.data.tour.pages.some((p: { path: string; file: string }) => p.path === "/cart" && p.file === "src/pages/cart.tsx"));
  assert.deepEqual(r.data.tour.env.map((e: { name: string }) => e.name), ["API_KEY"]);
  assert.ok(r.data.markdown.startsWith("# shop-website"));
  assert.ok(!JSON.stringify(r.data).includes("never-shown-anywhere"));
  assert.equal((await call(`/api/tour?dir=${encodeURIComponent(os.tmpdir())}`)).status, 404, "a known project only");
});

test("the proof is read from the branch; adding it to a pull request refuses without one", async () => {
  const r = await call(`/api/proof?${q}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.branch, "fix-cart");
  assert.match(r.data.markdown, /^<!-- dx:proof:start -->\n## How this was tested/);
  const pr = await call(`/api/proof/pr?${q}`);
  assert.equal(pr.status, 200);
  assert.equal(pr.data.pr, null, "no remote, so no pull request");
  // The body is never taken from the request: there's nothing here to add it to.
  assert.equal((await call("/api/proof/pr", { dir: app, markdown: "anything" })).status, 409);
});

test("trying an upgrade checks the package and version before anything runs", async () => {
  const c = await call(`/api/upgrade?${q}`);
  assert.equal(c.status, 200);
  assert.deepEqual(c.data.choices.map((x: { name: string }) => x.name), ["react"]);
  assert.equal((await call("/api/upgrade", { dir: app, name: "left-pad", version: "latest" })).status, 400);
  assert.equal((await call("/api/upgrade", { dir: app, name: "react", version: "19 && calc" })).status, 400);
  assert.equal((await call("/api/upgrade", { dir: app, name: "../react" })).status, 400);
  assert.equal((await call("/api/upgrade", { dir: path.join(root, "nope"), name: "react" })).status, 404);
});

test("a copy of a stack uses the project's own database and gets a port of its own", async () => {
  const { startDevServer, devServer, stopDevServer } = await import("../dev.js");
  const { readProject } = await import("@dx/core");
  const inv = path.join(root, "inventory");
  fs.mkdirSync(inv);
  fs.writeFileSync(path.join(inv, "package.json"), JSON.stringify({ name: "inventory", scripts: { dev: "node server.cjs" } }));
  // A compose file that names its project: a copy would reach the very same container.
  fs.writeFileSync(path.join(inv, "compose.yaml"), "name: inventory-dev\nservices:\n  db:\n    image: postgres:16-alpine\n    ports:\n      - \"55499:5432\"\n");
  fs.writeFileSync(path.join(inv, "server.cjs"), `require("http").createServer((q, r) => r.end("ok")).listen(Number(process.env.PORT) || 5199, "127.0.0.1", function () { console.log("Local: http://localhost:" + this.address().port + "/"); });`);
  const project = readProject(inv)!;
  startDevServer(project, "dashboard", { snapshot: true });
  let info = devServer(inv);
  for (let i = 0; i < 100 && info?.status !== "ready"; i++) {
    await new Promise((r) => setTimeout(r, 100));
    info = devServer(inv);
  }
  assert.equal(info?.status, "ready", JSON.stringify(info));
  assert.deepEqual(info!.services!.map((s) => s.service), ["app"], "the database isn't started (or stopped) by the copy");
  assert.match(info!.note ?? "", /Uses inventory's own db/);
  assert.ok(info!.url && !info!.url.endsWith(":5199"), `on a port of its own: ${info!.url}`);
  await stopDevServer(inv);
});

test("queries per request need a database in docker-compose", async () => {
  const r = await call(`/api/queries?${q}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { databases: [], report: null });
  const on = await call("/api/queries", { dir: app, on: true });
  assert.equal(on.status, 409);
  assert.match(on.data.error, /no Postgres or MySQL/);
});
