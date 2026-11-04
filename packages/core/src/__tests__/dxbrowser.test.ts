import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-dxbrowser-test-"));
const { CdpRecorder, checkOpenUrl, launchDxBrowser, CLICK_SCRIPT, RECORDER_WORLD, BINDING } = await import("../tools/dxbrowser.js");
const { addSite, deploymentFrom, guessEnv, listSites, normalizeSiteHost, removeSite, siteForUrl, siteTarget } = await import("../tools/sites.js");
const { maskUrl, maskHeaders, maskBody } = await import("../tools/mask.js");
const { activityFolder, appendActivity, readActivity, siteDir, activityOverview } = await import("../tools/activity.js");
const { findBrowser } = await import("../tools/browser.js");
const { defaultConfig } = await import("../config.js");
type ActivityInput = import("../tools/activity.js").ActivityInput;
type SiteConfig = import("../tools/sites.js").SiteConfig;

// ------------------------------------------------------------------ sites

test("site hosts are validated: a host or host:port, a leading *. only, no path or user", () => {
  assert.equal(normalizeSiteHost("Staging.Shop-Website.dev"), "staging.shop-website.dev");
  assert.equal(normalizeSiteHost("https://staging.shop-website.dev/cart?x=1"), "staging.shop-website.dev");
  assert.equal(normalizeSiteHost("localhost:3000"), "localhost:3000");
  assert.equal(normalizeSiteHost("127.0.0.1:8080"), "127.0.0.1:8080");
  assert.equal(normalizeSiteHost("*.preview.shop-website.dev"), "*.preview.shop-website.dev");
  assert.equal(normalizeSiteHost("[::1]:5173"), "[::1]:5173");
  for (const bad of ["", "shop-website.dev/cart", "user@shop-website.dev", "shop.*.dev", "*", "*.com", "ftp://shop-website.dev", "-bad.dev", "shop website.dev", "shop-website.dev:99999", "a\\b.dev"]) {
    assert.throws(() => normalizeSiteHost(bad), Error, bad);
  }
});

test("the environment is guessed from the host when not given", () => {
  assert.equal(guessEnv("staging.shop-website.dev"), "staging");
  assert.equal(guessEnv("shop-website-staging.example.com"), "staging");
  assert.equal(guessEnv("pr-12.preview.shop-website.dev"), "preview");
  assert.equal(guessEnv("localhost:3000"), "local");
  assert.equal(guessEnv("shop.localhost"), "local");
  assert.equal(guessEnv("shop-website.dev"), "production");
});

test("sites are kept in the config, one per host", () => {
  const config = defaultConfig();
  addSite({ host: "staging.shop-website.dev", project: "/path/to/shop-website" }, config);
  addSite({ host: "STAGING.shop-website.dev", project: "/path/to/shop-website", env: "qa", label: "Shop QA" }, config);
  addSite({ host: "*.preview.shop-website.dev" }, config);
  assert.deepEqual(listSites(config), [
    { host: "staging.shop-website.dev", project: "/path/to/shop-website", env: "qa", label: "Shop QA" },
    { host: "*.preview.shop-website.dev", env: "preview" },
  ]);
  assert.throws(() => addSite({ host: "shop-website.dev", env: "not ok!" }, config));
  assert.equal(removeSite("*.preview.shop-website.dev", config)?.host, "*.preview.shop-website.dev");
  assert.equal(removeSite("nothing.shop-website.dev", config), undefined);
  assert.equal(listSites(config).length, 1);
});

test("only recorded sites and addresses on this computer have a target", () => {
  const sites: SiteConfig[] = [
    { host: "staging.shop-website.dev", project: "/path/to/shop-website", env: "staging" },
    { host: "*.preview.shop-website.dev", env: "preview" },
    { host: "127.0.0.1:4100", env: "staging", label: "Local staging" },
  ];
  assert.deepEqual(siteTarget("https://staging.shop-website.dev/cart", sites), { dir: "/path/to/shop-website", project: "shop-website", site: "staging.shop-website.dev", env: "staging" });
  assert.deepEqual(siteTarget("https://pr-7.preview.shop-website.dev/", sites), { dir: siteDir("*.preview.shop-website.dev"), project: "*.preview.shop-website.dev", site: "pr-7.preview.shop-website.dev", env: "preview" });
  assert.equal(siteTarget("https://preview.shop-website.dev/", sites), undefined, "a wildcard is for subdomains");
  assert.equal(siteTarget("https://shop-website.dev/", sites), undefined);
  assert.equal(siteTarget("https://news.example.org/", sites), undefined);
  assert.equal(siteTarget("chrome://settings", sites), undefined);
  assert.equal(siteTarget("http://127.0.0.1:4100/", sites)?.env, "staging");
  assert.equal(siteTarget("http://127.0.0.1:4100/", sites)?.project, "Local staging");
  assert.deepEqual(siteTarget("http://localhost:5173/", sites), { dir: siteDir("localhost:5173"), project: "localhost:5173", site: "localhost:5173", env: "local" });
  // An exact host wins over a wildcard; one with a port over one without.
  assert.equal(siteForUrl("https://a.preview.shop-website.dev", [...sites, { host: "a.preview.shop-website.dev", env: "qa" }])?.env, "qa");
  assert.equal(siteForUrl("http://staging.shop-website.dev:8443/", [{ host: "staging.shop-website.dev:8443", env: "x" }, { host: "staging.shop-website.dev", env: "y" }])?.env, "x");
});

test("unlinked sites get a history folder of their own, read back by site", () => {
  const dir = siteDir("staging.shop-website.dev");
  assert.match(path.basename(activityFolder(dir)), /^site-staging\.shop-website\.dev-[0-9a-f]{8}$/);
  // Not tied to the folder dx runs in.
  const cwd = process.cwd();
  process.chdir(os.tmpdir());
  try {
    assert.equal(activityFolder(dir), activityFolder("site:STAGING.shop-website.dev"));
  } finally {
    process.chdir(cwd);
  }
  const at = new Date().toISOString();
  appendActivity([
    { id: 1, at, dir, project: "staging.shop-website.dev", type: "request", text: "GET /api/cart → 200", from: "dx-browser", site: "staging.shop-website.dev", env: "staging" },
    { id: 2, at, dir: "/path/to/shop-website", project: "shop-website", type: "error", text: "Boom", from: "dx-browser", site: "shop-website.dev", env: "production" },
    { id: 3, at, dir: "/path/to/shop-website", project: "shop-website", type: "console", text: "hi", level: "log", from: "browser" },
  ]);
  assert.deepEqual(readActivity({ dir }).map((e) => e.id), [1]);
  assert.deepEqual(readActivity({ site: "shop-website.dev" }).map((e) => e.id), [2]);
  assert.deepEqual(readActivity({ site: "*.shop-website.dev" }).map((e) => e.id), [1]);
  assert.deepEqual(readActivity({ dir: "/path/to/shop-website", env: "local" }).map((e) => e.id), [3]);
  const overview = activityOverview();
  const shop = overview.find((o) => o.dir === "/path/to/shop-website");
  assert.equal(shop?.events, 2);
  assert.deepEqual(shop?.envs, { production: { events: 1, problems: 1 }, local: { events: 1, problems: 0 } });
  assert.equal(shop?.sites["shop-website.dev"].env, "production");
  assert.equal(overview.find((o) => o.dir === dir)?.events, 1);
});

// ------------------------------------------------------------------ deployments and masking

test("the deployment comes from what the site sent: headers first, then meta tags", () => {
  assert.deepEqual(deploymentFrom({ "X-Commit": "3f2c9e1ab", server: "Vercel" }), { from: "x-commit header", commit: "3f2c9e1ab", server: "Vercel" });
  assert.deepEqual(deploymentFrom({ "x-app-version": "1.4.0+3f2c9e1" }), { from: "x-app-version header", version: "1.4.0+3f2c9e1", commit: "3f2c9e1" });
  assert.deepEqual(deploymentFrom({ "x-vercel-deployment-url": "shop-website-k2j3.vercel.app" }), { from: "x-vercel-deployment-url header", id: "shop-website-k2j3.vercel.app" });
  assert.equal(deploymentFrom({ "x-version": "2026.11.04" })?.commit, undefined, "a date isn't a commit");
  assert.deepEqual(deploymentFrom({}, { commit: "ABCDEF1234567" }), { from: "meta commit", commit: "abcdef1234567" });
  assert.deepEqual(deploymentFrom({}, { version: "v3.2.1" }), { from: "meta version", version: "v3.2.1" });
  assert.equal(deploymentFrom({ server: "nginx" }), undefined, "a server name alone says nothing about the deployment");
  assert.equal(deploymentFrom({ "x-commit": "a\u0000b".repeat(80) })?.version?.length, 100);
});

test("addresses, headers and bodies are masked before anything is kept", () => {
  assert.equal(maskUrl("/auth/callback?code=abc123&state=xyz"), "/auth/callback?code=•••&state=xyz");
  assert.equal(maskUrl("https://user:pw@shop-website.dev/?token=t0k&page=2"), "https://shop-website.dev/?token=•••&page=2");
  assert.equal(maskUrl("/api/cart?page=2"), "/api/cart?page=2");
  assert.deepEqual(maskHeaders({ Authorization: "Bearer abc", Cookie: "sid=1", "X-DX-Token": "t", Accept: "*/*" }), { authorization: "•••", cookie: "•••", "x-dx-token": "•••", accept: "*/*" });
  assert.equal(maskBody(JSON.stringify({ email: "a@b.c", password: "hunter2", code: "E42" }), "application/json"), JSON.stringify({ email: "a@b.c", password: "•••", code: "E42" }));
});

// ------------------------------------------------------------------ DevTools events to activity

const PAGE = "https://staging.shop-website.dev/cart";
const SITES: SiteConfig[] = [{ host: "staging.shop-website.dev", project: "/path/to/shop-website", env: "staging" }];

function recorder(answers: Record<string, unknown> = {}) {
  const events: ActivityInput[] = [];
  const sent: { method: string; params: object; sessionId?: string }[] = [];
  const r = new CdpRecorder({
    targetFor: (u) => siteTarget(u, SITES),
    onEvent: (e) => events.push(e),
    send: (async (method: string, params: object = {}, sessionId?: string) => {
      sent.push({ method, params, sessionId });
      if (method in answers) return answers[method];
      return {};
    }) as never,
    settleMs: 50,
  });
  return { r, events, sent };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A page attached and navigated to `url`, the way Chrome reports it. */
async function openPage(r: InstanceType<typeof CdpRecorder>, url: string, session = "S1") {
  r.handle("Target.attachedToTarget", { sessionId: session, targetInfo: { targetId: "T1", type: "page", url: "about:blank" }, waitingForDebugger: true });
  await tick();
  r.handle("Network.requestWillBeSent", { requestId: "doc", loaderId: "L1", frameId: "T1", type: "Document", timestamp: 100, wallTime: 1_790_000_000, request: { url, method: "GET", headers: { Accept: "text/html" } } }, session);
  r.handle("Network.responseReceived", { requestId: "doc", type: "Document", response: { status: 200, headers: { "content-type": "text/html", "x-commit": "3f2c9e1ab" }, mimeType: "text/html" } }, session);
  r.handle("Page.frameNavigated", { frame: { id: "T1", url, loaderId: "L1" } }, session);
  r.handle("Network.loadingFinished", { requestId: "doc", timestamp: 100.042 }, session);
  await tick();
}

test("attaching sets the page up: the click listener in its own world, then lets it run", async () => {
  const { r, sent } = recorder();
  r.handle("Target.attachedToTarget", { sessionId: "S1", targetInfo: { targetId: "T1", type: "page", url: "about:blank" }, waitingForDebugger: true });
  await tick();
  await tick();
  const methods = sent.map((s) => s.method);
  for (const m of ["Runtime.addBinding", "Page.addScriptToEvaluateOnNewDocument", "Page.enable", "Network.enable", "Runtime.enable", "Log.enable", "Target.setAutoAttach"]) assert.ok(methods.includes(m), m);
  assert.equal(methods[methods.length - 1], "Runtime.runIfWaitingForDebugger");
  assert.deepEqual(sent.find((s) => s.method === "Runtime.addBinding")?.params, { name: BINDING, executionContextName: RECORDER_WORLD });
  const script = sent.find((s) => s.method === "Page.addScriptToEvaluateOnNewDocument")?.params as { source: string; worldName: string };
  assert.equal(script.worldName, RECORDER_WORLD);
  assert.equal(script.source, CLICK_SCRIPT);
  // A button's own label is the only value it reads: never what was typed in a field.
  assert.ok(CLICK_SCRIPT.includes('(el.type === "submit" || el.type === "button" || el.type === "reset")) label = el.value'));
  assert.ok(!CLICK_SCRIPT.replace('label = el.value || ""', "").includes(".value"), "typed values are never read");
  assert.equal(r.pages(), 1);
});

test("a request on a recorded site becomes a request event, with bodies and headers masked", async () => {
  const { r, events, sent } = recorder({ "Network.getResponseBody": { body: JSON.stringify({ items: [1], token: "t0k" }), base64Encoded: false } });
  await openPage(r, PAGE);
  r.handle(
    "Network.requestWillBeSent",
    {
      requestId: "r1",
      frameId: "T1",
      type: "Fetch",
      timestamp: 101,
      wallTime: 1_790_000_001,
      request: { url: "https://staging.shop-website.dev/api/cart?session_id=abc", method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer secret-value" }, postData: JSON.stringify({ item: 3, password: "hunter2" }) },
    },
    "S1",
  );
  r.handle("Network.responseReceived", { requestId: "r1", type: "Fetch", response: { status: 500, headers: { "content-type": "application/json", "set-cookie": "sid=1" }, mimeType: "application/json" } }, "S1");
  r.handle("Network.loadingFinished", { requestId: "r1", timestamp: 101.25 }, "S1");
  await tick();
  await tick();
  const req = events.find((e) => e.type === "request")!;
  assert.ok(req, "recorded");
  assert.equal(req.dir, "/path/to/shop-website");
  assert.equal(req.site, "staging.shop-website.dev");
  assert.equal(req.env, "staging");
  assert.equal(req.from, "dx-browser");
  assert.equal(req.url, "/api/cart?session_id=•••");
  assert.equal(req.text, "POST /api/cart?session_id=••• → 500");
  assert.equal(req.level, "error");
  assert.equal(req.status, 500);
  assert.equal(req.ms, 250);
  assert.equal(req.at, new Date(1_790_000_001_000).toISOString());
  assert.equal(req.requestBody, JSON.stringify({ item: 3, password: "•••" }));
  assert.equal(req.responseBody, JSON.stringify({ items: [1], token: "•••" }));
  assert.equal(req.requestHeaders?.authorization, "•••");
  assert.equal(req.responseHeaders?.["set-cookie"], "•••");
  assert.equal(req.page, PAGE);
  assert.ok(req.visit && req.visit.length > 8);
  assert.ok(sent.some((s) => s.method === "Network.getResponseBody" && s.sessionId === "S1"));
  // The page load itself, with the deployment its headers named.
  const page = events.find((e) => e.type === "page")!;
  assert.equal(page.url, "/cart");
  assert.equal(page.status, 200);
  assert.deepEqual(page.deploy, { from: "x-commit header", commit: "3f2c9e1ab" });
  assert.equal(page.visit, req.visit);
});

test("scripts, styles and images that loaded fine aren't recorded; failed ones are", async () => {
  const { r, events } = recorder();
  await openPage(r, PAGE);
  const load = (id: string, url: string, type: string, mime: string, status: number) => {
    r.handle("Network.requestWillBeSent", { requestId: id, frameId: "T1", type, timestamp: 1, request: { url, method: "GET", headers: {} } }, "S1");
    r.handle("Network.responseReceived", { requestId: id, type, response: { status, headers: { "content-type": mime }, mimeType: mime } }, "S1");
    r.handle("Network.loadingFinished", { requestId: id, timestamp: 1.01 }, "S1");
  };
  load("a", "https://staging.shop-website.dev/assets/app.js", "Script", "application/javascript", 200);
  load("b", "https://staging.shop-website.dev/logo.png", "Image", "image/png", 200);
  load("c", "https://staging.shop-website.dev/assets/missing.css", "Stylesheet", "text/css", 404);
  load("d", "https://staging.shop-website.dev/favicon.ico", "Other", "text/html", 404);
  r.handle("Network.requestWillBeSent", { requestId: "e", frameId: "T1", type: "Fetch", timestamp: 1, request: { url: "https://staging.shop-website.dev/api/slow", method: "GET", headers: {} } }, "S1");
  r.handle("Network.loadingFailed", { requestId: "e", timestamp: 2, errorText: "net::ERR_ABORTED", canceled: true }, "S1");
  r.handle("Network.requestWillBeSent", { requestId: "f", frameId: "T1", type: "Fetch", timestamp: 1, request: { url: "https://staging.shop-website.dev/api/down", method: "GET", headers: {} } }, "S1");
  r.handle("Network.loadingFailed", { requestId: "f", timestamp: 2, errorText: "net::ERR_CONNECTION_REFUSED" }, "S1");
  await tick();
  await tick();
  const requests = events.filter((e) => e.type === "request").map((e) => e.text);
  assert.deepEqual(requests, ["GET /assets/missing.css → 404", "GET /api/down → failed (net::ERR_CONNECTION_REFUSED)"]);
});

test("a page on a site that isn't recorded produces nothing, and nothing is asked of it", async () => {
  const { r, events, sent } = recorder({ "Network.getResponseBody": { body: "{}", base64Encoded: false } });
  await openPage(r, "https://news.example.org/today");
  r.handle("Network.requestWillBeSent", { requestId: "x", frameId: "T1", type: "XHR", timestamp: 1, request: { url: "https://news.example.org/api/feed", method: "POST", headers: {}, postData: "a=1" } }, "S1");
  r.handle("Network.responseReceived", { requestId: "x", type: "XHR", response: { status: 200, headers: {}, mimeType: "application/json" } }, "S1");
  r.handle("Network.loadingFinished", { requestId: "x", timestamp: 2 }, "S1");
  r.handle("Runtime.consoleAPICalled", { type: "error", args: [{ type: "string", value: "oops" }], timestamp: Date.now() }, "S1");
  r.handle("Runtime.exceptionThrown", { timestamp: Date.now(), exceptionDetails: { text: "Uncaught", exception: { type: "object", description: "Error: x" } } }, "S1");
  r.handle("Runtime.bindingCalled", { name: BINDING, payload: JSON.stringify({ type: "action", text: "Clicked button “Buy”" }) }, "S1");
  r.handle("Page.navigatedWithinDocument", { frameId: "T1", url: "https://news.example.org/tomorrow" }, "S1");
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(events, []);
  assert.ok(!sent.some((s) => s.method === "Network.getResponseBody" || s.method === "Network.getRequestPostData" || s.method === "Runtime.evaluate"));
});

test("a recorded page's calls to another host are kept without their bodies", async () => {
  const { r, events } = recorder({ "Network.getResponseBody": { body: '{"ok":true}', base64Encoded: false } });
  await openPage(r, PAGE);
  r.handle("Network.requestWillBeSent", { requestId: "t", frameId: "T1", type: "Fetch", timestamp: 1, request: { url: "https://payments.example.com/v1/intents", method: "POST", headers: { "content-type": "application/json" }, postData: '{"amount":5}' } }, "S1");
  r.handle("Network.responseReceived", { requestId: "t", type: "Fetch", response: { status: 200, headers: { "content-type": "application/json" }, mimeType: "application/json" } }, "S1");
  r.handle("Network.loadingFinished", { requestId: "t", timestamp: 1.1 }, "S1");
  await tick();
  const e = events.find((x) => x.type === "request")!;
  assert.equal(e.url, "https://payments.example.com/v1/intents");
  assert.equal(e.requestBody, undefined);
  assert.equal(e.responseBody, undefined);
});

test("console output, exceptions, route changes and clicks map to the recorder's events", async () => {
  const { r, events } = recorder();
  await openPage(r, PAGE);
  const t = Date.now();
  r.handle(
    "Runtime.consoleAPICalled",
    {
      type: "error",
      timestamp: t,
      args: [
        { type: "string", value: "Cart failed" },
        { type: "object", preview: { properties: [{ name: "id", value: "7" }, { name: "token", value: "abcdefgh" }] } },
      ],
      stackTrace: { callFrames: [{ functionName: "load", url: "https://staging.shop-website.dev/assets/app.js", lineNumber: 9, columnNumber: 4 }] },
    },
    "S1",
  );
  r.handle("Runtime.consoleAPICalled", { type: "log", timestamp: t, args: [{ type: "string", value: "[vite] connected." }] }, "S1");
  r.handle("Runtime.consoleAPICalled", { type: "warning", timestamp: t, args: [{ type: "string", value: "Deprecated prop" }] }, "S1");
  r.handle(
    "Runtime.exceptionThrown",
    {
      timestamp: t,
      exceptionDetails: {
        text: "Uncaught (in promise)",
        exception: { type: "object", subtype: "error", description: "TypeError: Cannot read properties of undefined (reading 'items')\n    at render (https://staging.shop-website.dev/assets/app.js:3:7)" },
        stackTrace: { callFrames: [{ functionName: "render", url: "https://staging.shop-website.dev/assets/app.js", lineNumber: 2, columnNumber: 6 }] },
      },
    },
    "S1",
  );
  r.handle("Page.navigatedWithinDocument", { frameId: "T1", url: "https://staging.shop-website.dev/checkout?code=s3cr3t" }, "S1");
  r.handle("Runtime.bindingCalled", { name: BINDING, payload: JSON.stringify({ type: "action", text: "Clicked button “Pay now”", target: "[data-testid=\"pay\"]", at: t }) }, "S1");
  r.handle("Runtime.bindingCalled", { name: BINDING, payload: JSON.stringify({ type: "console", text: "forged" }) }, "S1");
  r.handle("Runtime.bindingCalled", { name: BINDING, payload: "not json" }, "S1");

  const consoleError = events.find((e) => e.type === "console" && e.level === "error")!;
  assert.equal(consoleError.text, 'Cart failed {"id":7,"token":"•••"}');
  assert.equal(consoleError.source, "/assets/app.js:10:5");
  assert.match(consoleError.stack ?? "", /at load \(https:\/\/staging\.shop-website\.dev\/assets\/app\.js:10:5\)/);
  assert.equal(events.filter((e) => e.type === "console").length, 2, "the dev server's chatter is left out");
  assert.equal(events.find((e) => e.type === "console" && e.level === "warn")?.text, "Deprecated prop");
  const error = events.find((e) => e.type === "error")!;
  assert.equal(error.text, "Unhandled promise rejection: TypeError: Cannot read properties of undefined (reading 'items')");
  assert.equal(error.source, "/assets/app.js:3:7");
  assert.match(error.stack ?? "", /^TypeError/);
  const route = events.find((e) => e.type === "route")!;
  assert.equal(route.text, "/cart → /checkout?code=•••");
  assert.equal(route.page, "https://staging.shop-website.dev/checkout?code=•••");
  const click = events.find((e) => e.type === "action")!;
  assert.equal(click.text, "Clicked button “Pay now”");
  assert.equal(click.target, '[data-testid="pay"]');
  assert.equal(events.filter((e) => e.type === "action").length, 1, "only clicks and submits come through the binding");
  for (const e of events) {
    assert.equal(e.env, "staging");
    assert.equal(e.from, "dx-browser");
  }
});

test("without a deployment header, the page's meta tags are read once it has parsed", async () => {
  const { r, events, sent } = recorder({ "Runtime.evaluate": { result: { value: { version: "2.3.0", commit: "abcdef1234" } } } });
  r.handle("Target.attachedToTarget", { sessionId: "S1", targetInfo: { targetId: "T1", type: "page" }, waitingForDebugger: false });
  await tick();
  r.handle("Network.requestWillBeSent", { requestId: "doc", loaderId: "L9", frameId: "T1", type: "Document", timestamp: 5, request: { url: PAGE, method: "GET", headers: {} } }, "S1");
  r.handle("Network.responseReceived", { requestId: "doc", type: "Document", response: { status: 200, headers: { "content-type": "text/html" }, mimeType: "text/html" } }, "S1");
  r.handle("Network.loadingFinished", { requestId: "doc", timestamp: 5.1 }, "S1");
  await tick();
  assert.equal(events.length, 0, "held until the page has parsed");
  r.handle("Page.domContentEventFired", { timestamp: 5.2 }, "S1");
  await tick();
  await tick();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].deploy, { from: "meta commit, meta version", commit: "abcdef1234", version: "2.3.0" });
  assert.ok(sent.some((s) => s.method === "Runtime.evaluate"));
  assert.ok(!sent.some((s) => s.method === "Runtime.runIfWaitingForDebugger"), "a page that wasn't waiting isn't resumed");
});

test("addresses to open must be http(s), without a user name or password", () => {
  assert.equal(checkOpenUrl("https://staging.shop-website.dev/cart"), "https://staging.shop-website.dev/cart");
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "chrome://settings", "staging.shop-website.dev", "https://user:pw@shop-website.dev/"]) {
    assert.throws(() => checkOpenUrl(bad), Error, bad);
  }
});

// ------------------------------------------------------------------ the real thing

const SHOP = `<!doctype html><meta name="version" content="1.0.0"><title>Shop</title><button id="buy">Add to cart</button>
<script>
  fetch("/api/cart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ item: 3, password: "hunter2" }) })
    .then((r) => r.json())
    .then((j) => { console.error("Cart failed", j.error); document.getElementById("buy").click(); });
</script>`;

let server: http.Server;
let other: http.Server;
let base = "";
let otherBase = "";
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/api/cart") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "out of stock", got: JSON.parse(body).item }));
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html", "x-commit": "3f2c9e1ab" });
    res.end(SHOP);
  });
  other = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Elsewhere</title><script>console.error("not yours"); fetch("/api/x", { method: "POST", body: "a" });</script>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  other.close();
});

const opts = { skip: findBrowser() ? false : "no Chrome, Edge, Chromium or Brave here" };

test("the dx browser records a recorded site over the pipe, and nothing from other sites", opts, async () => {
  const recordedHost = new URL(base).host;
  const sites: SiteConfig[] = [{ host: recordedHost, env: "staging", label: "Shop staging" }];
  const events: ActivityInput[] = [];
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-browser-profile-"));
  const browser = await launchDxBrowser({
    headless: true,
    profileDir,
    url: `${base}/`,
    // Only the recorded host: the other local server stands in for a site that isn't recorded.
    targetFor: (u) => (new URL(u).host === recordedHost ? siteTarget(u, sites) : undefined),
    onEvent: (e) => events.push(e),
  });
  try {
    const until = async (check: () => boolean, ms = 15_000) => {
      const end = Date.now() + ms;
      while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    };
    await until(() => events.some((e) => e.type === "request") && events.some((e) => e.type === "console") && events.some((e) => e.type === "action"));
    const req = events.find((e) => e.type === "request" && e.url === "/api/cart");
    assert.ok(req, `the API call is recorded: ${JSON.stringify(events.map((e) => e.text))}`);
    assert.equal(req.status, 500);
    assert.equal(req.requestBody, JSON.stringify({ item: 3, password: "•••" }));
    assert.equal(req.responseBody, JSON.stringify({ error: "out of stock", got: 3 }));
    assert.equal(req.env, "staging");
    assert.equal(req.from, "dx-browser");
    const err = events.find((e) => e.type === "console" && e.level === "error");
    assert.equal(err?.text, "Cart failed out of stock");
    assert.equal(events.find((e) => e.type === "action")?.text, "Clicked button “Add to cart”");
    const page = events.find((e) => e.type === "page");
    assert.equal(page?.deploy?.commit, "3f2c9e1ab");

    const before = events.length;
    await browser.open(`${otherBase}/`);
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(events.length, before, `nothing from a site that isn't recorded: ${JSON.stringify(events.slice(before).map((e) => e.text))}`);
    assert.ok(browser.pages() >= 2);
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
