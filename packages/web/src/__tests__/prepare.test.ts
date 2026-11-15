import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// Run gets a project ready first: .env from its example, its own prepare steps, and when one
// fails, the server isn't started and the log says which step and why. Our own dx home and projects.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-prepare-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-prepare-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0 }));

function app(name: string, prepare: string[]) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, scripts: { dev: "node server.cjs" } }));
  fs.writeFileSync(path.join(dir, ".env.example"), "GREETING=hello\n");
  fs.writeFileSync(path.join(dir, ".devrc.json"), JSON.stringify({ prepare }));
  fs.writeFileSync(
    path.join(dir, "server.cjs"),
    `const http = require("http");
     const s = http.createServer((q, r) => r.end(require("fs").existsSync("generated.txt") ? "ready" : "not generated"))
       .listen(0, "127.0.0.1", () => console.log("Local: http://localhost:" + s.address().port + "/"));`,
  );
  return dir;
}
const good = app("todo-app", [`node -e "require('fs').writeFileSync('generated.txt','1'); console.log('codegen done')"`]);
const bad = app("api-gateway", [`node -e "console.error('cannot reach the schema registry'); process.exit(2)"`]);

const { startDashboard } = await import("../server.js");
let dashboard: Awaited<ReturnType<typeof startDashboard>>;
const api = async (p: string, body?: unknown) => {
  const res = await fetch(new URL(p, dashboard.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-DX-Token": dashboard.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as any;
};
async function settle(dir: string) {
  let s: any;
  for (let i = 0; i < 150; i++) {
    s = (await api("/api/dev")).find((d: { dir: string }) => d.dir === dir);
    if (s && s.status !== "starting") return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  return s;
}

before(async () => {
  dashboard = await startDashboard({ port: 0 });
});
after(async () => {
  await api("/api/dev/stop", { dir: good });
  await dashboard.close();
});

test("Run gets the project ready first: .env from its example, its own steps, then the server", async () => {
  const started = await api("/api/dev/start", { dir: good });
  assert.equal(started.status, "starting");
  const s = await settle(good);
  assert.equal(s.status, "ready", JSON.stringify(s.prepare));
  assert.ok(fs.existsSync(path.join(good, ".env")), ".env made from .env.example");
  assert.ok(fs.existsSync(path.join(good, "generated.txt")), "the project's own step ran before the server");
  assert.deepEqual(
    s.prepare.filter((x: { id: string }) => x.id === "env" || x.id.startsWith("custom")).map((x: { status: string }) => x.status),
    ["done", "done"],
  );
  assert.equal(await (await fetch(s.url)).text(), "ready");
  const log = (await api(`/api/dev/logs?dir=${encodeURIComponent(good)}`)).lines.map((l: { text: string }) => l.text);
  assert.ok(log.includes("codegen done"), "the step's output is in the server's log");
  assert.ok(log.some((l: string) => l.startsWith("✓ Create .env")));
});

test("a step that fails stops the start, and the log says which and why", async () => {
  await api("/api/dev/start", { dir: bad });
  const s = await settle(bad);
  assert.equal(s.status, "failed");
  assert.equal(s.pid, undefined, "the server never ran");
  const failed = s.prepare.find((x: { status: string }) => x.status === "failed");
  assert.match(failed.title, /node -e/);
  const log = (await api(`/api/dev/logs?dir=${encodeURIComponent(bad)}`)).lines.map((l: { text: string }) => l.text);
  assert.ok(log.includes("cannot reach the schema registry"));
  assert.ok(log.some((l: string) => /didn't start: .* failed/.test(l)));
});

test("a slow machine: the time spent getting ready isn't counted against a server that is slow to say where it listens", { timeout: 60_000 }, async () => {
  // Found on CI: after a slow prepare, "ready (it didn't say where it listens)" was declared at once, before the
  // server printed its address, so the card had no address. A step of 6 s, then a server that takes 2 s to listen: still
  // later than the old bug's instant "ready", and well inside the 5 s a server gets from its own start even when the
  // whole suite is loading the machine (3.5 s left a margin that a slow process start could eat).
  const dir = path.join(root, "slow-start");
  fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "slow-start", scripts: { dev: "node server.cjs" } }));
  fs.writeFileSync(path.join(dir, ".devrc.json"), JSON.stringify({ prepare: [`node -e "setTimeout(() => console.log('slow step done'), 6000)"`] }));
  fs.writeFileSync(path.join(dir, "server.cjs"), `const http = require("http"); setTimeout(() => { const s = http.createServer((q, r) => r.end("late but ready")).listen(0, "127.0.0.1", () => console.log("Local: http://localhost:" + s.address().port + "/")); }, 2000);`);
  try {
    await api("/api/dev/start", { dir });
    const s = await settle(dir);
    assert.equal(s.status, "ready", JSON.stringify(s));
    assert.ok(s.url, "the address it printed, not 'it didn't say where it listens'");
    assert.equal(await (await fetch(s.url)).text(), "late but ready");
  } finally {
    await api("/api/dev/stop", { dir });
  }
});
