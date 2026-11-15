import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// One service of a running stack restarted while the other keeps running: real processes, each printing
// its own process id, so the test can tell which was started again.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-svcrestart-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-svcrestart-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0 }));

function makeStack(name: string, devrc: object): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name }));
  fs.writeFileSync(path.join(dir, ".devrc.json"), JSON.stringify(devrc));
  const server = (label: string) =>
    `const http = require("http"); const s = http.createServer((q, r) => r.end("${label}")).listen(0, "127.0.0.1", () => console.log("${label} pid " + process.pid + " Local: http://localhost:" + s.address().port + "/"));`;
  fs.writeFileSync(path.join(dir, "api.cjs"), server("api"));
  fs.writeFileSync(path.join(dir, "web.cjs"), server("web"));
  return dir;
}
const shop = makeStack("shop", { stack: { web: { dev: "node web.cjs", dependsOn: ["api"] }, api: { dev: "node api.cjs" } } });

const { startDashboard } = await import("../server.js");
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pids(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const svc of ["api", "web"]) {
    const logs = (await call("GET", `/api/dev/logs?dir=${encodeURIComponent(shop)}&service=${svc}&after=0`)).json;
    const lines = (logs.lines as { text: string }[]).map((l) => l.text).filter((t) => /pid \d+/.test(t));
    out[svc] = /pid (\d+)/.exec(lines[lines.length - 1] ?? "")?.[1] ?? "";
  }
  return out;
}

test("restarting one service of a stack starts that one again and leaves the others running", async () => {
  assert.equal((await call("POST", "/api/dev/restart-service", { dir: shop, service: "api" })).status, 409, "not while the stack isn't running");
  await call("POST", "/api/dev/start", { dir: shop });
  for (let i = 0; i < 80; i++) {
    const s = (await call("GET", "/api/dev")).json.find((x: { project: string }) => x.project === "shop");
    if (s?.status === "ready" && s.services?.every((v: { status: string }) => v.status === "ready")) break;
    await sleep(250);
  }
  const before = await pids();
  assert.ok(before.api && before.web, JSON.stringify(before));

  const r = await call("POST", "/api/dev/restart-service", { dir: shop, service: "api" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const after = await pids();
  assert.notEqual(after.api, before.api, "the api is a new process");
  assert.equal(after.web, before.web, "the web service wasn't touched");
  const graph = (await call("GET", `/api/graph?dir=${encodeURIComponent(shop)}`)).json;
  assert.deepEqual(graph.nodes.map((n: { status: string }) => n.status), ["ready", "ready"].length === graph.nodes.length ? graph.nodes.map(() => "ready") : []);
  assert.equal(graph.runner, undefined);
});

test("a service that isn't there, and a stack that isn't running, are refused with the reason", async () => {
  const none = await call("POST", "/api/dev/restart-service", { dir: shop, service: "nope" });
  assert.equal(none.status, 409);
  assert.match(none.json.error, /no service called nope: /);
  await call("POST", "/api/dev/stop", { dir: shop });
  const stopped = await call("POST", "/api/dev/restart-service", { dir: shop, service: "api" });
  assert.equal(stopped.status, 409);
  assert.match(stopped.json.error, /isn't running/);
  assert.equal((await call("POST", "/api/dev/restart-service", { dir: path.join(root, "missing"), service: "api" })).status, 404);
});
