import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// A project with several API specs: they're kept apart (their own ids and names), an old single
// spec is read as one of them, each endpoint and mock knows its API, and the same path in two APIs
// doesn't make one overwrite the other's mocks.
process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-multispec-"));
const core = await import("../index.js");
const { saveSpec, listSpecs, projectSpecs, projectApis, updateSpec, forgetSpec, specTurnedOff, specFile, mapApis, mocksFromSpec, putMocks, loadMocks, matchMock, purgeMocks, SpecError } = core;
type Ev = import("../tools/activity.js").ActivityEvent;

const project = fs.mkdtempSync(path.join(os.tmpdir(), "shop-website-"));
const doc = (title: string, paths: Record<string, unknown>, server?: string) => ({ openapi: "3.0.3", info: { title, version: "1" }, ...(server ? { servers: [{ url: server }] } : {}), paths });
const get = (example: unknown) => ({ get: { responses: { 200: { description: "ok", content: { "application/json": { example } } } } } });

const orders = doc("Orders", { "/health": get({ from: "orders" }), "/orders": get([{ id: 1 }]) });
const payments = doc("Payments", { "/health": get({ from: "payments" }), "/charges": get([{ id: "c1" }]) });

const call = (url: string, over: Partial<Ev> = {}) => ({ id: 1, at: new Date().toISOString(), type: "request", method: "GET", url, status: 200, dir: project, project: "shop-website", text: url, ...over }) as Ev;

test("an old single spec is read as one API, named from its title; and removing it on purpose is remembered", () => {
  fs.mkdirSync(path.dirname(specFile(project)), { recursive: true });
  fs.writeFileSync(specFile(project), JSON.stringify({ format: "dx-spec", dir: project, source: "file:docs/orders.json", savedAt: "2026-11-01T00:00:00.000Z", doc: orders, found: true }));
  const [one, ...rest] = listSpecs(project);
  assert.equal(rest.length, 0);
  assert.deepEqual([one.id, one.name, one.source, one.found], ["orders", "Orders", "file:docs/orders.json", true]);
  forgetSpec(project);
  assert.deepEqual([listSpecs(project), specTurnedOff(project), projectSpecs(project)], [[], true, []], "removed on purpose: not found again");
  fs.writeFileSync(specFile(project), JSON.stringify({ format: "dx-spec-off", dir: project }));
  assert.equal(specTurnedOff(project), true, "the old marker still means removed");
});

test("several APIs: each has an id and a name, giving one again replaces it, giving another adds it", () => {
  saveSpec(project, "pasted", orders, { name: "Orders" });
  assert.equal(specTurnedOff(project), false, "giving one ends 'removed on purpose'");
  const pay = saveSpec(project, "pasted", payments, { name: "Payments", mount: "/payments" });
  assert.deepEqual(listSpecs(project).map((s) => s.id), ["orders", "payments"]);
  // The same file again replaces its API instead of adding a second.
  saveSpec(project, "file:docs/orders.json", orders, { name: "Orders from file" });
  saveSpec(project, "file:docs/orders.json", orders);
  assert.deepEqual(listSpecs(project).map((s) => s.id), ["orders", "payments", "orders-from-file"]);
  forgetSpec(project, "orders-from-file");
  assert.throws(() => forgetSpec(project, "nope"), SpecError);
  assert.throws(() => updateSpec(project, pay.id, { mount: "payments" }), /starts with \//);
  assert.throws(() => updateSpec(project, pay.id, { service: "a b" }), /service is a name/);
  const renamed = updateSpec(project, pay.id, { name: "Payments API", service: "pay" });
  assert.deepEqual([renamed.id, renamed.name, renamed.service, renamed.mount], ["payments", "Payments API", "pay", "/payments"], "the id stays, so its mocks keep theirs");
  updateSpec(project, pay.id, { service: "" });
  assert.equal(listSpecs(project).find((s) => s.id === "payments")?.service, undefined);
});

test("each endpoint knows its API, served where the API says; the same path in two APIs is named", () => {
  const apis = projectApis(project);
  const eps = apis.flatMap((a) => a.spec.endpoints.map((e) => [e.api, e.method, e.path]));
  assert.deepEqual(eps, [["orders", "GET", "/health"], ["orders", "GET", "/orders"], ["payments", "GET", "/payments/health"], ["payments", "GET", "/payments/charges"]], "Payments is served at /payments");
  assert.deepEqual(mapApis(apis.map((a) => a.spec), []).overlaps, [], "different paths, nothing to tell apart");
  // Served at the same place, the two share GET /health.
  updateSpec(project, "payments", { mount: "/" });
  const overlap = mapApis(projectApis(project).map((a) => a.spec), []).overlaps;
  assert.deepEqual(overlap.map((o) => [o.method, o.path, o.apis]), [["GET", "/health", ["Orders", "Payments API"]]]);
  // Told apart by service, they no longer compete.
  updateSpec(project, "orders", { service: "orders" });
  updateSpec(project, "payments", { service: "pay" });
  assert.deepEqual(mapApis(projectApis(project).map((a) => a.spec), []).overlaps, []);
});

test("calls go to the API that has them; a stack's call only to the API that is its service", () => {
  const specs = projectApis(project).map((a) => a.spec);
  const map = mapApis(specs, [call("/orders"), call("/orders"), call("/charges"), call("/health", { service: "pay" }), call("/health", { service: "orders" }), call("/health", { service: "orders" }), call("/api/unknown", { status: 404 })]);
  const calls = (api: string, path: string) => map.apis.find((a) => a.api === api)!.endpoints.find((e) => e.path === path)!.calls;
  assert.deepEqual([calls("orders", "/orders"), calls("payments", "/charges"), calls("payments", "/health"), calls("orders", "/health")], [2, 1, 1, 2], "/health by the service it was called on");
  assert.deepEqual(map.undocumented.map((u) => u.path), ["/api/unknown"]);
});

test("mocks from two APIs keep apart: the same method, path and status don't overwrite each other, and each knows its API and service", () => {
  updateSpec(project, "orders", { service: "" });
  updateSpec(project, "payments", { service: "" });
  const [o, p] = projectApis(project).map((a) => a.spec);
  const made = [...mocksFromSpec(o), ...mocksFromSpec(p)];
  const health = made.filter((m) => m.path === "/health");
  assert.equal(health.length, 2, "GET /health from each API");
  assert.notEqual(health[0].id, health[1].id);
  assert.deepEqual(health.map((m) => m.api).sort(), ["orders", "payments"]);
  assert.deepEqual(health.map((m) => m.apiName).sort(), ["Orders", "Payments API"]);
  putMocks(project, "shop-website", made);
  assert.equal(loadMocks(project).endpoints.filter((m) => m.path === "/health").length, 2);

  // With a stack service each, a call answers from its own API's mock.
  updateSpec(project, "orders", { service: "orders" });
  updateSpec(project, "payments", { service: "pay" });
  const [o2, p2] = projectApis(project).map((a) => a.spec);
  const set = { ...loadMocks(project), endpoints: [...mocksFromSpec(o2), ...mocksFromSpec(p2)] };
  const body = (service: string) => JSON.parse(matchMock(set, { method: "GET", url: "/health", service })!.body);
  assert.deepEqual([body("orders"), body("pay")], [{ from: "orders" }, { from: "payments" }]);
});

test("mocks made again for one API replace only its own; ones made before APIs were told apart go with the first; purge by API", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "todo-app-"));
  saveSpec(dir, "pasted", orders, { name: "Orders" });
  saveSpec(dir, "pasted", payments, { name: "Payments" });
  const [o, p] = projectApis(dir).map((a) => a.spec);
  // A mock from before: no API, as the first version made them.
  const legacy = { ...mocksFromSpec(o).find((m) => m.path === "/orders")!, id: "specold000001" };
  delete (legacy as { api?: string }).api;
  delete (legacy as { apiName?: string }).apiName;
  putMocks(dir, "todo-app", [legacy, ...mocksFromSpec(p)]);
  assert.equal(loadMocks(dir).endpoints.length, 3);
  // Orders again (the first API): its legacy mock is replaced; Payments' mocks stay.
  putMocks(dir, "todo-app", mocksFromSpec(o), { replaceApis: ["orders"], legacy: true });
  const after = loadMocks(dir).endpoints;
  assert.deepEqual(after.map((m) => m.api).sort(), ["orders", "orders", "payments", "payments"]);
  assert.ok(!after.some((m) => m.id === "specold000001"));
  // Payments again (not the first): a legacy mock isn't its own to replace.
  putMocks(dir, "todo-app", [legacy]);
  putMocks(dir, "todo-app", mocksFromSpec(p), { replaceApis: ["payments"], legacy: false });
  assert.ok(loadMocks(dir).endpoints.some((m) => m.id === "specold000001"));
  const r = purgeMocks(dir, undefined, "payments");
  assert.equal(r.removed, 2);
  assert.ok(loadMocks(dir).endpoints.every((m) => m.api !== "payments"));
  // A source narrows it further: Orders' spec-made mocks go, its others (and the legacy one) stay.
  const before = loadMocks(dir).endpoints.length;
  const specMade = loadMocks(dir).endpoints.filter((m) => m.api === "orders" && (m.source === "spec" || m.source === undefined)).length;
  assert.equal(purgeMocks(dir, "spec", "orders").removed, specMade);
  assert.equal(loadMocks(dir).endpoints.length, before - specMade);
});
