import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// A project with several API specs through the dashboard: adding each, naming it and saying where
// it's served, mocks made per API that keep apart, and removing one without touching the others.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-specs-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-specs-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0 }));

const get = (example: unknown) => ({ get: { responses: { 200: { description: "ok", content: { "application/json": { example } } } } } });
const spec = (title: string, paths: Record<string, unknown>) => ({ openapi: "3.0.3", info: { title, version: "1" }, paths });
const app = path.join(root, "shop-website");
fs.mkdirSync(path.join(app, "docs"), { recursive: true });
fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "shop-website", scripts: { dev: "node server.cjs" } }));
fs.writeFileSync(path.join(app, "docs", "orders.openapi.json"), JSON.stringify(spec("Orders", { "/health": get({ from: "orders" }), "/orders": get([{ id: 1 }]) })));
fs.writeFileSync(path.join(app, "docs", "payments.openapi.json"), JSON.stringify(spec("Payments", { "/health": get({ from: "payments" }), "/charges": get([{ id: "c1" }]) })));

const { startDashboard } = await import("../server.js");
let dashboard: Awaited<ReturnType<typeof startDashboard>>;
async function call(p: string, body?: unknown) {
  const res = await fetch(new URL(p, dashboard.url), { method: body === undefined ? "GET" : "POST", headers: { "X-DX-Token": dashboard.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json()) as any };
}
const api = async (p: string, body?: unknown) => {
  const r = await call(p, body);
  assert.ok(r.status < 400, `${p}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};
const specs = () => api(`/api/lab/spec?dir=${encodeURIComponent(app)}`);

before(async () => {
  dashboard = await startDashboard({ port: 0 });
});
after(async () => {
  await dashboard.close();
});

test("a project's several APIs: each added with a name, listed with its endpoints, and the project's other spec files offered", async () => {
  const first = await specs();
  assert.equal(first.specs.length, 1, "one found by itself");
  assert.deepEqual(first.more, ["docs/payments.openapi.json"], "the other file in the project is offered, not added");
  const added = await api("/api/lab/spec", { dir: app, file: "docs/payments.openapi.json", name: "Payments" });
  assert.deepEqual([added.id, added.name, added.endpoints.length], ["payments", "Payments", 2]);
  const both = await specs();
  assert.deepEqual(both.specs.map((s: { id: string }) => s.id), ["orders", "payments"]);
  assert.deepEqual(both.more, []);
  assert.ok(both.specs.every((s: { endpoints: { api: string }[]; id: string }) => s.endpoints.every((e) => e.api === s.id)), "every endpoint knows its API");
  assert.deepEqual(both.overlaps.map((o: { method: string; path: string; apis: string[] }) => [o.method, o.path, o.apis]), [["GET", "/health", ["Orders", "Payments"]]], "the same endpoint in both is named");
  assert.equal((await call("/api/lab/spec", { dir: app, file: "docs/orders.openapi.json", mount: "orders" })).status, 400, "where it's served starts with /");
});

test("saying where an API is served moves its endpoints, and ends the overlap", async () => {
  const r = await api("/api/lab/spec/update", { dir: app, id: "payments", mount: "/payments", service: "" });
  assert.deepEqual(r.endpoints.map((e: { path: string }) => e.path), ["/payments/health", "/payments/charges"]);
  assert.deepEqual((await specs()).overlaps, []);
  assert.equal((await call("/api/lab/spec/update", { dir: app, id: "nope", name: "x" })).status, 404);
});

test("mocks are made per API and keep apart; purging one API leaves the other", async () => {
  const one = await api("/api/lab/spec/mocks", { dir: app, api: "orders" });
  assert.equal(one.apis, 1);
  const some = (await api(`/api/mocks?dir=${encodeURIComponent(app)}`)).endpoints;
  assert.ok(some.length && some.every((m: { api: string }) => m.api === "orders"), "only Orders' so far");
  const all = await api("/api/lab/spec/mocks", { dir: app });
  assert.equal(all.apis, 2);
  const mocks = (await api(`/api/mocks?dir=${encodeURIComponent(app)}`)).endpoints as { api: string; apiName: string; path: string }[];
  assert.deepEqual([...new Set(mocks.map((m) => m.apiName))].sort(), ["Orders", "Payments"]);
  assert.deepEqual(mocks.filter((m) => m.path.endsWith("/health")).map((m) => [m.api, m.path]).sort(), [["orders", "/health"], ["payments", "/payments/health"]]);
  // Made again, the same count: nothing doubles.
  await api("/api/lab/spec/mocks", { dir: app });
  assert.equal(((await api(`/api/mocks?dir=${encodeURIComponent(app)}`)).endpoints as unknown[]).length, mocks.length);
  const purged = await api("/api/mocks/purge", { dir: app, api: "payments" });
  assert.ok(purged.removed > 0);
  assert.ok(((await api(`/api/mocks?dir=${encodeURIComponent(app)}`)).endpoints as { api: string }[]).every((m) => m.api === "orders"));
});

test("removing an API leaves the others; removing the last is remembered, and giving one again ends that", async () => {
  await api("/api/lab/spec/forget", { dir: app, id: "payments" });
  assert.deepEqual((await specs()).specs.map((s: { id: string }) => s.id), ["orders"]);
  assert.equal((await call("/api/lab/spec/forget", { dir: app, id: "payments" })).status, 404, "already gone");
  await api("/api/lab/spec/forget", { dir: app });
  const none = await specs();
  assert.deepEqual([none.specs, none.removed], [[], true]);
  await api("/api/lab/spec", { dir: app, file: "docs/orders.openapi.json" });
  const back = await specs();
  assert.deepEqual([back.specs.length, back.removed], [1, false]);
});
