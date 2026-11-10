import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

// GET /api/floppy, what Floppy asks every two seconds: read-only, behind the token, and its
// X-DX-Quiet questions don't count as someone using the dashboard.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-floppy-web-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-floppy-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0 }));

const { startDashboard } = await import("../server.js");
const { readFloppyInfo, floppyLauncher, floppySupported, runFloppy } = await import("../floppy.js");
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
  assert.deepEqual(await res.json(), { available: floppySupported(), running: false });
  assert.equal((await fetch(new URL("/api/floppy/start", dashboard.url), { method: "POST" })).status, 401);

  // The route's work, with a stand-in for the real window: a test never puts Floppy on the desktop.
  const configFile = path.join(home, "config.json");
  const floppyConfig = () => JSON.parse(fs.readFileSync(configFile, "utf8")).floppy ?? {};
  fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, "utf8")), floppy: { off: true } }));
  let starts = 0;
  const r = await runFloppy(async () => (starts++, { started: true, pid: 1, message: "Floppy is on your desktop." }));
  if (!floppySupported()) {
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

test("Floppy lives on Windows, macOS, and Linux with a display", () => {
  assert.equal(floppySupported("win32", {}), true);
  assert.equal(floppySupported("darwin", {}), true);
  assert.equal(floppySupported("linux", { DISPLAY: ":0" }), true);
  assert.equal(floppySupported("linux", { WAYLAND_DISPLAY: "wayland-0" }), true);
  assert.equal(floppySupported("linux", {}), false, "a server without a desktop");
});

test("Floppy's Electron window (macOS, Linux): its code parses, it's sandboxed, and its page runs only its own files", () => {
  const dir = fileURLToPath(new URL("../../shell/floppy/", import.meta.url));
  for (const f of ["main.js", "floppy.js", "preload.cjs"]) {
    const check = spawnSync(process.execPath, ["--check", path.join(dir, f)], { encoding: "utf8" });
    assert.equal(check.status, 0, `${f}: ${check.stderr}`);
  }
  const main = fs.readFileSync(path.join(dir, "main.js"), "utf8");
  for (const safe of ["sandbox: true", "contextIsolation: true", "nodeIntegration: false", "webviewTag: false"]) assert.ok(main.includes(safe), safe);
  for (const unsafe of ["nodeIntegration: true", "contextIsolation: false", "sandbox: false", "webSecurity: false", "loadURL("]) assert.ok(!main.includes(unsafe), unsafe);
  assert.ok(main.includes('"will-navigate"') && main.includes('action: "deny"'), "no navigation, no new windows");
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  assert.ok(html.includes("default-src 'none'; script-src 'self'; style-src 'self'; img-src data:"));
  assert.ok(!/<script>/.test(html) && !/ style="/.test(html), "no inline script or style");
  const page = fs.readFileSync(path.join(dir, "floppy.js"), "utf8");
  assert.ok(!page.includes("innerHTML"), "text goes in as text");
  // The same messages as the Windows window, both ways.
  for (const event of ['"click"', '"moved"', '"menu"']) assert.ok(page.includes(event) || main.includes(event), event);
  for (const type of ['"mood"', '"init"']) assert.ok(page.includes(type), type);
});
