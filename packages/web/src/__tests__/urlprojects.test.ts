import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// A website as a project: an address with no folder. What works on an address works; what needs code says so.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-urlproj-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-urlproj-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0 }));
const folder = path.join(root, "todo-app");
fs.mkdirSync(folder);
fs.writeFileSync(path.join(folder, "package.json"), JSON.stringify({ name: "todo-app" }));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: folder, stdio: "ignore" });

const { startDashboard } = await import("../server.js");
const core = await import("@dx/core");
const { checkPage, findBrowser } = core;
const { decideSite } = await import("../siteintercept.js");
let dashboard: Awaited<ReturnType<typeof startDashboard>>;
before(async () => {
  dashboard = await startDashboard({ port: 0 });
});
after(async () => {
  await dashboard.close();
});

async function call(method: "GET" | "POST", p: string, body?: unknown) {
  const res = await fetch(new URL(p, dashboard.url), { method, headers: { "X-DX-Token": dashboard.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
}
const DIR = "site:staging.shop-website.dev";

test("a website is added as a project by its address, listed with the folders, and refused when it can't be one", async () => {
  assert.equal((await call("POST", "/api/projects/url/add", { url: "http://localhost:3000" })).status, 400, "an address on this computer is a project to run from dx");
  assert.equal((await call("POST", "/api/projects/url/add", { url: "https://user:pw@shop-website.dev" })).status, 400);
  assert.equal((await call("POST", "/api/projects/url/add", { url: "" })).status, 400);
  assert.equal((await call("POST", "/api/projects/url/add", { url: "https://staging.shop-website.dev", name: "todo-app" })).status, 409, "a name a folder project has");

  const added = await call("POST", "/api/projects/url/add", { url: "https://staging.shop-website.dev/?token=abc", env: "staging" });
  assert.equal(added.status, 200);
  assert.deepEqual(added.json, { name: "staging.shop-website.dev", dir: DIR, url: "https://staging.shop-website.dev", kind: "website", website: true });
  assert.equal((await call("POST", "/api/projects/url/add", { url: "https://staging.shop-website.dev" })).status, 409, "twice");

  const list = (await call("GET", "/api/projects")).json as { name: string; dir: string; kind: string; website?: boolean; env?: string; sites?: number }[];
  assert.ok(list.some((p) => p.name === "todo-app" && !p.website), "the folders are still there");
  const site = list.find((p) => p.website);
  assert.deepEqual([site?.dir, site?.kind, site?.env, site?.sites], [DIR, "website", "staging", 1]);
  // Its address is a site of the project, so the checks, the recording and the interception find it.
  assert.deepEqual(core.projectSites(DIR).map((s) => s.host), ["staging.shop-website.dev"]);
});

test("what works on an address works on a website project", async () => {
  const sites = await call("GET", `/api/project/sites?dir=${encodeURIComponent(DIR)}`);
  assert.equal(sites.status, 200);
  assert.equal(sites.json.sites[0].host, "staging.shop-website.dev");
  assert.equal(sites.json.sites[0].apply, true);
  // The spec, the rules, the mocks and Chaos mode take it.
  assert.equal((await call("GET", `/api/lab/spec?dir=${encodeURIComponent(DIR)}`)).status, 200);
  assert.equal((await call("GET", `/api/lab/rules?dir=${encodeURIComponent(DIR)}`)).status, 200);
  const mocks = await call("GET", `/api/mocks?dir=${encodeURIComponent(DIR)}`);
  assert.equal(mocks.status, 200, JSON.stringify(mocks.json));
  assert.equal((await call("GET", `/api/chaos?dir=${encodeURIComponent(DIR)}`)).status, 200);
  const chaos = await call("POST", "/api/chaos", { dir: DIR, on: true, level: "wifi", seed: 3 });
  assert.equal(chaos.status, 200, JSON.stringify(chaos.json));
  assert.equal(chaos.json.on, true);
  await call("POST", "/api/chaos", { dir: DIR, on: false });
  // Activity under its key, with no project check at all.
  assert.equal((await call("GET", `/api/activity?dir=${encodeURIComponent(DIR)}`)).status, 200);
  // "Mock this app" with no calls yet points at the site.
  const quick = await call("POST", "/api/mocks/quick", { dir: DIR });
  assert.deepEqual([quick.json.state, quick.json.reason, quick.json.openSite], ["waiting", "no-calls", "https://staging.shop-website.dev"]);
});

test("what needs the code refuses a website project, and says why", async () => {
  const q = encodeURIComponent(DIR);
  const refused = [
    await call("GET", `/api/git/graph?dir=${q}`),
    await call("GET", `/api/search?dir=${q}&q=cart`),
    await call("POST", "/api/dev/start", { dir: DIR }),
    await call("GET", `/api/env/project?dir=${q}`),
    await call("POST", "/api/open-file", { dir: DIR, file: "a.ts" }),
    await call("GET", `/api/lab/history?dir=${q}`),
  ];
  for (const r of refused) {
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.match(r.json.error, /is a website, so this needs its code on this computer/);
  }
  assert.equal((await call("GET", `/api/git/graph?dir=${encodeURIComponent("site:unknown.example.com")}`)).status, 404, "an unknown website is just not a project");
});

test("the project's mocks, rules and Chaos answer its site's calls, as for any site", async () => {
  core.putRule(DIR, "staging.shop-website.dev", { id: "r1", name: "Cart down", on: true, method: "GET", path: "/api/cart", fail: "500" });
  const { forgetRules } = await import("../apilab.js");
  forgetRules();
  const action = decideSite(
    { url: "https://staging.shop-website.dev/api/cart", method: "GET", headers: { accept: "application/json" }, type: "Fetch", pageUrl: "https://staging.shop-website.dev/", target: { dir: DIR, project: "staging.shop-website.dev", site: "staging.shop-website.dev", env: "staging" } },
    core.listSites(),
  );
  assert.equal(action?.kind === "fulfill" && action.status, 500);
  assert.deepEqual(action?.tags, { rules: ["Cart down"] });
  // A site that belongs to no project still has nothing decided.
  assert.equal(decideSite({ url: "https://other.example.com/api/cart", method: "GET", headers: {}, type: "Fetch", pageUrl: "https://other.example.com/", target: { dir: "site:other.example.com", project: "other.example.com", site: "other.example.com", env: "production" } }, core.listSites()), undefined);
  core.removeRule(DIR, core.loadRules(DIR).rules[0].id);
});

test("the pages adapt: a website's overview, the sidebar without what needs code, and a way to add a project from the picker", { skip: findBrowser() ? false : "no Chrome, Edge, Chromium or Brave here", timeout: 90_000 }, async () => {
  const r = await checkPage({ url: `${dashboard.url}#/overview?dir=${encodeURIComponent(DIR)}`, steps: [{ waitFor: ".chunk-grid" }, { waitFor: ".site-card" }], timeoutMs: 40_000 });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.deepEqual(r.exceptions, []);
  const text = r.text ?? "";
  assert.match(text, /staging\.shop-website\.dev/);
  assert.match(text, /A website: dx has no code for it here/);
  assert.match(text, /Open in dx browser/);
  assert.match(text, /Add project|Add a project/i, "the picker's way to add one");
  for (const needsCode of ["Git", "Search", "Secrets", "Data", "Tools"]) assert.ok(!new RegExp(`^${needsCode}$`, "m").test(text), `${needsCode} isn't offered for a website`);
  assert.match(text, /API/);
  assert.match(text, /Stress test/);
  assert.doesNotMatch(text, /(?<![a-z])null(?![a-z])|\bundefined\b|\[object /);
  // The pages a website keeps open without errors: the API, the stress test and the activity.
  for (const [page, wait] of [["requests", ".segmented"], ["chaos", ".segmented"], ["activity", ".activity-tools"]] as const) {
    const p = await checkPage({ url: `${dashboard.url}#/${page}?dir=${encodeURIComponent(DIR)}`, steps: [{ waitFor: wait }], settleMs: 1500, timeoutMs: 40_000 });
    assert.equal(p.error, undefined, `${page}: ${JSON.stringify(p.error)}`);
    assert.deepEqual(p.exceptions, [], page);
    assert.doesNotMatch(p.text ?? "", /is a website, so this needs its code/, `${page} asked for code`);
    assert.doesNotMatch(p.text ?? "", /(?<![a-z])null(?![a-z])|\bundefined\b|\[object /, page);
  }
  // The page that needs code sends you back to the overview.
  const git = await checkPage({ url: `${dashboard.url}#/git?dir=${encodeURIComponent(DIR)}`, steps: [{ waitFor: ".chunk-grid" }], timeoutMs: 40_000 });
  assert.equal(git.error, undefined, JSON.stringify(git.error));
});

test("a website project is removed with its sites, and its history stays", async () => {
  const gone = await call("POST", "/api/projects/url/remove", { dir: DIR });
  assert.equal(gone.status, 200);
  assert.ok(!(await call("GET", "/api/projects")).json.some((p: { website?: boolean }) => p.website));
  assert.deepEqual(core.projectSites(DIR), []);
  assert.equal((await call("POST", "/api/projects/url/remove", { dir: DIR })).status, 404);
  assert.equal((await call("POST", "/api/projects/url/remove", { dir: folder })).status, 404, "a folder project isn't removed this way");
  assert.equal((await call("GET", `/api/mocks?dir=${encodeURIComponent(DIR)}`)).status, 404, "it isn't a project any more");
});
