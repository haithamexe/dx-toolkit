import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// The Requests page against a made-up app run through the dashboard: rules that change and fail
// calls, Intercept, the Repeater, the API spec and its map, the mock server and the response cache.
// Our own dx home and projects; nothing reaches beyond this computer.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-lab-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-lab-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0 }));

const SPEC = {
  openapi: "3.0.3",
  info: { title: "Shop API", version: "1" },
  paths: {
    "/api/items": { get: { responses: { 200: { description: "ok", content: { "application/json": { schema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "integer" } } } } } } } } } } } },
    "/api/users/{name}": {
      get: {
        operationId: "getUser",
        responses: {
          200: { description: "ok", content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, email: { type: "string", format: "email" } } } } } },
          404: { description: "missing", content: { "application/json": { examples: { gone: { value: { error: "no such user" } } } } } },
        },
      },
    },
  },
};

const app = path.join(root, "shop-website");
fs.mkdirSync(path.join(app, "docs"), { recursive: true });
fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "shop-website", scripts: { dev: "node server.cjs" } }));
fs.writeFileSync(path.join(app, "docs", "openapi.json"), JSON.stringify(SPEC));
fs.writeFileSync(
  path.join(app, "server.cjs"),
  `const http = require("http");
   const spec = ${JSON.stringify(JSON.stringify(SPEC))};
   const json = (r, status, body) => { r.statusCode = status; r.setHeader("content-type", "application/json"); r.end(JSON.stringify(body)); };
   const s = http.createServer((q, r) => {
     let body = "";
     q.on("data", (c) => (body += c));
     q.on("end", () => {
       if (q.url === "/openapi.json") { r.setHeader("content-type", "application/json"); return r.end(spec); }
       if (q.url === "/api/items") return json(r, 200, { items: [{ id: 1 }], total: 1, source: "server" });
       if (q.url.startsWith("/api/users/")) return json(r, 200, { email: 5 });
       if (q.url === "/api/echo") return json(r, 200, { method: q.method, role: q.headers["x-role"] || null, auth: q.headers.authorization || null, body: body ? JSON.parse(body) : null });
       if (q.url.startsWith("/api/")) return json(r, 404, { source: "server" });
       r.setHeader("content-type", "text/html"); r.end("<!doctype html><title>Shop</title><h1>Shop</h1>");
     });
   }).listen(0, "127.0.0.1", () => console.log("Local: http://localhost:" + s.address().port + "/"));`,
);

const { startDashboard } = await import("../server.js");
let dashboard: Awaited<ReturnType<typeof startDashboard>>;
const host = "shop-website.localhost";

async function call(p: string, body?: unknown) {
  const res = await fetch(new URL(p, dashboard.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-DX-Token": dashboard.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as any };
}
const api = async (p: string, body?: unknown) => {
  const r = await call(p, body);
  assert.ok(r.status < 400, `${p}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};

function request(port: number, p: string, options: { method?: string; headers?: Record<string, string>; body?: string; host?: string } = {}) {
  const started = Date.now();
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; ms: number }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method: options.method ?? "GET", headers: { ...(options.host ? { host: options.host } : {}), ...options.headers } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, ms: Date.now() - started }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}
const viaProxy = (p: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
  request(dashboard.localDomainsPort!, p, { ...options, host: `${host}:${dashboard.localDomainsPort}` });

before(async () => {
  dashboard = await startDashboard({ port: 0 });
  await api("/api/dev/start", { dir: app });
  for (let i = 0; i < 100; i++) {
    const s = (await api("/api/dev")).find((d: { dir: string }) => d.dir === app);
    if (s?.status === "ready") break;
    await new Promise((r) => setTimeout(r, 100));
  }
});
after(async () => {
  await call("/api/mocks/server", { dir: app, on: false });
  await api("/api/dev/stop", { dir: app });
  await dashboard.close();
});

const rule = (r: unknown) => api("/api/lab/rules", { dir: app, rule: r });

test("rules: change a request and its answer on the way, slow it down, make it fail", async () => {
  const items = await rule({ name: "Empty cart", method: "GET", path: "/api/items", response: { json: [{ path: "items", value: [] }, { path: "total", value: 0 }], setHeaders: { "x-from": "dx" } } });
  const res = await viaProxy("/api/items");
  assert.deepEqual(JSON.parse(res.body), { items: [], total: 0, source: "server" });
  assert.equal(res.headers["x-from"], "dx");
  assert.equal(Number(res.headers["content-length"]), Buffer.byteLength(res.body), "the length fits the new body");

  const admin = await rule({ name: "Admin", method: "POST", path: "/api/echo", request: { setHeaders: { "X-Role": "admin" }, removeHeaders: ["authorization"], json: [{ path: "qty", value: 9 }] } });
  const echo = JSON.parse((await viaProxy("/api/echo", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer secret" }, body: '{"qty":1,"sku":"mug"}' })).body);
  assert.deepEqual(echo, { method: "POST", role: "admin", auth: null, body: { qty: 9, sku: "mug" } });
  await api("/api/lab/rules/remove", { dir: app, id: admin.id });

  const listed = await api(`/api/lab/rules?dir=${encodeURIComponent(app)}`);
  assert.equal(listed.find((r: { id: string }) => r.id === items.id).hits, 1);

  // Every change shows in the activity history.
  const events = await api(`/api/activity?dir=${encodeURIComponent(app)}&since=1h`);
  assert.ok(events.some((e: { url: string; rules?: string[] }) => e.url === "/api/items" && e.rules?.includes("Empty cart")));

  await rule({ ...items, response: undefined, fail: "500" });
  const failed = await viaProxy("/api/items");
  assert.equal(failed.status, 500);
  assert.match(failed.body, /Empty cart/);

  await rule({ ...items, response: undefined, fail: undefined, delayMs: 400 });
  assert.ok((await viaProxy("/api/items")).ms >= 380, "delayed");
  await api("/api/lab/rules/remove", { dir: app, id: items.id });
  assert.match((await viaProxy("/api/items")).body, /"total":1/, "gone");

  assert.equal((await call("/api/lab/rules", { dir: app, rule: { path: "/x", request: { setHeaders: { Host: "elsewhere" } } } })).status, 400, "dx's own headers stay dx's");
  assert.equal((await call("/api/lab/rules", { dir: path.join(root, "nope"), rule: { path: "/x" } })).status, 404, "a known project only");
});

test("intercept: a held request is edited, then sent on; a held answer is changed, or dropped", async () => {
  const held = await rule({ name: "Hold echo", method: "POST", path: "/api/echo", intercept: "request" });
  const pending = viaProxy("/api/echo", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer real-token" }, body: '{"qty":1}' });
  let item: any;
  for (let i = 0; i < 50 && !item; i++) {
    item = (await api(`/api/lab/intercept?dir=${encodeURIComponent(app)}`))[0];
    if (!item) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(item, "held");
  assert.equal(item.phase, "request");
  assert.equal(item.body, '{"qty":1}', "the real body, to edit it");
  assert.equal((await call("/api/lab/intercept", { id: item.id, headers: { "x-a": "1\r\nInjected: yes" } })).status, 400);
  await api("/api/lab/intercept", { id: item.id, action: "forward", body: '{"qty":42}', headers: { ...item.headers, "x-role": "tester" } });
  const echo = JSON.parse((await pending).body);
  assert.deepEqual([echo.body.qty, echo.role], [42, "tester"]);
  assert.equal((await call("/api/lab/intercept", { id: item.id, action: "forward" })).status, 404, "already sent on");

  await rule({ ...held, intercept: "response" });
  const p2 = viaProxy("/api/echo", { method: "POST", body: "{}" , headers: { "content-type": "application/json" } });
  let answer: any;
  for (let i = 0; i < 50 && !answer; i++) {
    answer = (await api(`/api/lab/intercept?dir=${encodeURIComponent(app)}`))[0];
    if (!answer) await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(answer.phase, "response");
  await api("/api/lab/intercept", { id: answer.id, action: "forward", status: 503, body: '{"edited":true}' });
  const r2 = await p2;
  assert.deepEqual([r2.status, r2.body], [503, '{"edited":true}']);

  // Turning the rule's intercept off lets go of anything it holds.
  const p3 = viaProxy("/api/echo", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  for (let i = 0; i < 50 && !(await api(`/api/lab/intercept?dir=${encodeURIComponent(app)}`)).length; i++) await new Promise((r) => setTimeout(r, 50));
  await rule({ ...held, intercept: undefined });
  assert.equal((await p3).status, 200);
  await api("/api/lab/rules/remove", { dir: app, id: held.id });
});

test("repeater: sends to the project's own dev server only, and keeps a masked history", async () => {
  const r = await api("/api/lab/send", { dir: app, method: "POST", path: "/api/echo", headers: { "content-type": "application/json", authorization: "Bearer typed-by-hand" }, body: '{"qty":3,"password":"hunter2"}' });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.responseBody).body, { qty: 3, password: "hunter2" }, "the answer shown now is exact");
  assert.equal(r.requestHeaders.authorization, "•••");
  const history = await api(`/api/lab/history?dir=${encodeURIComponent(app)}`);
  assert.doesNotMatch(JSON.stringify(history), /hunter2|typed-by-hand/, "the history is masked");
  assert.equal((await call("/api/lab/send", { dir: app, method: "GET", path: "http://example.com/" })).status, 400, "a path, never an address");
  assert.equal((await call("/api/lab/send", { dir: app, method: "GET", path: "//example.com/x" })).status, 400);
  assert.equal((await call("/api/lab/send", { dir: app, method: "TRACE", path: "/" })).status, 400);
  assert.equal((await call("/api/lab/send", { dir: app, method: "GET", path: "/", headers: { "bad name": "x" } })).status, 400);
  const hidden = await call("/api/lab/send", { dir: app, method: "GET", path: "/api/items", headers: { authorization: "Bearer •••" } });
  assert.equal(hidden.status, 400);
  assert.match(hidden.data.error, /hid the value of authorization/);
  const masked = await api("/api/lab/send", { dir: app, method: "POST", path: "/api/echo", headers: { "content-type": "application/json" }, body: '{"password":"•••"}' });
  assert.equal(masked.masked, true, "says when a hidden value in the body was sent as it is");
});

test("the API spec: found in the project and on the running app, mapped against real calls", async () => {
  const found = await api(`/api/lab/spec?dir=${encodeURIComponent(app)}`);
  assert.deepEqual(found.files, ["docs/openapi.json"]);
  assert.deepEqual([found.spec.source, found.spec.found], ["file:docs/openapi.json", true], "found by itself, nothing to set up");
  // Removed on purpose, it isn't found again, and the running app isn't searched for one.
  await api("/api/lab/spec/forget", { dir: app });
  const gone = await api(`/api/lab/spec?dir=${encodeURIComponent(app)}`);
  assert.deepEqual([gone.spec, gone.removed, gone.looking], [undefined, true, false]);
  assert.equal((await call("/api/lab/spec", { dir: app, file: "../outside.json" })).status, 400, "only files inside the project");

  const fromServer = await api("/api/lab/spec", { dir: app });
  assert.equal(fromServer.source, "url:/openapi.json");
  const fromFile = await api("/api/lab/spec", { dir: app, file: "docs/openapi.json" });
  assert.equal(fromFile.source, "file:docs/openapi.json");
  await viaProxy("/api/users/alice");
  await viaProxy("/api/orders");
  const mapped = (await api(`/api/lab/spec?dir=${encodeURIComponent(app)}`)).spec.map;
  const users = mapped.endpoints.find((e: { path: string }) => e.path === "/api/users/{name}");
  assert.equal(users.calls, 1);
  assert.ok(users.issues.some((i: string) => /name is missing/.test(i)), users.issues.join("; "));
  assert.ok(users.issues.some((i: string) => /email is a number, the spec says text/.test(i)), users.issues.join("; "));
  assert.ok(mapped.undocumented.some((u: { path: string }) => u.path === "/api/orders"));
  assert.equal((await call("/api/lab/spec", { dir: app, text: '{"not":"a spec"}' })).status, 400);
});

test("the mock server: answers from the spec from the first call, picks answers like Postman, only for pages on this computer", async () => {
  const made = await api("/api/lab/spec/mocks", { dir: app });
  assert.ok(made.added >= 3);
  const s = await api("/api/mocks/server", { dir: app, on: true });
  assert.equal(s.host, "shop-website.mock.localhost");
  // The dev server has no /api/users: the mock server answers anyway.
  const user = await request(s.port, "/api/users/alice");
  assert.equal(user.status, 200);
  assert.ok(JSON.parse(user.body).name, "made up from the schema");
  assert.equal(user.headers["x-dx-mock"], "1");
  const gone = await request(s.port, "/api/users/alice", { headers: { "x-mock-response-code": "404" } });
  assert.deepEqual([gone.status, JSON.parse(gone.body)], [404, { error: "no such user" }]);
  assert.equal((await request(s.port, "/api/users/alice", { headers: { "x-mock-response-name": "gone" } })).status, 404);
  assert.equal((await request(s.port, "/api/nothing")).status, 404);
  // CORS for pages on this computer only.
  assert.equal((await request(s.port, "/api/items", { headers: { origin: "http://localhost:5173" } })).headers["access-control-allow-origin"], "http://localhost:5173");
  assert.equal((await request(s.port, "/api/items", { headers: { origin: "https://evil.example" } })).headers["access-control-allow-origin"], undefined);
  // Through the local domains too.
  const viaDomain = await request(dashboard.localDomainsPort!, "/api/users/bob", { host: `shop-website.mock.localhost:${dashboard.localDomainsPort}` });
  assert.equal(viaDomain.status, 200);
  assert.equal((await api(`/api/mocks?dir=${encodeURIComponent(app)}`)).server.port, s.port);
});

test("the cache: real answers kept as mocks until purged; they beat made-up ones", async () => {
  await api("/api/mocks/mode", { dir: app, cache: true });
  await viaProxy("/api/items");
  await new Promise((r) => setTimeout(r, 1300));
  const list = await api(`/api/mocks?dir=${encodeURIComponent(app)}`);
  const cached = list.endpoints.find((e: { source?: string; path: string }) => e.source === "cache" && e.path === "/api/items");
  assert.ok(cached, "kept");
  const s = (await api(`/api/mocks?dir=${encodeURIComponent(app)}`)).server;
  assert.match((await request(s.port, "/api/items")).body, /"source":"server"/, "the real answer, over the spec's made-up one");
  const purged = await api("/api/mocks/purge", { dir: app, source: "cache" });
  assert.equal(purged.removed, 1);
  assert.doesNotMatch((await request(s.port, "/api/items")).body, /"source":"server"/);
  assert.equal((await call("/api/mocks/purge", { dir: app, source: "everything" })).status, 400);
  await api("/api/mocks/mode", { dir: app, cache: false });
});
