import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// Mock mode and bug bundles against a made-up app run through the dashboard: its API answered by
// dx from what was recorded while its page still comes from the dev server, and bundles exported
// from its history and refused when they're not what a bundle is. Our own dx home and projects.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-mocks-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-mocks-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0 }));

const app = path.join(root, "todo-app");
fs.mkdirSync(app);
fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "todo-app", scripts: { dev: "node server.cjs" } }));
fs.writeFileSync(
  path.join(app, "server.cjs"),
  `const http = require("http");
   const page = '<!doctype html><html><head><title>Todo</title></head><body><h1>from the server</h1>' +
     '<button id="add">Add</button><script src="/app.js"></script></body></html>';
   const js = 'document.getElementById("add").addEventListener("click", async () => {' +
     '  const r = await fetch("/api/cart", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });' +
     '  console.error("Cart failed: " + r.status);' +
     '});';
   const json = (r, status, body) => { r.statusCode = status; r.setHeader("content-type", "application/json"); r.end(JSON.stringify(body)); };
   const s = http.createServer((q, r) => {
     if (q.url === "/app.js") { r.setHeader("content-type", "text/javascript"); return r.end(js); }
     if (q.url === "/api/items") return json(r, 200, { items: [{ id: 1 }], source: "server" });
     if (q.url.startsWith("/api/orders/")) return json(r, 200, { id: q.url.split("/").pop(), source: "server" });
     if (q.url === "/api/cart") return json(r, 500, { error: "out of stock" });
     if (q.url.startsWith("/api/")) return json(r, 404, { source: "server" });
     r.setHeader("content-type", "text/html; charset=utf-8");
     r.end(page);
   }).listen(0, "127.0.0.1", () => console.log("Local: http://localhost:" + s.address().port + "/"));`,
);
const git = (...args: string[]) => execFileSync("git", args, { cwd: app, encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
git("config", "user.email", "octocat@example.com");
git("config", "user.name", "octocat");
git("config", "commit.gpgsign", "false");
git("add", "-A");
git("commit", "-q", "-m", "Todo app");
const head = git("rev-parse", "HEAD");

const { startDashboard } = await import("../server.js");
const { findBrowser, mockFile, readActivity } = await import("@dx/core");
let dashboard: Awaited<ReturnType<typeof startDashboard>>;
const host = "todo-app.localhost";
let origin = "";

async function call(p: string, body?: unknown) {
  const res = await fetch(new URL(p, dashboard.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-DX-Token": dashboard.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as any };
}
const api = async (p: string, body?: unknown) => (await call(p, body)).data;

function viaProxy(p: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: dashboard.localDomainsPort, path: p, method: options.method ?? "GET", headers: { host: `${host}:${dashboard.localDomainsPort}`, ...options.headers } },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, ms: Date.now() - started }));
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

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

test("mock mode: the API is answered from recordings, the page still comes from the dev server", async () => {
  // Use the app, so there's something recorded.
  assert.match((await viaProxy("/api/items")).body, /"source":"server"/);
  await viaProxy("/api/orders/5");
  await api(`/api/activity?dir=${encodeURIComponent(app)}&since=1h`); // writes what's waiting

  assert.equal((await call("/api/mocks/mode", { dir: app, on: true })).status, 400, "nothing to turn on yet");
  const made = await api("/api/mocks/make", { dir: app, since: "1h" });
  assert.equal(made.added, 2, JSON.stringify((await api(`/api/mocks?dir=${encodeURIComponent(app)}`)).endpoints.map((e: { method: string; path: string }) => `${e.method} ${e.path}`)));
  if (process.platform !== "win32") assert.equal(fs.statSync(mockFile(app)).mode & 0o777, 0o600);

  const list = await api(`/api/mocks?dir=${encodeURIComponent(app)}`);
  const items = list.endpoints.find((e: { path: string }) => e.path === "/api/items");
  assert.ok(list.endpoints.some((e: { path: string }) => e.path === "/api/orders/:id"), "ids folded");
  assert.equal(items.body, undefined, "the list leaves whole bodies out");
  // Edit the answer, so it can be told from the server's.
  const edited = await api("/api/mocks/update", { dir: app, id: items.id, body: JSON.stringify({ items: [], source: "mock" }) });
  assert.equal(edited.edited, true);
  assert.equal((await call("/api/mocks/update", { dir: app, id: items.id, body: "{broken" })).status, 400);
  assert.equal((await call("/api/mocks/update", { dir: app, id: items.id, status: 42 })).status, 400);
  assert.equal((await call("/api/mocks/update", { dir: app, id: "nope", status: 200 })).status, 404);
  assert.equal((await call("/api/mocks/mode", { dir: path.join(root, "not-a-project"), on: true })).status, 404, "only known projects");

  // Off: everything still goes to the dev server.
  assert.match((await viaProxy("/api/items")).body, /"source":"server"/);
  assert.equal((await api("/api/mocks/mode", { dir: app, on: true })).on, true);
  const projects = await api("/api/projects");
  assert.deepEqual(projects.find((p: { dir: string }) => p.dir === app).mocks, { on: true, strict: false, endpoints: 2, enabled: 2 });

  const mocked = await viaProxy("/api/items");
  assert.equal(mocked.status, 200);
  assert.equal(mocked.headers["x-dx-mock"], "1");
  assert.deepEqual(JSON.parse(mocked.body), { items: [], source: "mock" });
  const order = await viaProxy("/api/orders/99");
  assert.equal(JSON.parse(order.body).id, "5", "/orders/99 is answered by the /orders/:id recording");
  const page = await viaProxy("/", { headers: { accept: "text/html" } });
  assert.match(page.body, /from the server/, "page loads still come from the dev server");
  assert.equal(page.headers["x-dx-mock"], undefined);
  const script = await viaProxy("/app.js", { headers: { accept: "*/*" } });
  assert.match(script.body, /addEventListener/, "and so do scripts");
  // Unmatched: forwarded; in strict mode, dx answers 404 itself.
  const unknown = await viaProxy("/api/unknown");
  assert.equal(unknown.status, 404);
  assert.match(unknown.body, /"source":"server"/);
  await api("/api/mocks/mode", { dir: app, strict: true });
  const strict = await viaProxy("/api/unknown");
  assert.equal(strict.status, 404);
  assert.match(strict.body, /No mock for GET \/api\/unknown/);
  assert.equal(strict.headers["x-dx-mock"], "1");
  await api("/api/mocks/mode", { dir: app, strict: false });

  // Presets: slow, fail, offline.
  await api("/api/mocks/update", { dir: app, id: items.id, delayMs: 400 });
  assert.ok((await viaProxy("/api/items")).ms >= 350, "the delay is kept");
  await api("/api/mocks/update", { dir: app, id: items.id, preset: "fail" });
  assert.equal((await viaProxy("/api/items")).status, 500);
  await api("/api/mocks/update", { dir: app, id: items.id, preset: "offline" });
  await assert.rejects(viaProxy("/api/items"), "offline closes the connection with no answer");
  await api("/api/mocks/update", { dir: app, id: items.id, preset: "reset" });
  assert.match((await viaProxy("/api/items")).body, /"source":"server"/, "reset: the recorded answer, which came from the server");
  await api("/api/mocks/update", { dir: app, id: items.id, enabled: false });
  assert.equal((await viaProxy("/api/items")).headers["x-dx-mock"], undefined, "an endpoint turned off is forwarded");

  // The history says which answers were mocked.
  await api(`/api/activity?dir=${encodeURIComponent(app)}&since=1h`);
  const history = readActivity({ dir: app, types: ["request"] });
  const mockedEvents = history.filter((e) => e.mocked);
  assert.ok(mockedEvents.some((e) => e.url === "/api/orders/99" && e.status === 200 && /\(mocked\)$/.test(e.text)), JSON.stringify(history.map((e) => e.text)));
  assert.ok(mockedEvents.some((e) => e.url === "/api/items" && e.error === "offline (a dx mock)"));
  assert.ok(!history.some((e) => e.url === "/" && e.mocked));
  // Mocks made again from that history skip the mocked answers; the server's own 404 for /api/unknown is a real answer.
  const again = await api("/api/mocks/make", { dir: app, since: "1h" });
  assert.deepEqual([again.added, again.endpoints], [1, 3]);

  assert.equal((await api("/api/mocks/mode", { dir: app, on: false })).on, false);
  assert.match((await viaProxy("/api/orders/99")).body, /"source":"server"/);
  await api("/api/mocks/remove", { dir: app, all: true });
  assert.equal(fs.existsSync(mockFile(app)), false);
});

/** A console error after a click, sent the way the page's recorder sends it. */
async function recordError(): Promise<{ id: number; visit: string }> {
  const visit = `visit-01${Date.now().toString(36)}`;
  const at = Date.now();
  const events = JSON.stringify({
    visit,
    events: [
      { type: "action", text: "Clicked button “Add”", target: "#add", at, page: `${origin}/` },
      { type: "console", level: "error", text: "Cart failed: 500", at: at + 50, page: `${origin}/`, source: `${origin}/app.js:1:150`, stack: `Error\n    at ${origin}/app.js:1:150` },
    ],
  });
  const r = await viaProxy("/__dx/events", { method: "POST", headers: { origin, "content-type": "text/plain" }, body: events });
  assert.equal(r.status, 204);
  const list = await api(`/api/activity?dir=${encodeURIComponent(app)}&since=1h&types=console`);
  const e = list.reverse().find((x: { visit?: string }) => x.visit === visit);
  return { id: e.id, visit };
}

test("bug bundles: exported without hosts or folders, refused when they're not what a bundle is", async () => {
  const { id } = await recordError();
  const { file, bundle } = await api(`/api/activity/bundle?dir=${encodeURIComponent(app)}&id=${id}`);
  assert.match(file, /^todo-app-[0-9a-f]{7}-\d{8}-\d{4}\.dxbug\.json$/);
  assert.equal(bundle.format, "dx-bug");
  assert.equal(bundle.git.commit, head);
  assert.equal(bundle.git.dirty, false);
  assert.deepEqual(bundle.steps, [{ click: "#add" }]);
  assert.equal(bundle.dev.start, "/");
  assert.equal(bundle.error.source, "/app.js:1:150");
  const text = JSON.stringify(bundle);
  assert.ok(!text.includes(String(dashboard.localDomainsPort)) && !text.includes("localhost") && !text.includes(root) && !text.includes(home), text);
  assert.equal((await call(`/api/activity/bundle?dir=${encodeURIComponent(app)}&id=12345`)).status, 404);

  const replay = (b: unknown, extra: object = {}) => call("/api/activity/bundle/replay", { dir: app, bundle: b, ...extra });
  const expect = async (b: unknown, status: number, re: RegExp) => {
    const r = await replay(b);
    assert.equal(r.status, status, JSON.stringify(r.data));
    assert.match(r.data.error, re);
  };
  await expect({ ...bundle, format: "zip" }, 400, /isn't a dx bug bundle/);
  await expect({ ...bundle, version: 9 }, 400, /version 9/);
  await expect({ ...bundle, git: { ...bundle.git, commit: "zz-top" } }, 400, /isn't a commit hash/);
  await expect({ ...bundle, git: { ...bundle.git, commit: "deadbeefdeadbeef" } }, 404, /isn't in this repository/);
  await expect({ ...bundle, steps: [{ goto: "http://192.168.1.10/admin" }] }, 400, /another computer/);
  await expect({ ...bundle, dev: { start: "https://example.com/" } }, 400, /another computer/);
  await expect({ ...bundle, events: [{ type: "console", text: "x".repeat(2_200_000) }] }, 413, /too large/);
  // Past what the dashboard reads at all: refused, or the connection is cut while it's sent.
  const huge = await replay({ ...bundle, events: [{ type: "console", text: "x".repeat(3_300_000) }] }).catch(() => ({ status: 400 }));
  assert.equal(huge.status, 400);
  assert.equal((await replay(bundle, { dir: path.join(root, "elsewhere") })).status, 404, "only a known project");
  assert.equal((await call("/api/activity/bundle/replay?id=nope")).status, 404);
});

const browser = findBrowser();
test("replaying a bundle on the working copy finds the same error", { skip: browser ? false : "no Chrome, Edge, Chromium or Brave here" }, async () => {
  const { id } = await recordError();
  const { bundle } = await api(`/api/activity/bundle?dir=${encodeURIComponent(app)}&id=${id}`);
  let job = await api("/api/activity/bundle/replay", { dir: app, bundle, use: "working" });
  assert.equal(job.target, "your working copy");
  for (let i = 0; i < 300 && job.phase !== "done" && job.phase !== "failed"; i++) {
    await new Promise((r) => setTimeout(r, 200));
    job = await api(`/api/activity/bundle/replay?id=${job.id}`);
  }
  assert.equal(job.phase, "done", JSON.stringify(job));
  assert.ok(job.url.startsWith(`http://${host}:`), "on this project's own dev server");
  assert.equal(job.verdict.reproduced, true, JSON.stringify(job.verdict));
  assert.match(job.verdict.summary, /^Reproduced: the same error at app\.js:1$/);
});
