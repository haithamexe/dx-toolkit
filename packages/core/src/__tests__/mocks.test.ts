import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-mocks-home-"));
const { addMocks, applyMockPreset, foldPath, loadMocks, matchMock, mockFile, mocksFromActivity, MockError, removeMock, setMockMode, updateMock, mockSummary, clearMocks, nextActivityId } = await import("../index.js");
type ActivityEvent = import("../index.js").ActivityEvent;

const dir = path.join(os.tmpdir(), "dx-mocks-projects", "shop-website");
let t = Date.now() - 60_000;
function call(method: string, url: string, status: number, body: string, over: Partial<ActivityEvent> = {}): ActivityEvent {
  t += 1000;
  return {
    id: nextActivityId(t),
    at: new Date(t).toISOString(),
    dir,
    project: "shop-website",
    type: "request",
    from: "proxy",
    text: `${method} ${url} → ${status}`,
    method,
    url,
    status,
    responseHeaders: { "content-type": "application/json" },
    requestHeaders: { "content-type": "application/json" },
    responseBody: body,
    ...over,
  };
}

test("ids are folded the way the APIs view folds them", () => {
  assert.equal(foldPath("/orders/42"), "/orders/:id");
  assert.equal(foldPath("/orders/42/items/3f2c9a1b-1d2e-4c3b-9a8f-0123456789ab?x=1"), "/orders/:id/items/:id");
  assert.equal(foldPath("/blobs/0123456789abcdef0123"), "/blobs/:id");
  assert.equal(foldPath("/users/me"), "/users/me");
});

test("mocks from recorded calls: the newest answer, split by query or body only where calls differed", () => {
  const events = [
    call("GET", "/api/orders/1", 200, '{"id":1}'),
    call("GET", "/api/orders/2", 200, '{"id":2}'),
    call("GET", "/api/items?page=1", 200, '{"items":[1]}'),
    call("GET", "/api/items?page=2", 200, '{"items":[2]}'),
    call("POST", "/api/cart", 201, '{"ok":"a"}', { requestBody: '{"sku":"a","password":"•••"}' }),
    call("POST", "/api/cart", 409, '{"ok":"b"}', { requestBody: '{"sku":"b"}' }),
    call("GET", "/api/mocked", 200, "{}", { mocked: true }),
    call("GET", "http://localhost:4000/api/other", 200, "{}", { from: "browser" }),
    call("GET", "/api/down", 0, "", { error: "ECONNREFUSED" }),
  ];
  const made = mocksFromActivity(events);
  const keys = made.map((m) => `${m.method} ${m.path}${m.query ?? ""}${m.bodyKey ? " +body" : ""}`).sort();
  assert.deepEqual(keys, ["GET /api/items?page=1", "GET /api/items?page=2", "GET /api/orders/:id", "POST /api/cart +body", "POST /api/cart +body"]);
  assert.equal(made.find((m) => m.path === "/api/orders/:id")!.body, '{"id":2}', "the most recent wins");
  const set = { ...loadMocks(dir), endpoints: made };
  assert.equal(matchMock(set, { method: "GET", url: "/api/orders/77" })?.body, '{"id":2}');
  assert.equal(matchMock(set, { method: "GET", url: "/api/items?page=2" })?.body, '{"items":[2]}');
  assert.ok(matchMock(set, { method: "GET", url: "/api/items?page=9" }), "an unseen query still gets the newest");
  // The live body is masked the same way before it's compared, so a real password still matches.
  assert.equal(matchMock(set, { method: "POST", url: "/api/cart", body: '{"password":"hunter2","sku":"a"}', contentType: "application/json" })?.status, 201);
  assert.equal(matchMock(set, { method: "POST", url: "/api/cart", body: '{"sku":"b"}', contentType: "application/json" })?.status, 409);
  assert.equal(matchMock(set, { method: "GET", url: "/api/unknown" }), undefined);
  assert.equal(matchMock(set, { method: "DELETE", url: "/api/orders/1" }), undefined);
  set.endpoints.forEach((e) => (e.enabled = false));
  assert.equal(matchMock(set, { method: "GET", url: "/api/orders/1" }), undefined, "an endpoint turned off isn't answered");
});

test("presets", () => {
  const [ep] = mocksFromActivity([call("GET", "/api/items", 200, '{"items":[1,2],"total":2,"name":"x"}')]);
  assert.deepEqual(JSON.parse(applyMockPreset(ep, "empty").body), { items: [], total: 0, name: "x" });
  assert.equal(applyMockPreset(ep, "fail").status, 500);
  assert.equal(applyMockPreset(ep, "slow").delayMs, 3000);
  assert.equal(applyMockPreset(ep, "offline").offline, true);
  const reset = applyMockPreset(ep, "reset");
  assert.equal(reset.status, 200);
  assert.equal(reset.delayMs, 0);
  assert.equal(reset.offline, undefined);
  assert.equal(reset.body, ep.recorded.body);
});

test("stored per project, 0600, on and off, edits checked and kept", () => {
  assert.throws(() => setMockMode(dir, "shop-website", { on: true }), MockError, "nothing to turn on");
  const r = addMocks(dir, "shop-website", [call("GET", "/api/items", 200, '{"items":[1]}'), call("GET", "/api/orders/5", 200, '{"id":5}')]);
  assert.equal(r.added, 2);
  if (process.platform !== "win32") assert.equal(fs.statSync(mockFile(dir)).mode & 0o777, 0o600);
  assert.deepEqual(mockSummary(dir), { on: false, strict: false, endpoints: 2, enabled: 2 });
  assert.equal(setMockMode(dir, "shop-website", { on: true, strict: true }).on, true);
  assert.equal(loadMocks(dir).strict, true);

  const id = loadMocks(dir).endpoints.find((e) => e.path === "/api/items")!.id;
  const bad = (patch: object, re: RegExp) => assert.throws(() => updateMock(dir, id, patch), (err: unknown) => err instanceof MockError && re.test(err.message));
  bad({ status: 99 }, /100 to 599/);
  bad({ status: "abc" }, /100 to 599/);
  bad({ contentType: "text/html\r\nSet-Cookie: x=y" }, /content type/);
  bad({ body: "{not json" }, /isn't valid JSON/);
  bad({ body: "x".repeat(1024 * 1024 + 1) }, /at most 1 MB/);
  bad({ preset: "explode" }, /Presets/);
  assert.equal(updateMock(dir, id, { delayMs: 99_999 }).delayMs, 30_000, "delays are capped");
  const edited = updateMock(dir, id, { status: 503, body: '{"items":[]}' });
  assert.equal(edited.edited, true);
  assert.equal(updateMock(dir, id, { contentType: "text/plain", body: "plain" }).body, "plain");

  // A newer recording doesn't replace what you edited, but does replace the rest.
  const again = addMocks(dir, "shop-website", [call("GET", "/api/items", 200, '{"items":[9]}'), call("GET", "/api/orders/6", 200, '{"id":6}')]);
  assert.deepEqual([again.added, again.replaced, again.kept], [0, 1, 1]);
  assert.equal(loadMocks(dir).endpoints.find((e) => e.id === id)!.body, "plain");
  assert.equal(updateMock(dir, id, { preset: "reset" }).edited, undefined);

  updateMock(dir, id, { enabled: false });
  assert.equal(mockSummary(dir)?.enabled, 1);
  removeMock(dir, id);
  assert.throws(() => removeMock(dir, id), MockError);
  clearMocks(dir);
  assert.equal(mockSummary(dir), undefined);
});
