import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// A project's sites: added by address, checked, and their API calls answered by the project's mocks, rules
// and Chaos mode through the dx browser (here the decision itself, with the calls the browser would hold).
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-sites-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-sites-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0 }));

function project(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name }));
  const run = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "octocat@example.com");
  run("config", "user.name", "octocat");
  return dir;
}
const shop = project("shop-website");
const todo = project("todo-app");

const { startDashboard } = await import("../server.js");
const { decideSite } = await import("../siteintercept.js");
const { forgetRules } = await import("../apilab.js");
const { forgetMocks } = await import("../mocks.js");
const decide = (req: PausedRequest, sites: import("@dx/core").SiteConfig[]) => {
  forgetMocks();
  forgetRules();
  return decideSite(req, sites);
};
const core = await import("@dx/core");
type PausedRequest = import("@dx/core").PausedRequest;

let dashboard: Awaited<ReturnType<typeof startDashboard>>;
const servers: http.Server[] = [];
before(async () => {
  dashboard = await startDashboard({ port: 0 });
});
after(async () => {
  await dashboard.close();
  for (const s of servers) s.close();
});

async function call(method: "GET" | "POST", p: string, body?: unknown) {
  const res = await fetch(new URL(p, dashboard.url), { method, headers: { "X-DX-Token": dashboard.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
}

const STAGING = "https://staging.shop-website.dev";

test("a site is added to a project by its address, listed with its environment, and removed", async () => {
  const bad = await call("POST", "/api/project/sites/add", { dir: shop, url: "http://localhost:3000" });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /on this computer/);
  const credentials = await call("POST", "/api/project/sites/add", { dir: shop, url: "https://user:pw@staging.shop-website.dev" });
  assert.equal(credentials.status, 400);
  assert.equal((await call("POST", "/api/project/sites/add", { dir: path.join(root, "nope"), url: STAGING })).status, 404);

  const added = await call("POST", "/api/project/sites/add", { dir: shop, url: `${STAGING}/?token=abc`, env: "staging", label: "Staging", apply: true });
  assert.equal(added.status, 200);
  assert.deepEqual(added.json, { host: "staging.shop-website.dev", url: STAGING, env: "staging", label: "Staging", apply: true });
  const list = await call("GET", `/api/project/sites?dir=${encodeURIComponent(shop)}`);
  assert.deepEqual(list.json.sites.map((s: { host: string }) => s.host), ["staging.shop-website.dev"]);
  assert.deepEqual((await call("GET", `/api/project/sites?dir=${encodeURIComponent(todo)}`)).json.sites, []);

  // A host belongs to one project: the other can't take it.
  const clash = await call("POST", "/api/project/sites/add", { dir: todo, url: STAGING });
  assert.equal(clash.status, 400);
  assert.match(clash.json.error, /already a site of another project/);

  assert.equal((await call("POST", "/api/project/sites/remove", { dir: todo, host: "staging.shop-website.dev" })).status, 404, "another project's site isn't removed");
  assert.equal((await call("POST", "/api/project/sites/remove", { dir: shop, host: "staging.shop-website.dev" })).status, 200);
  assert.deepEqual((await call("GET", `/api/project/sites?dir=${encodeURIComponent(shop)}`)).json.sites, []);
});

test("a check goes only to a site of the project, and a path stays on it", async () => {
  await call("POST", "/api/project/sites/add", { dir: shop, url: STAGING, env: "staging" });
  const noSite = await call("POST", "/api/project/sites/check", { dir: shop, host: "example.com", what: "status" });
  assert.equal(noSite.status, 404);
  assert.match(noSite.json.error, /isn't one of this project's/);
  const wrongProject = await call("POST", "/api/project/sites/check", { dir: todo, host: "staging.shop-website.dev", what: "status" });
  assert.equal(wrongProject.status, 404);
  assert.equal((await call("POST", "/api/project/sites/check", { dir: shop, host: "staging.shop-website.dev", what: "nothing" })).status, 400);
  for (const path of ["//evil.example/x", "https://evil.example/", "/a\\b", "pricing", `/${"x".repeat(250)}`]) {
    const r = await call("POST", "/api/project/sites/check", { dir: shop, host: "staging.shop-website.dev", what: "status", path });
    assert.equal(r.status, 400, path);
  }
  await call("POST", "/api/project/sites/remove", { dir: shop, host: "staging.shop-website.dev" });
});

// ------------------------------------------------------------------ the decision for a held call

const call$ = (over: Partial<PausedRequest> & { url: string }): PausedRequest => ({
  method: "GET",
  headers: { accept: "application/json" },
  type: "Fetch",
  pageUrl: `${STAGING}/cart`,
  target: { dir: shop, project: "shop-website", site: "staging.shop-website.dev", env: "staging" },
  ...over,
});
const own = (): import("@dx/core").SiteConfig[] => [{ host: "staging.shop-website.dev", project: shop, env: "staging" }];

function mockEvent(id: number, method: string, url: string, status: number, body: object) {
  return { id, at: new Date(1_790_000_000_000 + id).toISOString(), dir: shop, project: "shop-website", type: "request", text: "", method, url, status, responseHeaders: { "content-type": "application/json" }, responseBody: JSON.stringify(body), from: "dx-browser" } as never;
}

test("nothing is decided for a third party's call, a project without data, or a site that isn't any project's", () => {
  assert.equal(decide(call$({ url: "https://api.stripe.example/v1/charges" }), own()), undefined);
  assert.equal(decide(call$({ url: `${STAGING}/api/cart` }), own()), undefined, "nothing set up: the call goes on");
  assert.equal(decide(call$({ url: `${STAGING}/api/cart`, target: { dir: "site:staging.shop-website.dev", project: "staging.shop-website.dev", site: "staging.shop-website.dev", env: "staging" } }), own()), undefined);
  assert.equal(decide(call$({ url: `${STAGING}/api/cart` }), []), undefined, "a host that isn't one of the project's sites");
});

test("mocks answer a site's calls, made from the calls the dx browser recorded", () => {
  // The browser's recorded calls (from "dx-browser") are mock material like the proxy's.
  const made = core.addMocks(shop, "shop-website", [mockEvent(1, "GET", "/api/cart", 200, { items: [1, 2], source: "site" }), mockEvent(2, "POST", "/api/orders", 201, { id: 9 })]);
  assert.equal(made.added, 2);
  assert.equal(decide(call$({ url: `${STAGING}/api/cart` }), own()), undefined, "mock mode is off: calls go on");
  core.setMockMode(shop, "shop-website", { on: true });

  const cart = decide(call$({ url: `${STAGING}/api/cart?page=1` }), own());
  assert.equal(cart?.kind, "fulfill");
  assert.equal(cart?.kind === "fulfill" && cart.status, 200);
  assert.equal(cart?.kind === "fulfill" && cart.headers?.["x-dx-mock"], "1");
  assert.deepEqual(cart?.kind === "fulfill" && JSON.parse(cart.body ?? ""), { items: [1, 2], source: "site" });
  assert.deepEqual(cart?.tags, { mocked: true });

  const order = decide(call$({ url: `${STAGING}/api/orders`, method: "POST", headers: { "content-type": "application/json", origin: "https://app.shop-website.dev" } }), own());
  assert.equal(order?.kind === "fulfill" && order.status, 201);
  assert.equal(order?.kind === "fulfill" && order.headers?.["access-control-allow-origin"], "https://app.shop-website.dev", "a call from another origin of the site is allowed back");

  // Not in the mocks: goes on, unless strict.
  assert.equal(decide(call$({ url: `${STAGING}/api/unknown` }), own()), undefined);
  core.setMockMode(shop, "shop-website", { strict: true });
  const strict = decide(call$({ url: `${STAGING}/api/unknown` }), own());
  assert.equal(strict?.kind === "fulfill" && strict.status, 404);
  assert.match(strict?.kind === "fulfill" ? (strict.body ?? "") : "", /strict/);
  assert.equal(decide(call$({ url: `${STAGING}/assets/logo.png`, headers: { accept: "image/png" } }), own()), undefined, "strict mode doesn't answer what isn't an API call");
  core.setMockMode(shop, "shop-website", { strict: false });
});

test("an offline mock closes the connection, and a delay is kept", () => {
  const set = core.loadMocks(shop, "shop-website");
  const ep = set.endpoints.find((e) => e.path === "/api/cart")!;
  core.updateMock(shop, ep.id, { offline: true });
  forgetMocks();
  assert.equal(decide(call$({ url: `${STAGING}/api/cart` }), own())?.kind, "fail");
  core.updateMock(shop, ep.id, { offline: false, delayMs: 1500 });
  forgetMocks();
  const slow = decide(call$({ url: `${STAGING}/api/cart` }), own());
  assert.equal(slow?.kind === "fulfill" && slow.delayMs, 1500);
  core.setMockMode(shop, "shop-website", { on: false });
});

test("a rule fails, slows or changes the headers of a site's call, and says which rule", () => {
  core.putRule(shop, "shop-website", { id: "r1", name: "Search down", on: true, method: "GET", path: "/api/search", fail: "500" });
  core.putRule(shop, "shop-website", { id: "r2", name: "Slow cart", on: true, method: "GET", path: "/api/cart", delayMs: 800 });
  core.putRule(shop, "shop-website", { id: "r3", name: "Debug header", on: true, method: "*", path: "/api/flags", request: { setHeaders: { "x-debug": "1" }, removeHeaders: ["x-secret"] } });
  core.putRule(shop, "shop-website", { id: "r4", name: "Hang", on: true, method: "GET", path: "/api/slowpoke", fail: "timeout" });
  core.putRule(shop, "shop-website", { id: "r5", name: "Drop", on: true, method: "GET", path: "/api/dropped", fail: "drop" });
  forgetRules();

  const down = decide(call$({ url: `${STAGING}/api/search?q=a` }), own());
  assert.equal(down?.kind === "fulfill" && down.status, 500);
  assert.deepEqual(down?.tags, { rules: ["Search down"] });

  const slow = decide(call$({ url: `${STAGING}/api/cart` }), own());
  assert.equal(slow?.kind, "continue");
  assert.equal(slow?.delayMs, 800);
  assert.deepEqual(slow?.tags, { rules: ["Slow cart"] });

  const flags = decide(call$({ url: `${STAGING}/api/flags`, headers: { accept: "application/json", "x-secret": "s" } }), own());
  assert.equal(flags?.kind, "continue");
  assert.deepEqual(flags?.kind === "continue" && flags.headers, { accept: "application/json", "x-debug": "1" });

  const hang = decide(call$({ url: `${STAGING}/api/slowpoke` }), own());
  assert.deepEqual([hang?.kind, hang?.kind === "fail" && hang.reason], ["fail", "TimedOut"]);
  const drop = decide(call$({ url: `${STAGING}/api/dropped` }), own());
  assert.deepEqual([drop?.kind, drop?.kind === "fail" && drop.reason], ["fail", "ConnectionReset"]);
  // Page loads (an HTML GET) are never touched by a rule.
  assert.equal(decide(call$({ url: `${STAGING}/api/search`, headers: { accept: "text/html" } }), own()), undefined);
});

test("chaos mode breaks a site's calls the way it breaks a local app's, and is counted once", () => {
  for (const r of core.loadRules(shop).rules) core.removeRule(shop, r.id);
  forgetRules();
  core.setChaos(shop, "shop-website", { on: true, level: "blackfriday", seed: 7, faults: ["flaky"] });
  const seen = new Set<string>();
  let broken = 0;
  for (let i = 0; i < 60; i++) {
    const a = decide(call$({ url: `${STAGING}/api/cart` }), own());
    if (a?.kind === "fulfill") {
      broken++;
      assert.equal(a.status, 500);
      assert.equal(a.headers?.["x-dx-chaos"], "flaky");
      assert.ok(a.tags?.rules?.[0]?.startsWith("chaos: "), JSON.stringify(a.tags));
      seen.add(String(a.tags?.rules));
    }
  }
  assert.ok(broken > 0 && broken < 60, `some calls break, not all (${broken})`);
  // A third party's call and a page load aren't counted or broken.
  assert.equal(decide(call$({ url: "https://api.stripe.example/v1" }), own()), undefined);
  assert.equal(decide(call$({ url: `${STAGING}/pricing`, headers: { accept: "text/html" } }), own()), undefined);
  core.setChaos(shop, "shop-website", { on: false });
});

test("a site's call is answered by the mock first: a mocked call isn't broken by chaos", () => {
  core.setMockMode(shop, "shop-website", { on: true });
  core.setChaos(shop, "shop-website", { on: true, level: "blackfriday", seed: 3, faults: ["flaky"] });
  for (let i = 0; i < 30; i++) {
    const a = decide(call$({ url: `${STAGING}/api/cart` }), own());
    assert.equal(a?.kind === "fulfill" && a.status, 200);
    assert.deepEqual(a?.tags, { mocked: true });
  }
  core.setChaos(shop, "shop-website", { on: false });
  core.setMockMode(shop, "shop-website", { on: false });
});

test("Mock this app on a project with a site and no calls yet points at the site", async () => {
  await call("POST", "/api/project/sites/add", { dir: todo, url: "https://todo-app.example.com", env: "production" });
  const r = await call("POST", "/api/mocks/quick", { dir: todo });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.state, r.json.reason, r.json.openSite], ["waiting", "no-calls", "https://todo-app.example.com"]);
});

// A real server for the status check through the route (loopback sites can't be added, so this checks the refusal).
test("a site on this computer can't be added, so a check can never be aimed at one", async () => {
  const port = await new Promise<number>((resolve) => {
    const s = http.createServer((_, res) => res.end("hi")).listen(0, "127.0.0.1", () => {
      servers.push(s);
      resolve((s.address() as AddressInfo).port);
    });
  });
  const r = await call("POST", "/api/project/sites/add", { dir: shop, url: `http://127.0.0.1:${port}` });
  assert.equal(r.status, 400);
});

test("mocks, rules and chaos are off for production until you turn them on for that site", async () => {
  const added = await call("POST", "/api/project/sites/add", { dir: shop, url: "https://www.shop-website.dev", env: "production" });
  assert.equal(added.json.apply, false, "production starts off");
  const staging = await call("POST", "/api/project/sites/add", { dir: shop, url: STAGING, env: "staging" });
  assert.equal(staging.json.apply, true, "every other environment starts on");
  const PROD = "https://www.shop-website.dev";
  const prodCall = call$({ url: `${PROD}/api/cart`, target: { dir: shop, project: "shop-website", site: "www.shop-website.dev", env: "production" } });
  core.setMockMode(shop, "shop-website", { on: true });
  const sites = (apply?: boolean): import("@dx/core").SiteConfig[] => [{ host: "www.shop-website.dev", project: shop, env: "production", ...(apply === undefined ? {} : { apply }) }];
  assert.equal(decide(prodCall, sites()), undefined, "a production call goes on untouched");
  assert.equal(decide(prodCall, sites(true))?.kind, "fulfill", "turned on, it's answered");
  assert.equal(decide(prodCall, sites(false)), undefined);

  assert.equal((await call("POST", "/api/project/sites/update", { dir: shop, host: "www.shop-website.dev", apply: "yes" })).status, 400);
  assert.equal((await call("POST", "/api/project/sites/update", { dir: todo, host: "www.shop-website.dev", apply: true })).status, 404, "another project's site");
  const on = await call("POST", "/api/project/sites/update", { dir: shop, host: "www.shop-website.dev", apply: true });
  assert.equal(on.json.apply, true);
  const off = await call("POST", "/api/project/sites/update", { dir: shop, host: "staging.shop-website.dev", apply: false });
  assert.equal(off.json.apply, false);
  // Adding a site again keeps what you chose.
  const again = await call("POST", "/api/project/sites/add", { dir: shop, url: STAGING, env: "staging" });
  assert.equal(again.json.apply, false);
  const list = await call("GET", `/api/project/sites?dir=${encodeURIComponent(shop)}`);
  assert.deepEqual(Object.fromEntries(list.json.sites.map((s: { host: string; apply: boolean }) => [s.host, s.apply])), { "www.shop-website.dev": true, "staging.shop-website.dev": false });
  core.setMockMode(shop, "shop-website", { on: false });
});

test("a site's last checks come with the list, and compare with the one before", async () => {
  await call("POST", "/api/project/sites/add", { dir: shop, url: "https://history.shop-website.dev", env: "staging" });
  const { recordSiteCheck } = core;
  recordSiteCheck(shop, "history.shop-website.dev", { what: "status", ok: true, status: 200, ms: 300 });
  recordSiteCheck(shop, "history.shop-website.dev", { what: "status", ok: true, status: 200, ms: 180 });
  const list = await call("GET", `/api/project/sites?dir=${encodeURIComponent(shop)}`);
  const site = list.json.sites.find((s: { host: string }) => s.host === "history.shop-website.dev");
  assert.equal(site.last.status.latest.ms, 180);
  assert.equal(site.last.status.previous.ms, 300);
  assert.equal(site.last.page, undefined);
  const other = await call("GET", `/api/project/sites?dir=${encodeURIComponent(todo)}`);
  assert.deepEqual(other.json.sites.map((s: { host: string }) => s.host), ["todo-app.example.com"], "another project's list has its own sites and checks");
});
