import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// A two-service stack (an API and a front end that needs it) run through the dashboard, and
// reached through local domains. Our own dx home and projects folder; local domains on a free
// port instead of 80.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-stack-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-stack-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0 }));

const shop = path.join(root, "shop");
fs.mkdirSync(shop);
fs.writeFileSync(path.join(shop, "package.json"), JSON.stringify({ name: "shop" }));
fs.writeFileSync(path.join(shop, ".devrc.json"), JSON.stringify({ stack: { web: { dev: "node web.cjs", dependsOn: ["api"] }, api: { dev: "node api.cjs" } } }));
fs.writeFileSync(
  path.join(shop, "api.cjs"),
  `const http = require("http");
   function price(item) { return item.price; }
   const s = http.createServer((q, r) => {
     if (q.url === "/boom") { try { price(undefined); } catch (e) { console.error(e.stack); } r.statusCode = 500; return r.end("no"); }
     if (q.url === "/go") { r.writeHead(302, { location: "http://localhost:" + s.address().port + "/there" }); return r.end(); }
     r.setHeader("content-type", "application/json");
     r.end(JSON.stringify({ ok: true, host: q.headers.host, forwarded: q.headers["x-forwarded-host"] }));
   }).listen(0, "127.0.0.1", () => console.log("API listening on http://localhost:" + s.address().port));`,
);
fs.writeFileSync(
  path.join(shop, "web.cjs"),
  `const http = require("http");
   const api = process.env.DX_API_URL;
   console.log("public " + process.env.DX_API_PUBLIC_URL);
   console.log("api is at " + api);
   http.get(api + "/health", (res) => {
     console.log("api answered " + res.statusCode);
     const s = http.createServer((q, r) => { r.setHeader("content-type", "text/html"); r.end("<title>Shop</title>front end"); });
     // A WebSocket-ish echo, to check upgrades pass through the proxy.
     s.on("upgrade", (req, socket) => {
       socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n");
       socket.on("data", (d) => socket.write("echo:" + d));
     });
     s.listen(0, "127.0.0.1", () => console.log("  Local:   http://localhost:" + s.address().port + "/"));
   }).on("error", (e) => { console.error("api unreachable: " + e.message); process.exit(1); });`,
);

const { startDashboard } = await import("../server.js");
let dashboard: Awaited<ReturnType<typeof startDashboard>>;

before(async () => {
  dashboard = await startDashboard({ port: 0 });
});
after(async () => {
  await dashboard.close();
});

async function api(p: string, body?: unknown) {
  const res = await fetch(new URL(p, dashboard.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-DX-Token": dashboard.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as any;
}

/** A request to the local domains proxy with a given Host, as a browser visiting shop.localhost sends. */
function viaProxy(host: string, p = "/"): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: dashboard.localDomainsPort, path: p, headers: { host: `${host}:${dashboard.localDomainsPort}` } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the project list shows the stack dx found", async () => {
  const [p] = await api("/api/projects");
  assert.equal(p.name, "shop");
  assert.equal(p.stack.source, "devrc");
  assert.deepEqual(p.stack.services.map((s: { name: string }) => s.name).sort(), ["api", "web"]);
});

test("the stack starts in order, passes addresses along, and is served at shop.localhost", async () => {
  assert.ok(dashboard.localDomainsPort, "local domains are on");
  const started = await api("/api/dev/start", { dir: shop });
  assert.equal(started.status, "starting");
  assert.equal(started.services.length, 2);

  const ready = await api("/api/dev/wait", { dir: shop, until: "ready", after: 0, timeoutMs: 30000 });
  assert.equal(ready.server.status, "ready", JSON.stringify(ready.lines.map((l: { text: string }) => l.text)));
  const text = ready.lines.map((l: { service?: string; text: string }) => `${l.service}|${l.text}`).join("\n");
  assert.match(text, /web\|api is at http:\/\/localhost:\d+/, "the front end got the API's direct address");
  assert.match(text, /web\|public http:\/\/api\.shop\.localhost:\d+/, "and its local domain");
  assert.match(text, /web\|api answered 200/, "and the API was ready before the front end started");
  const base = `localhost:${dashboard.localDomainsPort}`;
  assert.equal(ready.server.localUrl, `http://shop.${base}`);
  const services = Object.fromEntries(ready.server.services.map((s: { service: string }) => [s.service, s]));
  assert.equal(services.api.localUrl, `http://api.shop.${base}`);
  assert.equal(services.web.status, "ready");

  // Through the proxy: the front end at shop.localhost, the API at api.shop.localhost.
  const front = await viaProxy("shop.localhost");
  assert.equal(front.status, 200);
  assert.match(front.body, /front end/);
  const back = await viaProxy("api.shop.localhost", "/health");
  assert.equal(back.status, 200);
  const json = JSON.parse(back.body);
  assert.match(json.host, /^localhost:\d+$/, "the dev server sees the Host it expects");
  assert.equal(json.forwarded, `api.shop.localhost:${dashboard.localDomainsPort}`);

  const redirect = await viaProxy("api.shop.localhost", "/go");
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, `http://api.shop.${base}/there`, "redirects point back through the proxy");

  const unknown = await viaProxy("nope.localhost");
  assert.equal(unknown.status, 404);
  assert.match(unknown.body, /Nothing runs at nope\.localhost/);
  assert.match(unknown.body, /shop\.localhost/);
  assert.equal((await viaProxy("evil.example.com")).status, 404);

  const dx = await viaProxy("dx.localhost");
  assert.equal(dx.status, 200, "the dashboard itself at dx.localhost");
  assert.match(dx.body, /dx-token/);
});

test("WebSocket upgrades (live reload) pass through", async () => {
  const reply = await new Promise<string>((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: dashboard.localDomainsPort! }, () => {
      socket.write(`GET /hmr HTTP/1.1\r\nHost: shop.localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (d) => {
      data += d;
      if (data.includes("\r\n\r\n") && !data.includes("echo:")) socket.write("ping");
      if (data.includes("echo:ping")) {
        socket.destroy();
        resolve(data);
      }
    });
    socket.on("error", reject);
    setTimeout(() => reject(new Error(`no echo, got: ${data}`)), 5000);
  });
  assert.match(reply, /^HTTP\/1\.1 101/);
});

test("errors are tagged with their service, and checks work on .localhost addresses", async () => {
  const r = await api("/api/check", { url: "http://api.shop.localhost/boom" });
  assert.equal(r.status, 500);
  assert.equal(r.project, "shop/api");
  assert.equal(r.serverErrors.length, 1);
  assert.equal(r.serverErrors[0].service, "api");
  assert.match(r.serverErrors[0].message, /^TypeError/);
  const [entry] = await api(`/api/dev/errors?dir=${encodeURIComponent(shop)}`);
  assert.equal(entry.errors[0].service, "api");
  const missing = await fetch(new URL("/api/check", dashboard.url), {
    method: "POST",
    headers: { "X-DX-Token": dashboard.token, "Content-Type": "application/json" },
    body: JSON.stringify({ url: "http://ghost.localhost/" }),
  });
  assert.equal(missing.status, 400);
});

test("requests through the local domains are logged, with credentials masked", async () => {
  const body = JSON.stringify({ email: "alex@example.com", password: "hunter2", items: [{ id: 7 }] });
  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: dashboard.localDomainsPort,
        method: "POST",
        path: "/orders",
        headers: { host: "api.shop.localhost", "content-type": "application/json", authorization: "Bearer abc123", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve());
      },
    );
    req.on("error", reject);
    req.end(body);
  });
  const log = await api(`/api/traffic?dir=${encodeURIComponent(shop)}`);
  const order = log.find((e: { path: string }) => e.path === "/orders");
  assert.ok(order, JSON.stringify(log.map((e: { path: string }) => e.path)));
  assert.equal(order.method, "POST");
  assert.equal(order.status, 200);
  assert.equal(order.service, "api");
  assert.equal(order.kind, "api");
  assert.equal(order.requestHeaders.authorization, "•••");
  assert.deepEqual(JSON.parse(order.requestBody), { email: "alex@example.com", password: "•••", items: [{ id: 7 }] });
  assert.match(order.responseBody, /"ok":true/);
  const everything = await api(`/api/traffic?dir=${encodeURIComponent(shop)}&all=1`);
  assert.ok(log.some((e: { path: string }) => e.path === "/health"), JSON.stringify(everything.map((e: { path: string; kind: string; status: number; service: string }) => [e.path, e.kind, e.status, e.service])));

  const failedOnly = await api(`/api/traffic?dir=${encodeURIComponent(shop)}&failed=1`);
  assert.ok(failedOnly.every((e: { status: number }) => e.status >= 400));
});

test("stopping the stack stops every service and frees its addresses", async () => {
  await api("/api/dev/stop", { dir: shop });
  let server: any;
  for (let i = 0; i < 60; i++) {
    server = (await api("/api/dev")).find((s: { dir: string }) => s.dir === shop);
    if (server?.status === "stopped") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(server.status, "stopped");
  assert.ok(server.services.every((s: { status: string }) => s.status === "stopped"));
  assert.equal((await viaProxy("shop.localhost")).status, 404);
  await api("/api/dev/clear", { dir: shop });
  assert.equal((await api("/api/dev")).length, 0);
});
