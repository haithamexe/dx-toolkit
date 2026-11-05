import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// Open on my phone against a made-up app: the one-time link, the cookie only this session
// accepts, everyone else refused, forwarding only to the project's dev server, the history
// labelled phone, and stopping. A phone is played by plain HTTP requests from this computer.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-phone-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-phone-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0 }));
const app = path.join(root, "shop-website");
fs.mkdirSync(app, { recursive: true });
fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "shop-website", scripts: { dev: "node server.cjs" } }));
fs.writeFileSync(
  path.join(app, "server.cjs"),
  `const http = require("http");
   const s = http.createServer((q, r) => {
     if (q.url === "/api/who") { r.setHeader("content-type", "application/json"); return r.end(JSON.stringify({ cookie: q.headers.cookie || null })); }
     r.setHeader("content-type", "text/html"); r.end("<!doctype html><html><head><title>Shop</title></head><body><h1>Shop</h1></body></html>");
   }).listen(0, "127.0.0.1", () => console.log("Local: http://localhost:" + s.address().port + "/"));`,
);

const { startDashboard } = await import("../server.js");
const { lanAddress } = await import("../phone.js");
let dashboard: Awaited<ReturnType<typeof startDashboard>>;

async function call(p: string, body?: unknown) {
  const res = await fetch(new URL(p, dashboard.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-DX-Token": dashboard.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as any };
}

function get(url: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    }).on("error", reject);
  });
}

before(async () => {
  dashboard = await startDashboard({ port: 0 });
  await call("/api/dev/start", { dir: app });
  for (let i = 0; i < 100; i++) {
    const s = (await call("/api/dev")).data.find((d: { dir: string }) => d.dir === app);
    if (s?.status === "ready") break;
    await new Promise((r) => setTimeout(r, 100));
  }
});
after(async () => {
  await call("/api/phone", { dir: app, on: false });
  await call("/api/dev/stop", { dir: app });
  await dashboard.close();
});

test("open on my phone: a one-time link, then only that phone, only this project", { skip: !lanAddress() && "no local network address here" }, async () => {
  const started = await call("/api/phone", { dir: app, minutes: 10 });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const s = started.data;
  assert.match(s.url, /^http:\/\/(10|192\.168|172)\.[\d.]+:\d+\/__dx\/phone\?c=[0-9a-f]{32}$/);
  assert.ok(s.qr.startsWith("M") && s.qrSize > 25, "a QR code to draw");
  assert.ok(!s.url.includes("127.0.0.1"));

  // Anyone without the cookie is refused, the dashboard isn't reachable through it.
  assert.equal((await get(`${s.address}/`)).status, 403);
  assert.equal((await get(`${s.address}/api/ping`)).status, 403);

  const joined = await get(s.url);
  assert.equal(joined.status, 302);
  const cookie = String(joined.headers["set-cookie"]).split(";")[0];
  assert.match(String(joined.headers["set-cookie"]), /HttpOnly; SameSite=Lax/);
  assert.equal((await get(s.url)).status, 403, "the link works once");

  const page = await get(`${s.address}/`, { cookie, accept: "text/html", "user-agent": "Mozilla/5.0 (iPhone)" });
  assert.equal(page.status, 200);
  assert.match(page.body, /<h1>Shop<\/h1>/);
  assert.match(page.body, /dx-recorder\.js/, "the recorder goes in, so the phone's console and errors are recorded");
  const who = JSON.parse((await get(`${s.address}/api/who`, { cookie: `${cookie}; theme=dark` })).body);
  assert.equal(who.cookie, "theme=dark", "dx's cookie isn't passed to the app");

  // What the phone did is in the history, labelled phone.
  await new Promise((r) => setTimeout(r, 700));
  const view = (await call(`/api/phone?dir=${encodeURIComponent(app)}`)).data;
  assert.equal(view.session.joined, true);
  assert.ok(view.events.some((e: { text: string }) => /\/api\/who/.test(e.text)), JSON.stringify(view.events));

  assert.equal((await call("/api/phone", { dir: app, on: false })).data.stopped, true);
  await assert.rejects(get(`${s.address}/`), "closed");
});

test("open on my phone: only a known project whose dev server runs", async () => {
  assert.equal((await call("/api/phone", { dir: path.join(root, "nope") })).status, 404);
  const other = path.join(root, "todo-app");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "package.json"), JSON.stringify({ name: "todo-app", scripts: { dev: "node -e 0" } }));
  const r = await call("/api/phone", { dir: other });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /isn't running through dx/);
});
