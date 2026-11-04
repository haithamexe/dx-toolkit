import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// An app run through the dashboard and opened at its .localhost address: what happens there ends
// up in the activity history. Our own dx home and projects folder; local domains on a free port.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-activity-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-activity-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0 }));

const app = path.join(root, "tiny-cart");
fs.mkdirSync(app);
fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "tiny-cart", scripts: { dev: "node server.cjs" } }));
fs.writeFileSync(
  path.join(app, "server.cjs"),
  `const http = require("http");
   const page = '<!doctype html><html><head><title>Tiny cart</title></head><body>' +
     '<button id="add">Add to cart</button><p id="out"></p>' +
     '<script src="/app.js"></script></body></html>';
   const js = 'document.getElementById("add").addEventListener("click", async () => {' +
     '  console.log("adding", { id: 7 });' +
     '  history.pushState({}, "", "/cart");' +
     '  const r = await fetch("/api/cart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: 7, password: "hunter2" }) });' +
     '  document.getElementById("out").textContent = "status " + r.status;' +
     '  console.error("Cart failed: " + r.status);' +
     '});';
   const s = http.createServer((q, r) => {
     if (q.url === "/app.js") { r.setHeader("content-type", "text/javascript"); return r.end(js); }
     if (q.url.startsWith("/api/cart")) {
       let body = ""; q.on("data", (d) => (body += d));
       return q.on("end", () => { r.statusCode = 500; r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ error: "out of stock", got: JSON.parse(body || "{}").id })); });
     }
     r.setHeader("content-type", "text/html; charset=utf-8");
     r.end(page);
   }).listen(0, "127.0.0.1", () => console.log("Local: http://localhost:" + s.address().port + "/"));`,
);

const { startDashboard } = await import("../server.js");
const { checkPage, findBrowser, readActivity, readRuns } = await import("@dx/core");
let dashboard: Awaited<ReturnType<typeof startDashboard>>;
const host = "tiny-cart.localhost";
let origin = "";

async function api(p: string, body?: unknown) {
  const res = await fetch(new URL(p, dashboard.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-DX-Token": dashboard.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as any;
}

function viaProxy(p: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: dashboard.localDomainsPort, path: p, method: options.method ?? "GET", headers: { host: `${host}:${dashboard.localDomainsPort}`, ...options.headers } },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

const history = (q = "") => api(`/api/activity?dir=${encodeURIComponent(app)}&since=1h${q}`);

before(async () => {
  dashboard = await startDashboard({ port: 0 });
  origin = `http://${host}:${dashboard.localDomainsPort}`;
  await api("/api/dev/start", { dir: app });
  for (let i = 0; i < 100; i++) {
    const s = (await api("/api/dev")).find((d: { dir: string }) => d.dir === app);
    if (s?.status === "ready") break;
    await new Promise((r) => setTimeout(r, 100));
  }
});
after(async () => {
  await api("/api/dev/stop", { dir: app });
  await dashboard.close();
});

test("pages at .localhost get the recorder script; nothing else is changed", async () => {
  const page = await viaProxy("/", { headers: { accept: "text/html", "accept-encoding": "gzip" } });
  assert.equal(page.status, 200);
  assert.ok(page.body.startsWith('<!doctype html><html><head><script src="/__dx/node_modules/dx-recorder.js"></script><title>Tiny cart</title>'), page.body.slice(0, 200));
  const js = await viaProxy("/app.js", { headers: { accept: "*/*" } });
  assert.ok(!js.body.includes("dx-recorder"), "scripts pass through as they are");
  const recorder = await viaProxy("/__dx/node_modules/dx-recorder.js");
  assert.equal(recorder.status, 200);
  assert.match(String(recorder.headers["content-type"]), /javascript/);
  assert.match(recorder.body, /__dxRecorder/);
  assert.match(recorder.body, /sourceMappingURL=data:application\/json;base64,/);
});

test("the page's events are taken only from the page itself, with credentials masked", async () => {
  const events = JSON.stringify({
    visit: "v1",
    events: [
      { type: "console", level: "warn", text: "token=abcdef123456 expired", at: Date.now(), page: `${origin}/cart` },
      { type: "route", text: "/ → /cart", at: Date.now() },
      { type: "nonsense", text: "dropped" },
      { type: "request", method: "post", url: "http://localhost:4000/login", status: 401, req: '{"user":"alex","password":"hunter2"}', reqType: "application/json", res: '{"error":"no"}', resType: "application/json" },
    ],
  });
  const refused = await viaProxy("/__dx/events", { method: "POST", headers: { origin: "http://evil.example", "content-type": "text/plain" }, body: events });
  assert.equal(refused.status, 403);
  const none = await viaProxy("/__dx/events", { method: "POST", headers: { "content-type": "text/plain" }, body: events });
  assert.equal(none.status, 403, "no Origin, no entry");
  assert.equal((await history("&types=route")).length, 0);

  const taken = await viaProxy("/__dx/events", { method: "POST", headers: { origin, "content-type": "text/plain" }, body: events });
  assert.equal(taken.status, 204);
  const list = await history("&types=console,route,request");
  const consoleLine = list.find((e: { type: string }) => e.type === "console");
  assert.equal(consoleLine.level, "warn");
  assert.equal(consoleLine.text, "token=••• expired");
  assert.equal(consoleLine.from, "browser");
  assert.equal(consoleLine.visit, "v1");
  assert.ok(list.some((e: { type: string; text: string }) => e.type === "route" && e.text === "/ → /cart"));
  const login = list.find((e: { url?: string }) => e.url === "http://localhost:4000/login");
  assert.equal(login.method, "POST");
  assert.equal(login.text, "POST http://localhost:4000/login → 401");
  assert.deepEqual(JSON.parse(login.requestBody), { user: "alex", password: "•••" });
  assert.ok(!list.some((e: { text: string }) => e.text === "dropped"));
});

test("requests through the proxy and the dev server's own lines are in the history, and on disk", async () => {
  await viaProxy("/api/cart", { method: "POST", headers: { "content-type": "application/json", cookie: "sid=secret" }, body: JSON.stringify({ id: 7, password: "hunter2" }) });
  const list = await history();
  const cart = list.find((e: { type: string; url?: string }) => e.type === "request" && e.url === "/api/cart");
  assert.ok(cart, JSON.stringify(list.map((e: { type: string; text: string }) => [e.type, e.text])));
  assert.equal(cart.status, 500);
  assert.equal(cart.level, "error");
  assert.equal(cart.requestHeaders.cookie, "•••");
  assert.deepEqual(JSON.parse(cart.requestBody), { id: 7, password: "•••" });
  assert.match(cart.responseBody, /out of stock/);
  assert.ok(list.some((e: { type: string; text: string }) => e.type === "server" && /^Ready at http:\/\/localhost:\d+/.test(e.text)), "the server's start is there too");
  assert.ok(list.some((e: { type: string }) => e.type === "page"), "the page load from the first test");

  const problems = await history("&problems=1");
  assert.ok(problems.every((e: { level?: string; type: string }) => e.level === "error" || e.level === "warn" || e.type === "error"));
  const searched = await history("&q=out%20of%20stock");
  assert.ok(searched.length >= 1 && searched.every((e: { responseBody?: string }) => /out of stock/.test(e.responseBody ?? "")));

  // Listing without `after` writes what's waiting first, so the files have it all.
  const onDisk = readActivity({ dir: app });
  assert.ok(onDisk.some((e) => e.url === "/api/cart" && e.status === 500));
});

const browser = findBrowser();
test("in a real browser: the click, the route change, the console and the failed call", { skip: browser ? false : "no Chrome, Edge, Chromium or Brave here" }, async () => {
  const r = await checkPage({ url: `${origin}/`, steps: [{ click: "text=Add to cart" }, { waitFor: "text=status 500" }] });
  assert.equal(r.error, undefined, JSON.stringify(r));
  let list: { type: string; text: string; from: string; level?: string; source?: string }[] = [];
  for (let i = 0; i < 40; i++) {
    list = (await history("&types=action,route,console")).filter((e: { from: string }) => e.from === "check");
    if (list.some((e) => e.type === "console" && e.level === "error")) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  const texts = list.map((e) => `${e.type}: ${e.text}`);
  assert.ok(texts.includes("action: Clicked button “Add to cart”"), JSON.stringify(texts));
  assert.ok(texts.includes("route: / → /cart"), JSON.stringify(texts));
  assert.ok(texts.includes('console: adding {"id":7}'), JSON.stringify(texts));
  assert.ok(texts.includes("console: Cart failed: 500"), JSON.stringify(texts));
  const logged = list.find((e) => e.text.startsWith("adding"));
  assert.match(logged?.source ?? "", /^\/app\.js:1:\d+$/, "the page's own line, not the recorder's");

  // The click knows how to find the button again, and the console error's stack starts at the page.
  const all = (await history("&types=action,console")).filter((e: { from: string }) => e.from === "check");
  const click = all.find((e: { type: string }) => e.type === "action");
  assert.equal(click.target, "#add");
  const failed = all.find((e: { level?: string }) => e.level === "error");
  assert.ok(failed.stack && !failed.stack.includes("dx-recorder") && !/^Error$/m.test(failed.stack), failed.stack);

  // A bug report for the console error: the steps that led there and the request, credentials masked.
  const report = await api(`/api/activity/report?dir=${encodeURIComponent(app)}&id=${failed.id}`);
  assert.match(report.markdown, /^## Cart failed: 500/);
  assert.match(report.markdown, /Clicked button “Add to cart”/);
  assert.match(report.markdown, /POST \/api\/cart → 500/);
  assert.match(report.markdown, /"password": "•••"/);
  assert.match(report.markdown, /"error": "out of stock"/);

  // Replay the visit: the same click in a fresh browser, and the same failure found.
  const replayed = await api("/api/activity/replay", { dir: app, visit: click.visit });
  assert.deepEqual(replayed.replay.steps[0], { click: "#add" });
  assert.equal(replayed.result.page.steps[0].ok, true, JSON.stringify(replayed.result.page.steps));
  assert.ok(replayed.result.page.consoleErrors.some((m: { text: string }) => m.text.includes("Cart failed: 500")), JSON.stringify(replayed.result.page));
  const run = readRuns(20).find((r) => r.tool === "replay");
  assert.ok(run?.ok, "the replay is in dx runs, as done");
  assert.match(run.detail ?? "", /replayed 1 step\(s\), \d+ problem\(s\) on the page/);
});

test("how much the history takes, and the limits", async () => {
  const usage = await api("/api/activity/usage");
  assert.ok(usage.bytes > 0);
  assert.equal(usage.maxBytes, 500 * 1024 * 1024);
  assert.equal(usage.dayLimitBytes, 100 * 1024 * 1024);
  assert.equal((await api("/api/config", { activityMaxMB: 1 })).activityMaxMB, 50, "at least 50 MB");
  assert.equal((await api("/api/activity/usage")).maxBytes, 50 * 1024 * 1024);
  await api("/api/config", { activityMaxMB: 500 });
  const missing = await fetch(new URL(`/api/activity/report?dir=${encodeURIComponent(app)}&id=12345`, dashboard.url), { headers: { "X-DX-Token": dashboard.token } });
  assert.equal(missing.status, 404);
});

test("turned off: pages are left alone and nothing is kept; clearing deletes it", async () => {
  await api("/api/config", { activity: false });
  const before = (await history()).length;
  const page = await viaProxy("/", { headers: { accept: "text/html" } });
  assert.ok(!page.body.includes("dx-recorder"));
  await viaProxy("/__dx/events", { method: "POST", headers: { origin, "content-type": "text/plain" }, body: JSON.stringify({ events: [{ type: "route", text: "/a → /b" }] }) });
  assert.equal((await history()).length, before);
  await api("/api/config", { activity: true });

  const cleared = await api("/api/activity/clear", { dir: app });
  assert.equal(cleared.ok, true);
  assert.equal((await history()).length, 0);
  assert.equal(readActivity({ dir: app }).length, 0);
});
