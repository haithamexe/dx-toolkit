import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-facets-web-test-"));
const { defaultConfig, saveConfig } = await import("@dx/core");
const { apiRoutes } = await import("../api.js");
const { graphEdges } = await import("../graphapi.js");
const { forgetFacets } = await import("../facetsapi.js");

const call = (key: string, body: Record<string, unknown> = {}, query: Record<string, string> = {}) =>
  apiRoutes()[key]({ method: key.split(" ")[0], path: key.split(" ")[1], query: new URLSearchParams(query), body } as never) as Promise<Record<string, any>> | Record<string, any>;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-facets-web-root-"));
function project(name: string, files: Record<string, string>, git = true): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
  if (git) {
    const run = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
    run("init", "-q", "-b", "main");
    run("config", "user.email", "octocat@example.com");
    run("config", "user.name", "octocat");
    run("add", "-A");
    run("commit", "-q", "-m", "first");
  }
  return dir;
}

const shop = project("shop-website", { "package.json": JSON.stringify({ name: "shop-website", dependencies: { next: "15" } }), ".env": "SECRET=1\n" });
const todo = project("todo-app", { "package.json": JSON.stringify({ name: "todo-app", dependencies: { vite: "6" } }) });
const gateway = project("api-gateway", { "package.json": JSON.stringify({ name: "api-gateway", dependencies: { express: "5" } }), "a.txt": "1\n" });
fs.writeFileSync(path.join(gateway, "a.txt"), "2\n"); // unsaved work
// A project with a stack: a front end, an API and a worker started together.
const suite = project("shop-suite", {
  "package.json": JSON.stringify({ name: "shop-suite" }),
  Procfile: "web: node web.js\napi: node api.js\nworker: node worker.js\n",
});
saveConfig({ ...defaultConfig(), projectsRoots: [root] });

test("the projects are sliced by status, kind and tag, and counted", async () => {
  forgetFacets();
  const all = await call("GET /api/facets");
  assert.equal(all.total, 4);
  assert.equal(all.items.length, 4);
  const kinds = all.counts.kind.map((k: { value: string }) => k.value).sort();
  assert.deepEqual(kinds, ["Next.js", "Node", "Node server", "Vite"]);

  const unsaved = await call("GET /api/facets", {}, { status: "unsaved" });
  assert.deepEqual(unsaved.items.map((i: { name: string }) => i.name), ["api-gateway"], "uncommitted work in a git project");
  const needs = await call("GET /api/facets", {}, { status: "needs" });
  assert.ok(needs.items.some((i: { name: string }) => i.name === "shop-website"), "a .env git would pick up needs you");
  assert.equal(all.counts.status.find((c: { value: string }) => c.value === "needs").count, needs.items.length);
  const next = await call("GET /api/facets", {}, { kind: "Next.js,Vite" });
  assert.deepEqual(next.items.map((i: { name: string }) => i.name), ["shop-website", "todo-app"]);
  const q = await call("GET /api/facets", {}, { status: "running", q: "x" });
  assert.equal(q.items.length, 0);
  assert.equal(q.query, "status=running&q=x");
});

test("tags, pins and views change the slice, and only for known projects with valid values", async () => {
  await call("POST /api/facets/tags", { dir: shop, tags: "client, side project" });
  await call("POST /api/facets/tags", { dir: todo, tags: "client" });
  await call("POST /api/facets/pin", { dir: todo, pinned: true });
  const client = await call("GET /api/facets", {}, { tag: "client" });
  assert.deepEqual(client.items.map((i: { name: string }) => i.name), ["todo-app", "shop-website"], "pinned leads");
  assert.deepEqual(client.items[1].tags, ["client", "side project"]);
  const pinned = await call("GET /api/facets", {}, { pinned: "1" });
  assert.deepEqual(pinned.items.map((i: { name: string }) => i.name), ["todo-app"]);

  await assert.rejects(async () => call("POST /api/facets/tags", { dir: path.join(root, "nope"), tags: "x" }), /isn't in your projects folders/);
  await assert.rejects(async () => call("POST /api/facets/tags", { dir: shop, tags: "bad/tag" }), /isn't a tag/);

  const saved = await call("POST /api/facets/view", { name: "Client work", filter: { tag: ["client"], status: ["running"] } });
  assert.equal(saved.view.id, "client-work");
  const after = await call("GET /api/facets");
  const mine = after.views.find((v: { id: string }) => v.id === "client-work");
  assert.equal(mine.builtin, false);
  assert.equal(mine.query, "status=running&tag=client");
  assert.equal(mine.count, 0, "nothing is running here");
  assert.deepEqual(after.views.filter((v: { builtin: boolean }) => v.builtin).map((v: { id: string }) => v.id), ["needs-me", "running", "unsaved", "pinned"]);
  assert.equal(after.views.find((v: { id: string }) => v.id === "pinned").count, 1);
  await assert.rejects(async () => call("POST /api/facets/view", { name: "Nothing", filter: {} }), /nothing to save/);
  await call("POST /api/facets/view/remove", { id: "client-work" });
  await assert.rejects(async () => call("POST /api/facets/view/remove", { id: "client-work" }), /isn't saved any more/);
});

test("the stack map has a node per service and lines from front end to back end", async () => {
  const g = await call("GET /api/graph", {}, { dir: suite });
  assert.equal(g.stack, true);
  assert.equal(g.source, "procfile");
  assert.deepEqual(g.nodes.map((n: { name: string }) => n.name).sort(), ["api", "web", "worker"]);
  assert.ok(g.nodes.every((n: { status: string }) => n.status === "stopped"), "nothing runs yet");
  assert.equal(g.totals.services, 3);
  assert.equal(g.totals.running, 0);
  const web = g.nodes.find((n: { name: string }) => n.name === "web");
  const api = g.nodes.find((n: { name: string }) => n.name === "api");
  assert.ok(web.tier < api.tier, "front ends sit left of back ends");
  assert.ok(g.edges.some((e: { from: string; to: string; declared: boolean }) => e.from === "web" && e.to === "api" && !e.declared), "a line from web to api, inferred from the roles");
  assert.ok(!g.edges.some((e: { to: string }) => e.to === "worker"), "nothing in front calls a worker: dx's own start-up order isn't a call");

  const single = await call("GET /api/graph", {}, { dir: todo });
  assert.equal(single.stack, false, "one app has no stack to map");
  assert.deepEqual(single.nodes, []);
  await assert.rejects(async () => call("GET /api/graph", {}, { dir: path.join(root, "nope") }), /isn't in your projects folders/);
});

test("lines are declared where a service says what it needs, else inferred from the roles", () => {
  const rate = (name: string) => (name === "api" ? 18 : 0);
  const declared = graphEdges(
    [
      { name: "web", role: "frontend", dependsOn: ["api"] },
      { name: "api", role: "backend", dependsOn: ["db"] },
      { name: "db", role: "data", dependsOn: [] },
    ],
    rate,
    true,
  );
  assert.deepEqual(declared, [
    { from: "web", to: "api", perMinute: 18, declared: true },
    { from: "api", to: "db", perMinute: 0, declared: true },
  ]);
  const startOrder = graphEdges(
    [
      { name: "web", role: "frontend", dependsOn: ["api"] },
      { name: "api", role: "backend", dependsOn: [] },
      { name: "worker", role: "backend", dependsOn: [] },
    ],
    rate,
  );
  assert.deepEqual(startOrder.map((e) => `${e.from}>${e.to}:${e.declared}`), ["web>api:false"], "dependencies dx worked out are start-up order, so they're inferred from roles, and a worker isn't called");
  const inferred = graphEdges(
    [
      { name: "web", role: "frontend", dependsOn: [] },
      { name: "api", role: "backend", dependsOn: [] },
      { name: "db", role: "data", dependsOn: [] },
    ],
    rate,
  );
  assert.deepEqual(inferred.map((e) => `${e.from}>${e.to}:${e.declared}`), ["web>api:false", "api>db:false"]);
  const noBackend = graphEdges(
    [
      { name: "web", role: "frontend", dependsOn: [] },
      { name: "db", role: "data", dependsOn: [] },
    ],
    rate,
  );
  assert.deepEqual(noBackend.map((e) => `${e.from}>${e.to}`), ["web>db"], "without a back end the front end reaches the data");
});

test("the sidebar counts services only for a project that has a stack", async () => {
  const withStack = await call("GET /api/nav", {}, { dir: suite });
  assert.equal(withStack.stack, 3);
  const without = await call("GET /api/nav", {}, { dir: todo });
  assert.equal(without.stack, 0);
});
