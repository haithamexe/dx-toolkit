import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// The Chaos page against a made-up app run through the dashboard: chaos mode in the proxy (the
// same seed breaking the same calls), the page's clock, what the page reports about itself, the
// routes' checks, and gremlins in a headless browser. Our own dx home and projects only.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-chaos-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-chaos-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0 }));

const app = path.join(root, "shop-website");
fs.mkdirSync(app, { recursive: true });
fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "shop-website", scripts: { dev: "node server.cjs" } }));
fs.writeFileSync(path.join(app, "app.js"), "document.getElementById('boom').addEventListener('click', () => { throw new Error('boom clicked'); });");
fs.writeFileSync(
  path.join(app, "server.cjs"),
  `const http = require("http");
   const fs = require("fs");
   const s = http.createServer((q, r) => {
     let body = "";
     q.on("data", (c) => (body += c));
     q.on("end", () => {
       if (q.url === "/api/items") { r.setHeader("content-type", "application/json"); return r.end(JSON.stringify({ items: [{ id: 1, name: "Blue mug", price: 12.5 }], total: 1 })); }
       if (q.url === "/app.js") { r.setHeader("content-type", "text/javascript"); return r.end(fs.readFileSync(__dirname + "/app.js")); }
       r.setHeader("content-type", "text/html");
       r.end('<!doctype html><html><head><title>Shop</title></head><body><h1>Shop</h1><button id="boom">Boom</button><script src="/app.js"></script></body></html>');
     });
   }).listen(0, "127.0.0.1", () => console.log("Local: http://localhost:" + s.address().port + "/"));`,
);

import type { ChaosFault } from "@dx/core";
const core = await import("@dx/core");
const { startDashboard } = await import("../server.js");
const { acceptBrowserEvents } = await import("../recorder.js");
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

/** One request through the proxy; a connection closed halfway comes back as `dropped`. */
function viaProxy(p: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; dropped?: boolean; headers: http.IncomingHttpHeaders }>((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: dashboard.localDomainsPort!, path: p, headers: { host: `${host}:${dashboard.localDomainsPort}`, ...headers } }, (res) => {
      let body = "";
      let ended = false;
      res.on("data", (d) => (body += d));
      res.on("end", () => ((ended = true), resolve({ status: res.statusCode ?? 0, body, headers: res.headers })));
      res.on("error", () => undefined);
      res.on("close", () => !ended && resolve({ status: res.statusCode ?? 0, body, dropped: true, headers: res.headers }));
    });
    req.on("error", () => resolve({ status: 0, body: "", dropped: true, headers: {} }));
    req.end();
  });
}

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
  await call("/api/chaos", { dir: app, on: false, clock: null });
  await api("/api/dev/stop", { dir: app });
  await dashboard.close();
});

test("chaos mode: the proxy breaks exactly the calls the seed says, and never page loads or scripts", async () => {
  const settings = { level: "blackfriday" as const, faults: ["flaky", "ratelimit", "baddata", "drop", "logout"] as ChaosFault[], seed: 4812 };
  const cfg = await api("/api/chaos", { dir: app, on: true, ...settings });
  assert.equal(cfg.on, true);
  const original = JSON.stringify({ items: [{ id: 1, name: "Blue mug", price: 12.5 }], total: 1 });
  const seen: string[] = [];
  const expected: string[] = [];
  for (let n = 0; n < 30; n++) {
    // A page load and a script between the calls: never broken, and not counted.
    if (n % 10 === 0) {
      assert.equal((await viaProxy("/", { accept: "text/html" })).status, 200);
      assert.equal((await viaProxy("/app.js", { accept: "*/*" })).status, 200);
    }
    const r = await viaProxy("/api/items", { accept: "application/json", cookie: "sid=demo" });
    seen.push(r.dropped ? "drop" : r.status === 500 ? "flaky" : r.status === 429 ? "ratelimit" : r.status === 401 ? "logout" : r.body !== original ? "baddata" : "-");
    expected.push(core.decideChaos(settings, { method: "GET", path: "/api/items", n, index: n, signedIn: true })?.fault ?? "-");
  }
  assert.deepEqual(seen, expected);
  for (const f of ["flaky", "logout", "-"]) assert.ok(seen.includes(f), `${f} turned up`);
  const limited = await (async () => {
    for (let i = 0; i < 40; i++) {
      const r = await viaProxy("/api/items", { accept: "application/json" });
      if (r.status === 429) return r;
    }
  })();
  assert.equal(limited?.headers["retry-after"], "5");

  // Starting the run again breaks the same calls again.
  await api("/api/chaos", { dir: app, restart: true });
  const again: string[] = [];
  for (let n = 0; n < 30; n++) {
    const r = await viaProxy("/api/items", { accept: "application/json", cookie: "sid=demo" });
    again.push(r.dropped ? "drop" : r.status === 500 ? "flaky" : r.status === 429 ? "ratelimit" : r.status === 401 ? "logout" : r.body !== original ? "baddata" : "-");
  }
  assert.deepEqual(again, expected);

  // Every broken call says so in the history, and the report counts them.
  await new Promise((r) => setTimeout(r, 700));
  const report = await api(`/api/chaos/report?dir=${encodeURIComponent(app)}`);
  assert.equal(report.calls, 30);
  assert.equal(report.broken, expected.filter((x) => x !== "-").length);
  await api("/api/chaos", { dir: app, on: false });
  assert.equal((await viaProxy("/api/items", { accept: "application/json" })).body, original, "off: untouched");
});

test("the page's clock goes in front of the recorder script; what the page notices about itself is kept", async () => {
  const before = await viaProxy("/__dx/node_modules/dx-recorder.js");
  assert.ok(!before.body.includes("__dxSettings ="));
  await api("/api/chaos", { dir: app, clock: { at: "2026-12-31T23:59:50", timeZone: "Pacific/Auckland", frozen: true } });
  const withClock = await viaProxy("/__dx/node_modules/dx-recorder.js");
  assert.ok(withClock.body.startsWith('window.__dxSettings = {"clock":{"at":"2026-12-31T10:59:50.000Z","frozen":true,"timeZone":"Pacific/Auckland"}};'));
  assert.equal((await call("/api/chaos", { dir: app, clock: { timeZone: "</script><script>alert(1)" } })).status, 400, "only real zone names");
  await api("/api/chaos", { dir: app, clock: null });

  // Pseudo text and right to left: the flags, then dx's own script, in front of the recorder.
  await api("/api/chaos", { dir: app, locale: { pseudo: true, rtl: true } });
  const withLocale = await viaProxy("/__dx/node_modules/dx-recorder.js");
  assert.ok(withLocale.body.startsWith('window.__dxSettings = {};\nwindow.__dxLocale = {"pseudo":true,"rtl":true};'), withLocale.body.slice(0, 120));
  assert.ok(withLocale.body.includes("window.__dxPseudo = {"));
  assert.equal((await call("/api/chaos", { dir: app, locale: "</script>" })).status, 400);
  await api("/api/chaos", { dir: app, locale: null });
  assert.ok(!(await viaProxy("/__dx/node_modules/dx-recorder.js")).body.includes("__dxLocale"));
  assert.equal((await call(`/api/chaos/locale/image?dir=${encodeURIComponent(app)}&name=${encodeURIComponent("../../x@rtl")}`)).status, 400);
  assert.equal((await call(`/api/chaos/locale/image?dir=${encodeURIComponent(app)}&name=home@rtl`)).status, 404);

  const route ={ dir: app, project: "shop-website", port: 1, host: "shop-website.localhost" } as any;
  const got = acceptBrowserEvents(JSON.stringify({ visit: "v1", events: [{ type: "error", problem: "blank", text: "The page went blank" }, { type: "error", problem: "rm -rf", text: "x" }] }), route);
  assert.equal(got[0].problem, "blank");
  assert.equal(got[1].problem, undefined, "only known kinds");
});

test("the chaos routes check what they're given", async () => {
  assert.equal((await call("/api/chaos", { dir: app, level: "apocalypse" })).status, 400);
  assert.equal((await call("/api/chaos", { dir: path.join(root, "nope"), on: true })).status, 404);
  assert.equal((await call(`/api/chaos?dir=${encodeURIComponent(path.join(os.tmpdir()))}`)).status, 404);
  assert.equal((await call("/api/chaos/behaviour", { dir: app, commit: "--exec=evil" })).status, 400);
  assert.equal((await call("/api/chaos/gremlins", { dir: app, path: "//elsewhere.example/x", actions: 5 })).status, 200, "accepted, then refused in the run");
  for (let i = 0; i < 100; i++) {
    const s = await api(`/api/chaos?dir=${encodeURIComponent(app)}`);
    if (s.jobs.gremlins?.finishedAt) {
      assert.equal(s.jobs.gremlins.phase, "failed");
      assert.match(s.jobs.gremlins.error, /path on the project's own server/);
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal((await call("/api/chaos/job?id=nope")).status, 404);
  const g = await api(`/api/chaos/graveyard?dir=${encodeURIComponent(app)}&days=3`);
  assert.equal(g.days, 3);
});

test("gremlins: a headless browser clicks around and reports the error with the steps to it", { skip: !core.findBrowser() && "no Chrome, Edge or Chromium here" }, async () => {
  let job = await api("/api/chaos/gremlins", { dir: app, actions: 6, seed: 7 });
  for (let i = 0; i < 600 && !job.finishedAt; i++) {
    await new Promise((r) => setTimeout(r, 200));
    job = await api(`/api/chaos/job?id=${job.id}`);
  }
  assert.equal(job.phase, "done", job.error);
  const boom = job.result.findings.find((f: { text: string }) => /boom clicked/.test(f.text));
  assert.ok(boom, JSON.stringify(job.result.findings));
  assert.ok(boom.steps.some((s: { click?: string }) => s.click === "#boom"), "the steps lead to it");
  assert.equal(job.result.seed, 7);
});
