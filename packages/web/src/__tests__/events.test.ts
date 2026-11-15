import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-events-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-events-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", localDomainsPort: 0, autoConnectAi: false }));

// A project whose dev server stops at once the way one does when its port is taken.
const busy = path.join(root, "shop-website");
fs.mkdirSync(busy);
fs.writeFileSync(path.join(busy, "package.json"), JSON.stringify({ name: "shop-website", scripts: { dev: "node server.cjs" } }));
fs.writeFileSync(path.join(busy, "server.cjs"), `console.error("Error: listen EADDRINUSE: address already in use :::3000");\nprocess.exit(1);\n`);

// A project that listens on the PORT it is given, for "Use another port".
const movable = path.join(root, "todo-app");
fs.mkdirSync(movable);
fs.writeFileSync(path.join(movable, "package.json"), JSON.stringify({ name: "todo-app", scripts: { dev: "node server.cjs" } }));
fs.writeFileSync(path.join(movable, "server.cjs"), `const s = require("http").createServer((q, r) => r.end("ok")).listen(Number(process.env.PORT) || 3000, "127.0.0.1", () => console.log("Local: http://localhost:" + s.address().port + "/"));
`);

const { startDashboard } = await import("../server.js");
const { publish, liveClientCount } = await import("../events.js");
const { recordChange } = await import("@dx/core");
let dashboard: Awaited<ReturnType<typeof startDashboard>>;

before(async () => {
  dashboard = await startDashboard({ port: 0, localDomainPorts: false });
});
after(async () => {
  await dashboard.close();
});

async function api(p: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(new URL(p, dashboard.url), {
    method: init.method ?? "GET",
    headers: { "X-DX-Token": dashboard.token, ...(init.body ? { "Content-Type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as any };
}

/** Opens the stream and collects what arrives, until `done` says enough. */
function stream(query = "", token: string | null = dashboard.token): Promise<{ status: number; text: () => string; waitFor: (needle: string, ms?: number) => Promise<void>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token) headers["X-DX-Token"] = token;
    const req = http.get(new URL(`/api/events${query}`, dashboard.url), { headers }, (res) => {
      let body = "";
      const waiters: { needle: string; ok: () => void }[] = [];
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
        for (const w of waiters.splice(0)) (body.includes(w.needle) ? w.ok() : waiters.push(w));
      });
      resolve({
        status: res.statusCode ?? 0,
        text: () => body,
        waitFor: (needle, ms = 5000) =>
          new Promise<void>((ok, fail) => {
            if (body.includes(needle)) return ok();
            waiters.push({ needle, ok });
            setTimeout(() => fail(new Error(`never saw ${needle} in:\n${body}`)), ms).unref();
          }),
        close: () => req.destroy(),
      });
    });
    req.on("error", reject);
  });
}

test("the stream needs the token like every /api route, and says so in the one problem shape", async () => {
  const s = await stream("", null);
  assert.equal(s.status, 401);
  await s.waitFor("stale-token");
  s.close();
});

test("it says hello, then what's published, with ids that increase", async () => {
  const s = await stream();
  assert.equal(s.status, 200);
  await s.waitFor("event: hello");
  const first = publish("dev", { dir: "/path/to/todo-app", project: "todo-app", status: "starting", step: "Starting node server.js" });
  const second = publish("dev", { dir: "/path/to/todo-app", project: "todo-app", status: "ready" });
  await s.waitFor('"status":"ready"');
  assert.ok(second.id > first.id);
  assert.match(s.text(), new RegExp(`id: ${first.id}\\nevent: dev\\ndata: .*"step":"Starting node server.js"`));
  s.close();
});

test("a page that dropped for a moment catches up from the last id it saw", async () => {
  const missed = publish("dev", { dir: "/path/to/api-gateway", status: "failed" });
  const after = missed.id - 1;
  const s = await stream(`?after=${after}`);
  await s.waitFor("api-gateway");
  assert.ok(s.text().indexOf("event: hello") < s.text().indexOf("api-gateway"), "hello first, then what it missed");
  const none = await stream(`?after=${missed.id}`);
  await none.waitFor("event: hello");
  assert.equal(none.text().includes("api-gateway"), false, "only what it missed");
  s.close();
  none.close();
});

test("a change in the changes list reaches the page, without the change's details", async () => {
  const s = await stream();
  await s.waitFor("event: hello");
  recordChange({ by: "dx", kind: "gitignore", project: "shop-website", dir: "/path/to/shop-website", what: "Added 1 rule to shop-website's .gitignore" });
  await s.waitFor("event: change");
  assert.match(s.text(), /"kind":"gitignore"/);
  assert.equal(s.text().includes("/path/to/shop-website"), false, "a folder isn't sent");
  s.close();
});

test("a dev server that fails is told live with why and how to get out, and the card read says the same", async () => {
  const s = await stream();
  await s.waitFor("event: hello");
  const start = await api("/api/dev/start", { method: "POST", body: { dir: busy } });
  assert.equal(start.status, 200);
  await s.waitFor('"status":"failed"', 15_000);
  assert.match(s.text(), /"code":"port-in-use"/);
  assert.match(s.text(), /Use another port/);

  const summary = await api(`/api/project/summary?dir=${encodeURIComponent(busy)}`);
  assert.equal(summary.json.server.status, "failed");
  assert.equal(summary.json.server.problem.code, "port-in-use");
  assert.match(summary.json.server.problem.message, /Port 3000 is in use/);
  assert.deepEqual(summary.json.server.problem.fixes.map((f: { label: string }) => f.label), ["Use another port", "Show that process"]);
  s.close();
  await api("/api/dev/stop", { method: "POST", body: { dir: busy } });
});

test("Use another port starts it on a free port of its own and says why", async () => {
  const start = await api("/api/dev/start", { method: "POST", body: { dir: movable, ownPort: true } });
  assert.equal(start.status, 200);
  let server: any;
  for (let i = 0; i < 60 && server?.status !== "ready"; i++) {
    await new Promise((r) => setTimeout(r, 250));
    server = (await api(`/api/project/summary?dir=${encodeURIComponent(movable)}`)).json.server;
  }
  assert.equal(server?.status, "ready");
  assert.notEqual(new URL(server.url).port, "3000", "a port of its own");
  const logs = await api(`/api/dev/logs?dir=${encodeURIComponent(movable)}`);
  assert.ok(logs.json.lines.some((l: { text: string }) => /The usual port is busy: (runs on port|given PORT=)/.test(l.text)), "the log says why");
  await api("/api/dev/stop", { method: "POST", body: { dir: movable } });
});

test("every failure has a code and the same words as before", async () => {
  const none = await api("/api/undo", { method: "POST", body: {} });
  assert.equal(none.status, 400);
  assert.match(none.json.error, /Which change/);
  assert.deepEqual(none.json.problem, { code: "invalid", message: none.json.error });
  const missing = await api("/api/project/summary?dir=" + encodeURIComponent(path.join(root, "nope")));
  assert.equal(missing.status, 404);
  assert.equal(missing.json.problem.code, "not-found");
  assert.equal(missing.json.problem.message, missing.json.error);
});

test("a page that goes away stops being written to, and the watcher stops with the last one", async () => {
  const a = await stream();
  const b = await stream();
  await a.waitFor("event: hello");
  await b.waitFor("event: hello");
  assert.equal(liveClientCount(), 2);
  a.close();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(liveClientCount(), 1);
  b.close();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(liveClientCount(), 0);
});
