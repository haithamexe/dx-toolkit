import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-siteintercept-test-"));
const { CdpRecorder } = await import("../tools/dxbrowser.js");
const { siteTarget, normalizeSiteUrl, addSite, projectSites } = await import("../tools/sites.js");
type ActivityInput = import("../tools/activity.js").ActivityInput;
type SiteConfig = import("../tools/sites.js").SiteConfig;
type SiteAction = import("../tools/dxbrowser.js").SiteAction;
type PausedRequest = import("../tools/dxbrowser.js").PausedRequest;

const PAGE = "https://staging.shop-website.dev/cart";
const SITES: SiteConfig[] = [{ host: "staging.shop-website.dev", project: "/path/to/shop-website", env: "staging" }];

function harness(intercept?: (r: PausedRequest) => SiteAction | undefined | Promise<SiteAction | undefined>) {
  const events: ActivityInput[] = [];
  const sent: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  const r = new CdpRecorder({
    targetFor: (u) => siteTarget(u, SITES),
    onEvent: (e) => events.push(e),
    intercept,
    send: (async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      sent.push({ method, params, sessionId });
      if (method === "Network.getResponseBody") return { body: "{}", base64Encoded: false };
      return {};
    }) as never,
    settleMs: 20,
  });
  return { r, events, sent };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function openPage(r: InstanceType<typeof CdpRecorder>) {
  r.handle("Target.attachedToTarget", { sessionId: "S1", targetInfo: { targetId: "T1", type: "page", url: "about:blank" }, waitingForDebugger: true });
  await tick();
  r.handle("Network.requestWillBeSent", { requestId: "doc", loaderId: "L1", frameId: "T1", type: "Document", timestamp: 100, wallTime: 1_790_000_000, request: { url: PAGE, method: "GET", headers: {} } }, "S1");
  r.handle("Page.frameNavigated", { frame: { id: "T1", url: PAGE, loaderId: "L1" } }, "S1");
  r.handle("Network.loadingFinished", { requestId: "doc", timestamp: 100.04 }, "S1");
  await tick();
}

function pause(r: InstanceType<typeof CdpRecorder>, extra: Record<string, unknown> = {}, request: Record<string, unknown> = {}) {
  r.handle(
    "Fetch.requestPaused",
    { requestId: "F1", networkId: "N1", frameId: "T1", resourceType: "Fetch", request: { url: "https://staging.shop-website.dev/api/cart", method: "get", headers: { Accept: "application/json", Origin: "https://staging.shop-website.dev" }, ...request }, ...extra },
    "S1",
  );
}

const fetchCalls = (sent: { method: string }[]) => sent.filter((s) => s.method.startsWith("Fetch."));

test("only fetch and XHR calls are held: the page's network gets Fetch enabled for those two types and nothing else", async () => {
  const { r, sent } = harness(() => undefined);
  await openPage(r);
  const enable = sent.find((s) => s.method === "Fetch.enable");
  assert.deepEqual(enable?.params.patterns, [
    { urlPattern: "*", resourceType: "XHR" },
    { urlPattern: "*", resourceType: "Fetch" },
  ]);
  const none = harness();
  await openPage(none.r);
  assert.equal(none.sent.some((s) => s.method === "Fetch.enable"), false, "without a decider, nothing is ever held");
});

test("a call dx has no answer for goes on, and so does one when the decider throws or is too slow", async () => {
  const { r, sent } = harness(() => undefined);
  await openPage(r);
  pause(r);
  await tick();
  assert.deepEqual(fetchCalls(sent).filter((s) => s.method !== "Fetch.enable").map((s) => s.method), ["Fetch.continueRequest"]);

  const boom = harness(() => {
    throw new Error("nope");
  });
  await openPage(boom.r);
  pause(boom.r);
  await tick();
  assert.ok(boom.sent.some((s) => s.method === "Fetch.continueRequest"), "an error lets it go");
});

test("a resource type that isn't fetch or XHR, or a page that isn't recorded, is never asked about", async () => {
  let asked = 0;
  const { r, sent } = harness(() => {
    asked++;
    return { kind: "fail" };
  });
  await openPage(r);
  pause(r, { resourceType: "Script" });
  await tick();
  assert.equal(asked, 0);
  assert.ok(sent.some((s) => s.method === "Fetch.continueRequest"));
});

test("the decider sees the call: method upper-cased, headers lower-cased, the page and its site", async () => {
  let seen: PausedRequest | undefined;
  const { r } = harness((req) => {
    seen = req;
    return undefined;
  });
  await openPage(r);
  pause(r, {}, { postData: '{"item":3}' });
  await tick();
  assert.equal(seen?.method, "GET");
  assert.equal(seen?.headers.accept, "application/json");
  assert.equal(seen?.postData, '{"item":3}');
  assert.equal(seen?.type, "Fetch");
  assert.equal(seen?.pageUrl, PAGE);
  assert.equal(seen?.target.env, "staging");
});

test("a fulfilled call is answered by dx and recorded as mocked, with its status", async () => {
  const { r, sent, events } = harness(() => ({ kind: "fulfill", status: 201, headers: { "content-type": "application/json" }, body: '{"ok":true}', tags: { mocked: true } }));
  await openPage(r);
  r.handle("Network.requestWillBeSent", { requestId: "N1", frameId: "T1", type: "Fetch", timestamp: 101, wallTime: 1_790_000_001, request: { url: "https://staging.shop-website.dev/api/cart", method: "GET", headers: {} } }, "S1");
  pause(r);
  await tick();
  const f = sent.find((s) => s.method === "Fetch.fulfillRequest")!;
  assert.equal(f.params.responseCode, 201);
  assert.deepEqual(f.params.responseHeaders, [{ name: "content-type", value: "application/json" }]);
  assert.equal(Buffer.from(String(f.params.body), "base64").toString("utf8"), '{"ok":true}');
  r.handle("Network.responseReceived", { requestId: "N1", type: "Fetch", response: { status: 201, headers: { "content-type": "application/json", "x-dx-mock": "1" }, mimeType: "application/json" } }, "S1");
  r.handle("Network.loadingFinished", { requestId: "N1", timestamp: 101.1 }, "S1");
  await tick();
  await tick();
  const req = events.find((e) => e.type === "request")!;
  assert.equal(req.mocked, true);
  assert.ok(req.text.endsWith("(mocked)"), req.text);
  assert.equal(req.status, 201);
});

test("a failed call, a delayed one and one with edited headers", async () => {
  const fail = harness(() => ({ kind: "fail", reason: "ConnectionReset", tags: { rules: ["chaos: dropped"] } }));
  await openPage(fail.r);
  pause(fail.r);
  await tick();
  assert.equal(fail.sent.find((s) => s.method === "Fetch.failRequest")?.params.errorReason, "ConnectionReset");

  const slow = harness(() => ({ kind: "continue", delayMs: 60 }));
  await openPage(slow.r);
  pause(slow.r);
  await tick(10);
  assert.equal(slow.sent.some((s) => s.method === "Fetch.continueRequest"), false, "held for the delay");
  await tick(100);
  assert.equal(slow.sent.some((s) => s.method === "Fetch.continueRequest"), true);

  const edit = harness(() => ({ kind: "continue", headers: { accept: "application/json", "x-test": "1" } }));
  await openPage(edit.r);
  pause(edit.r);
  await tick();
  assert.deepEqual(edit.sent.find((s) => s.method === "Fetch.continueRequest")?.params.headers, [
    { name: "accept", value: "application/json" },
    { name: "x-test", value: "1" },
  ]);
});

test("the tags a decision carried reach the recorded event, as rules", async () => {
  const { r, events } = harness(() => ({ kind: "continue", tags: { rules: ["Slow search", "chaos: slow 2.0 s"] } }));
  await openPage(r);
  r.handle("Network.requestWillBeSent", { requestId: "N1", frameId: "T1", type: "Fetch", timestamp: 101, wallTime: 1_790_000_001, request: { url: "https://staging.shop-website.dev/api/search", method: "GET", headers: {} } }, "S1");
  pause(r, {}, { url: "https://staging.shop-website.dev/api/search" });
  await tick();
  r.handle("Network.responseReceived", { requestId: "N1", type: "Fetch", response: { status: 200, headers: { "content-type": "application/json" }, mimeType: "application/json" } }, "S1");
  r.handle("Network.loadingFinished", { requestId: "N1", timestamp: 103 }, "S1");
  await tick();
  await tick();
  assert.deepEqual(events.find((e) => e.type === "request")?.rules, ["Slow search", "chaos: slow 2.0 s"]);
});

// ------------------------------------------------------------------ the address of a site

test("a site's address keeps its origin and path, and refuses what shouldn't be kept", () => {
  assert.deepEqual(normalizeSiteUrl("https://Staging.Shop-Website.dev/app/?token=abc#x"), { url: "https://staging.shop-website.dev/app", host: "staging.shop-website.dev" });
  assert.deepEqual(normalizeSiteUrl("shop-website.dev"), { url: "https://shop-website.dev", host: "shop-website.dev" });
  assert.throws(() => normalizeSiteUrl("ftp://shop-website.dev"), /http and https/);
  assert.throws(() => normalizeSiteUrl("https://user:pw@shop-website.dev"), /user name and password/);
  assert.throws(() => normalizeSiteUrl("http://localhost:3000"), /on this computer/);
  assert.throws(() => normalizeSiteUrl("http://127.0.0.1:5173"), /on this computer/);
  assert.throws(() => normalizeSiteUrl(""), /Which site/);
});

test("a site added with an address is listed under its project, with the address", () => {
  const site = addSite({ url: "https://staging.shop-website.dev/", project: "/path/to/todo-app", env: "staging" });
  assert.equal(site.host, "staging.shop-website.dev");
  assert.equal(site.url, "https://staging.shop-website.dev");
  assert.deepEqual(projectSites("/path/to/todo-app").map((s) => s.host), ["staging.shop-website.dev"]);
  assert.deepEqual(projectSites("/path/to/other"), []);
});
