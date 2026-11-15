import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// "Mock this app" as one press, walked end to end with a real app behind dx: nothing to mock yet,
// then the app's calls recorded, then mock mode on and the app answered by dx, then edited, then off.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-mockquick-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-mockquick-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0 }));

function project(name: string, files: Record<string, string>): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
  const run = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "octocat@example.com");
  run("config", "user.name", "octocat");
  return dir;
}
const cart = project("cart-app", {
  "package.json": JSON.stringify({ name: "cart-app", scripts: { dev: "node server.cjs" } }),
  "server.cjs": `const http = require("http");
const json = (r, s, b) => { r.statusCode = s; r.setHeader("content-type", "application/json"); r.end(JSON.stringify(b)); };
const s = http.createServer((q, r) => {
  if (q.url.startsWith("/api/cart")) return json(r, 200, { items: [{ id: 1 }], source: "server" });
  if (q.url.startsWith("/api/user")) return json(r, 200, { name: "Octo Cat", source: "server" });
  if (q.url.startsWith("/api/orders") && q.method === "POST") return json(r, 201, { id: 77, source: "server" });
  r.setHeader("content-type", "text/html"); r.end("<!doctype html><title>Cart</title><h1>Cart</h1>");
}).listen(0, "127.0.0.1", () => console.log("Local: http://localhost:" + s.address().port + "/"));`,
});
const spec = project("docs-app", {
  "package.json": JSON.stringify({ name: "docs-app" }),
  "openapi.json": JSON.stringify({ openapi: "3.0.0", info: { title: "Docs", version: "1" }, paths: { "/api/pages": { get: { responses: { "200": { description: "ok", content: { "application/json": { example: { pages: [] } } } } } } } } }),
});

const { startDashboard } = await import("../server.js");
let dashboard: Awaited<ReturnType<typeof startDashboard>>;
before(async () => {
  dashboard = await startDashboard({ port: 0 });
});
after(async () => {
  await dashboard.close();
});

async function call(method: "GET" | "POST", p: string, body?: unknown) {
  const res = await fetch(new URL(p, dashboard.url), { method, headers: { "X-DX-Token": dashboard.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
}
/** A call as the app's page makes it: through dx's .localhost address. */
const viaDx = (p: string, method = "GET") =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: dashboard.localDomainsPort, path: p, method, headers: { host: "cart-app.localhost", accept: "application/json" } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("nothing to mock yet says what to do, instead of failing", async () => {
  const notRunning = await call("POST", "/api/mocks/quick", { dir: cart });
  assert.equal(notRunning.status, 200);
  assert.deepEqual([notRunning.json.state, notRunning.json.reason, notRunning.json.endpoints], ["waiting", "not-running", 0]);

  await call("POST", "/api/dev/start", { dir: cart });
  for (let i = 0; i < 60; i++) {
    const s = (await call("GET", "/api/dev")).json.find((x: { project: string }) => x.project === "cart-app");
    if (s?.status === "ready") break;
    await sleep(250);
  }
  const noCalls = await call("POST", "/api/mocks/quick", { dir: cart });
  assert.deepEqual([noCalls.json.state, noCalls.json.reason], ["waiting", "no-calls"]);
  assert.match(noCalls.json.openUrl, /cart-app\.localhost/, "it says where to open the app so dx sees its calls");
  assert.equal((await call("GET", `/api/mocks?dir=${encodeURIComponent(cart)}`)).json.on, false, "nothing was turned on");
});

test("after the app's calls, one press makes the mocks and turns mock mode on; the app is answered by dx", async () => {
  for (const [p, m] of [["/api/cart", "GET"], ["/api/user", "GET"], ["/api/orders", "POST"]]) await viaDx(p, m);
  await sleep(1200);
  const r = await call("POST", "/api/mocks/quick", { dir: cart });
  assert.equal(r.json.state, "on");
  assert.equal(r.json.source, "calls");
  assert.equal(r.json.endpoints, 3);
  assert.equal(r.json.on, true);

  const summary = (await call("GET", `/api/project/summary?dir=${encodeURIComponent(cart)}`)).json;
  assert.deepEqual(summary.mocks, { on: true, strict: false, endpoints: 3 }, "the project's card can say it");

  const user = await viaDx("/api/user");
  assert.equal(user.status, 200);
  assert.match(user.body, /Octo Cat/);

  const list = (await call("GET", `/api/mocks?dir=${encodeURIComponent(cart)}`)).json;
  const ep = list.endpoints.find((e: { path: string }) => e.path === "/api/user");
  await call("POST", "/api/mocks/update", { dir: cart, id: ep.id, status: 200, body: JSON.stringify({ name: "Test User" }) });
  assert.match((await viaDx("/api/user")).body, /Test User/, "an edit is answered at once");
});

test("pressing it again keeps what you edited; refresh makes them again from the latest calls", async () => {
  const again = await call("POST", "/api/mocks/quick", { dir: cart });
  assert.equal(again.json.source, "existing");
  assert.equal(again.json.endpoints, 3);
  assert.match((await viaDx("/api/user")).body, /Test User/);
  const fresh = await call("POST", "/api/mocks/quick", { dir: cart, refresh: true });
  assert.equal(fresh.json.state, "on");
  assert.match((await viaDx("/api/user")).body, /Test User/, "an edited mock is never overwritten");
});

test("off is one press, and the app goes back to the real server", async () => {
  const off = await call("POST", "/api/mocks/mode", { dir: cart, on: false });
  assert.equal(off.json.on, false);
  assert.match((await viaDx("/api/user")).body, /"source":"server"/);
  const on = await call("POST", "/api/mocks/quick", { dir: cart });
  assert.equal(on.json.state, "on", "and on again without making anything twice");
  assert.equal(on.json.source, "existing");
  await call("POST", "/api/mocks/mode", { dir: cart, on: false });
});

test("with no calls but an API spec, the mocks come from the spec", async () => {
  const r = await call("POST", "/api/mocks/quick", { dir: spec });
  assert.equal(r.status, 200);
  assert.equal(r.json.state, "on");
  assert.equal(r.json.source, "spec");
  assert.ok(r.json.endpoints >= 1);
  await call("POST", "/api/mocks/mode", { dir: spec, on: false });
});

test("it only takes a project dx knows", async () => {
  const r = await call("POST", "/api/mocks/quick", { dir: path.join(root, "nope") });
  assert.equal(r.status, 404);
  assert.equal(r.json.problem.code, "not-found");
});
