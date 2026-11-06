import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// GET /api/floppy, what Floppy asks every two seconds: read-only, behind the token, and its
// X-DX-Quiet questions don't count as someone using the dashboard.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-floppy-web-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-floppy-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0 }));

const { startDashboard } = await import("../server.js");
const { readFloppyInfo, floppyLauncher, runFloppy } = await import("../floppy.js");
let dashboard: Awaited<ReturnType<typeof startDashboard>>;
let idle = 0;

before(async () => {
  dashboard = await startDashboard({ port: 0, background: true, idleMinutes: 0.02, onIdle: () => idle++ });
});
after(async () => {
  await dashboard.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test("GET /api/floppy: what's running, the newest error and the AI, behind the token", async () => {
  const res = await fetch(new URL("/api/floppy", dashboard.url), { headers: { "X-DX-Token": dashboard.token, "X-DX-Quiet": "1" } });
  assert.equal(res.status, 200);
  const snap = (await res.json()) as { ai: { active: unknown } };
  assert.deepEqual({ ...snap, ai: undefined }, { dashboard: true, servers: [], ai: undefined });
  assert.equal(typeof snap.ai.active, "boolean");
  assert.equal((await fetch(new URL("/api/floppy", dashboard.url))).status, 401);
});

test("quiet questions don't keep a background dashboard awake", async () => {
  const deadline = Date.now() + 5000;
  while (!idle && Date.now() < deadline) {
    await fetch(new URL("/api/floppy", dashboard.url), { headers: { "X-DX-Token": dashboard.token, "X-DX-Quiet": "1" } });
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(idle > 0, "it went idle while Floppy kept asking");
});

test("Run Floppy: whether there's one to start, behind the token, and it brings back a Floppy you'd sent away", async () => {
  const res = await fetch(new URL("/api/floppy/status", dashboard.url), { headers: { "X-DX-Token": dashboard.token } });
  assert.deepEqual(await res.json(), { available: process.platform === "win32", running: false });
  assert.equal((await fetch(new URL("/api/floppy/start", dashboard.url), { method: "POST" })).status, 401);

  // The route's work, with a stand-in for the real window: a test never puts Floppy on the desktop.
  const configFile = path.join(home, "config.json");
  const floppyConfig = () => JSON.parse(fs.readFileSync(configFile, "utf8")).floppy ?? {};
  fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, "utf8")), floppy: { off: true } }));
  let starts = 0;
  const r = await runFloppy(async () => (starts++, { started: true, pid: 1, message: "Floppy is on your desktop." }));
  if (process.platform !== "win32") {
    assert.deepEqual([r.running, starts, floppyConfig().off], [false, 0, true]);
    return;
  }
  assert.deepEqual([r.started, r.running, r.message, starts], [true, true, "Floppy is on your desktop.", 1]);
  assert.equal(floppyConfig().off, undefined, "sent away no more: the app brings it along again");
  assert.equal(floppyConfig().startup, undefined, "no Startup shortcut from a dx with its own DX_HOME");
  assert.ok(fs.existsSync(path.join(home, "floppy", "sprites", "manifest.json")), "its frames are drawn");
});

test("no Floppy running here, and the Startup shortcut would run node with Floppy's own entry", () => {
  assert.equal(readFloppyInfo(), undefined);
  const launch = floppyLauncher();
  assert.ok(launch.args[0].endsWith("floppyapp.js"));
  assert.deepEqual(launch.args.slice(1), ["--detach"]);
});
