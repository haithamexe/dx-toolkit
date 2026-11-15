import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// The interception in a real browser: a page on a recorded site makes API calls, dx answers some itself,
// fails one, slows one and changes a header on another, and the app's server sees only what dx let through.
process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-siteintercept-browser-"));
const { launchDxBrowser } = await import("../tools/dxbrowser.js");
const { siteTarget } = await import("../tools/sites.js");
const { findBrowser } = await import("../tools/browser.js");
type ActivityInput = import("../tools/activity.js").ActivityInput;
type SiteConfig = import("../tools/sites.js").SiteConfig;
type SiteAction = import("../tools/dxbrowser.js").SiteAction;

const PAGE = `<!doctype html><title>Shop</title><body>shop<script>
(async () => {
  const out = {};
  out.cart = await fetch("/api/cart").then((r) => r.text());
  try { await fetch("/api/orders", { method: "POST", body: "{}" }); out.orders = "sent"; } catch (e) { out.orders = "failed"; }
  out.flags = await fetch("/api/flags").then((r) => r.text());
  const t = Date.now();
  await fetch("/api/slow");
  out.slowMs = Date.now() - t;
  out.other = await fetch("/api/untouched").then((r) => r.text());
  await fetch("/report", { method: "POST", body: JSON.stringify(out) });
})();
</script>`;

const seen: Record<string, number> = {};
let flagsHeader: string | undefined;
let report: Record<string, unknown> | undefined;
let server: http.Server;
let base = "";
before(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    seen[url] = (seen[url] ?? 0) + 1;
    if (url === "/report") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        report = JSON.parse(body);
        res.end("ok");
      });
      return;
    }
    if (url === "/api/flags") flagsHeader = String(req.headers["x-debug"] ?? "");
    if (url.startsWith("/api/")) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ from: "server", url }));
    res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("dx answers, fails, slows and edits a recorded site's API calls in a real browser, and records what it did", { skip: findBrowser() ? false : "no Chrome, Edge, Chromium or Brave here", timeout: 60_000 }, async () => {
  const host = new URL(base).host;
  const sites: SiteConfig[] = [{ host, env: "staging", project: "/path/to/shop-website" }];
  const events: ActivityInput[] = [];
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-intercept-profile-"));
  const asked: string[] = [];
  const browser = await launchDxBrowser({
    headless: true,
    profileDir,
    url: `${base}/`,
    targetFor: (u) => (new URL(u).host === host ? siteTarget(u, sites) : undefined),
    onEvent: (e) => events.push(e),
    intercept: (req): SiteAction | undefined => {
      asked.push(`${req.method} ${new URL(req.url).pathname}`);
      const p = new URL(req.url).pathname;
      if (p === "/api/cart") return { kind: "fulfill", status: 200, headers: { "content-type": "application/json" }, body: '{"from":"dx mock"}', tags: { mocked: true } };
      if (p === "/api/orders") return { kind: "fail", reason: "ConnectionReset", tags: { rules: ["Orders down"] } };
      if (p === "/api/flags") return { kind: "continue", headers: { ...req.headers, "x-debug": "1" }, tags: { rules: ["Debug header"] } };
      if (p === "/api/slow") return { kind: "continue", delayMs: 500, tags: { rules: ["Slow"] } };
      return undefined;
    },
  });
  try {
    const end = Date.now() + 30_000;
    while (!report && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    assert.ok(report, `the page finished: ${JSON.stringify(seen)} ${JSON.stringify(asked)}`);
    // What the page saw.
    assert.equal(report.cart, '{"from":"dx mock"}');
    assert.equal(report.orders, "failed");
    assert.deepEqual(JSON.parse(String(report.flags)), { from: "server", url: "/api/flags" });
    assert.ok(Number(report.slowMs) >= 450, `slowed: ${report.slowMs}`);
    assert.deepEqual(JSON.parse(String(report.other)), { from: "server", url: "/api/untouched" });
    // What the app's server saw: nothing for the calls dx answered or failed, the edited header, the rest as sent.
    assert.equal(seen["/api/cart"], undefined, "a mocked call never reaches the server");
    assert.equal(seen["/api/orders"], undefined, "a failed call never reaches the server");
    assert.equal(flagsHeader, "1", "the edited header arrived");
    assert.equal(seen["/api/untouched"], 1);
    // Page loads and the report aren't API calls dx holds for a decision it doesn't have: the report went on.
    assert.equal(seen["/report"], 1);
    // The history says what dx did.
    await new Promise((r) => setTimeout(r, 800));
    const cart = events.find((e) => e.type === "request" && e.url === "/api/cart");
    assert.ok(cart, JSON.stringify(events.map((e) => e.text)));
    assert.equal(cart.mocked, true);
    assert.equal(cart.status, 200);
    assert.equal(cart.responseBody, '{"from":"dx mock"}');
    const slow = events.find((e) => e.type === "request" && e.url === "/api/slow");
    assert.deepEqual(slow?.rules, ["Slow"]);
    const orders = events.find((e) => e.type === "request" && e.url === "/api/orders");
    assert.ok(orders?.error, "the failed call is recorded as failed");
    assert.deepEqual(orders?.rules, ["Orders down"]);
  } finally {
    await browser.close();
    await browser.closed;
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
});

// A site with a service worker (a PWA) answers its page's fetches itself, so DevTools never holds them: dx
// switches the worker off for a recorded site's tab. Found on a real deployed site; the second visit's calls
// went past dx while the first visit's didn't.
const SW_PAGE = `<!doctype html><title>PWA</title><body>pwa<script>
(async () => {
  await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  // Controlled only after a reload, as on a real PWA's second visit.
  if (!sessionStorage.reloaded) { sessionStorage.reloaded = "1"; location.reload(); return; }
  const cart = await fetch("/api/cart").then((r) => r.text());
  await fetch("/report", { method: "POST", body: JSON.stringify({ cart }) });
})();
</script>`;
const SW = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => { if (new URL(e.request.url).pathname.startsWith("/api/")) e.respondWith(fetch(e.request)); });`;

test("a recorded site's service worker doesn't hide its API calls from dx", { skip: findBrowser() ? false : "no Chrome, Edge, Chromium or Brave here", timeout: 60_000 }, async () => {
  const hits: string[] = [];
  let swReport: { cart?: string } | undefined;
  const srv = http.createServer((req, res) => {
    const url = req.url ?? "/";
    hits.push(url);
    if (url === "/sw.js") return void res.writeHead(200, { "content-type": "text/javascript", "service-worker-allowed": "/" }).end(SW);
    if (url === "/report") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        swReport = JSON.parse(body);
        res.end("ok");
      });
      return;
    }
    if (url.startsWith("/api/")) return void res.writeHead(200, { "content-type": "application/json" }).end('{"from":"server"}');
    res.writeHead(200, { "content-type": "text/html" }).end(SW_PAGE);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const host = `127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const sites: SiteConfig[] = [{ host, env: "staging", project: "/path/to/shop-website" }];
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-intercept-sw-profile-"));
  const browser = await launchDxBrowser({
    headless: true,
    profileDir,
    url: `http://${host}/`,
    targetFor: (u) => (new URL(u).host === host ? siteTarget(u, sites) : undefined),
    onEvent: () => undefined,
    intercept: (req): SiteAction | undefined => (new URL(req.url).pathname === "/api/cart" ? { kind: "fulfill", status: 200, headers: { "content-type": "application/json" }, body: '{"from":"dx mock"}', tags: { mocked: true } } : undefined),
  });
  try {
    const end = Date.now() + 30_000;
    while (!swReport && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    assert.ok(swReport, `the page finished: ${JSON.stringify(hits)}`);
    assert.equal(swReport.cart, '{"from":"dx mock"}', "the call was answered by dx, though a service worker controls the page");
    assert.ok(!hits.includes("/api/cart"), "and never reached the server");
  } finally {
    await browser.close();
    await browser.closed;
    srv.close();
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
});

// A signed-in session: the page logs in (a POST that sets a cookie), then calls with the cookie and posts a body.
// dx changing a header or answering one call mustn't cost the others their cookie.
const SESSION_PAGE = `<!doctype html><title>Session</title><body>session<script>
(async () => {
  const out = {};
  await fetch("/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: "octocat" }) });
  out.me = await fetch("/api/me", { credentials: "include" }).then((r) => r.json());
  out.edited = await fetch("/api/profile", { credentials: "include" }).then((r) => r.json());
  out.order = await fetch("/api/orders", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ item: 3 }) }).then((r) => r.json());
  out.other = await fetch("/api/orders", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ item: 4 }) }).then((r) => r.json());
  await fetch("/report", { method: "POST", body: JSON.stringify(out) });
})();
</script>`;

test("a signed-in session keeps its cookies when dx edits a header, and a POST's body reaches the decision and the server", { skip: findBrowser() ? false : "no Chrome, Edge, Chromium or Brave here", timeout: 60_000 }, async () => {
  const served: { url: string; cookie?: string; debug?: string; body?: string }[] = [];
  let sessionReport: Record<string, unknown> | undefined;
  const srv = http.createServer((req, res) => {
    const url = req.url ?? "/";
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      served.push({ url, cookie: req.headers.cookie, debug: String(req.headers["x-debug"] ?? ""), body });
      if (url === "/login") return void res.writeHead(200, { "set-cookie": "sid=abc123; Path=/; HttpOnly", "content-type": "application/json" }).end('{"ok":true}');
      if (url === "/report") {
        sessionReport = JSON.parse(body);
        return void res.end("ok");
      }
      if (url === "/api/me") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ signedIn: /sid=abc123/.test(req.headers.cookie ?? ""), from: "server" }));
      if (url === "/api/profile") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ signedIn: /sid=abc123/.test(req.headers.cookie ?? ""), debug: String(req.headers["x-debug"] ?? "") }));
      if (url === "/api/orders") return void res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ from: "server", got: body }));
      res.writeHead(200, { "content-type": "text/html" }).end(SESSION_PAGE);
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const host = `127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const sites: SiteConfig[] = [{ host, env: "staging", project: "/path/to/shop-website" }];
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-intercept-session-"));
  const decided: string[] = [];
  const browser = await launchDxBrowser({
    headless: true,
    profileDir,
    url: `http://${host}/`,
    targetFor: (u) => (new URL(u).host === host ? siteTarget(u, sites) : undefined),
    onEvent: () => undefined,
    intercept: (req): SiteAction | undefined => {
      const p = new URL(req.url).pathname;
      decided.push(`${req.method} ${p} body=${req.postData ?? ""}`);
      // A header edit on a call that has a cookie, and a mock chosen by the body of a POST.
      if (p === "/api/profile") return { kind: "continue", headers: { ...req.headers, "x-debug": "1" }, tags: { rules: ["Debug header"] } };
      if (p === "/api/orders" && req.postData?.includes('"item":3')) return { kind: "fulfill", status: 200, headers: { "content-type": "application/json" }, body: '{"from":"dx mock for item 3"}', tags: { mocked: true } };
      return undefined;
    },
  });
  try {
    const end = Date.now() + 30_000;
    while (!sessionReport && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    assert.ok(sessionReport, `the page finished: ${JSON.stringify(decided)}`);
    assert.deepEqual(sessionReport.me, { signedIn: true, from: "server" }, "a call dx let through carried the cookie");
    assert.deepEqual(sessionReport.edited, { signedIn: true, debug: "1" }, "a call with an edited header kept its cookie, and got the header");
    assert.deepEqual(sessionReport.order, { from: "dx mock for item 3" }, "a POST answered from its body");
    assert.equal((sessionReport.other as { from: string }).from, "server", "another body goes to the server");
    assert.equal((sessionReport.other as { got: string }).got, '{"item":4}', "with its body whole");
    assert.ok(decided.some((d) => d === 'POST /api/orders body={"item":3}'), "the decision saw the body");
    assert.ok(!served.some((s) => s.url === "/api/orders" && s.body === '{"item":3}'), "the mocked POST never reached the server");
  } finally {
    await browser.close();
    await browser.closed;
    srv.close();
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
});
