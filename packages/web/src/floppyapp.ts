// Floppy, running: a hidden node process that owns Floppy's window (Windows PowerShell and WPF,
// see core's floppyWindow.ts), asks the dashboard every two seconds what's going on, and opens the
// dx app (web/src/app.ts) when Floppy is clicked. Started by `dx floppy` or, with --detach, by
// the Startup shortcut. It never keeps a background dashboard running by itself: its questions
// carry X-DX-Quiet, and a click starts the dashboard only when it isn't there.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  FLOPPY_WINDOW_PS,
  floppyErrorKey,
  floppyStartsWithWindows,
  floppyView,
  loadConfig,
  newFloppyMemory,
  recordRun,
  saveConfig,
  setFloppyStartup,
  writeFloppySprites,
  type FloppySnapshot,
  type FloppyView,
} from "@dx/core";
import { openDxApp } from "./app.js";
import { clearFloppyInfo, floppyDir, floppyLauncher, floppySpritesDir, readFloppyInfo, startFloppy, writeFloppyInfo } from "./floppy.js";
import { ensureDashboard, readDashboardInfo } from "./link.js";

if (process.argv.includes("--detach")) {
  const r = await startFloppy();
  process.exit(r.started || r.pid ? 0 : 1);
}

const other = readFloppyInfo();
if (other && other.pid !== process.pid) process.exit(0);
if (process.platform !== "win32") process.exit(1);
writeFloppyInfo();

const dir = floppyDir();
const log = (line: string) => {
  try {
    fs.appendFileSync(path.join(dir, "window.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // nowhere to write; carry on
  }
};
try {
  const file = path.join(dir, "window.log");
  if (fs.statSync(file).size > 256 * 1024) fs.rmSync(file);
} catch {
  // no log yet
}

const config = loadConfig();
writeFloppySprites(floppySpritesDir(), config.floppy?.colourway ?? "navy");
const script = path.join(dir, "floppy-window.ps1");
fs.writeFileSync(script, FLOPPY_WINDOW_PS);

// The script is dx's own, read from ~/.dx and run with fixed arguments. Invoke-Expression runs
// it without touching PowerShell's execution policy, which applies to script files.
const win = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", "Invoke-Expression ([IO.File]::ReadAllText($env:DX_FLOPPY_PS))"], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, DX_FLOPPY_PS: script, DX_FLOPPY_DIR: floppySpritesDir(), DX_FLOPPY_X: config.floppy?.x !== undefined ? String(config.floppy.x) : "" },
});
recordRun("floppy", true, "on the desktop", "web");

let quitting = false;
let timer: NodeJS.Timeout | undefined;
function quit(code = 0): void {
  if (quitting) return;
  quitting = true;
  if (timer) clearInterval(timer);
  try {
    win.stdin.end();
  } catch {
    // closed already
  }
  clearFloppyInfo();
  setTimeout(() => process.exit(code), 300);
}
win.on("exit", (code) => {
  if (!quitting) log(`window closed (${code})`);
  quit(0);
});
win.on("error", (err) => {
  log(`couldn't start PowerShell: ${err.message}`);
  quit(1);
});
win.stderr.setEncoding("utf8");
win.stderr.on("data", (d: string) => log(d.trim()));

const send = (msg: unknown) => {
  if (!quitting && win.stdin.writable) win.stdin.write(JSON.stringify(msg) + "\n");
};

// ------------------------------------------------------------ what's going on
let memory = newFloppyMemory();
let lastKey = "";
let current: { snap?: FloppySnapshot; view?: FloppyView } = {};
let busy = false;

async function snapshot(): Promise<FloppySnapshot> {
  const info = readDashboardInfo();
  if (!info) return { dashboard: false, servers: [] };
  try {
    const res = await fetch(new URL("/api/floppy", info.url), { headers: { "X-DX-Token": info.token, "X-DX-Quiet": "1" }, signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { dashboard: false, servers: [] };
    return (await res.json()) as FloppySnapshot;
  } catch {
    return { dashboard: false, servers: [] };
  }
}

async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const snap = await snapshot();
    const { view, memory: next } = floppyView(snap, memory);
    memory = next;
    current = { snap, view };
    const msg = { type: "mood", mood: view.mood, play: view.play, tip: view.tip, status: view.status, announce: !!view.announce, sticky: !!view.sticky };
    const key = JSON.stringify({ ...msg, announce: false, play: undefined });
    if (view.announce || view.play || key !== lastKey) send(msg);
    lastKey = key;
  } finally {
    busy = false;
  }
}

function menuState(): void {
  send({ type: "menu", quiet: !!memory.quietUntil && memory.quietUntil > Date.now(), startup: floppyStartsWithWindows() });
}

async function openDx(): Promise<void> {
  // Opening dx is looking at the error, so Floppy stops pointing at it.
  const key = current.snap && floppyErrorKey(current.snap);
  if (key && !memory.seen.includes(key)) memory.seen = [...memory.seen.slice(-50), key];
  try {
    const client = await ensureDashboard();
    // The dx app; until it's installed (that starts here, in the background), an app window.
    await openDxApp(client.url, { install: loadConfig().dashboard?.open === "browser" ? "no" : "background" });
  } catch (err) {
    send({ type: "mood", mood: "error", tip: { title: "Couldn't open dx", text: (err as Error).message, icon: "error" }, announce: true });
  }
  void tick();
}

function remember(change: (f: NonNullable<ReturnType<typeof loadConfig>["floppy"]>) => void): void {
  const fresh = loadConfig();
  const floppy = { ...(fresh.floppy ?? {}) };
  change(floppy);
  saveConfig({ ...fresh, floppy });
}

// ------------------------------------------------------------ what Floppy says back
readline.createInterface({ input: win.stdout }).on("line", (line) => {
  let ev: { event?: string; action?: string; checked?: boolean; x?: number };
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  if (ev.event === "ready") {
    menuState();
    lastKey = "";
    void tick();
  } else if (ev.event === "click") {
    void openDx();
  } else if (ev.event === "moved" && typeof ev.x === "number" && Number.isFinite(ev.x)) {
    const x = ev.x;
    remember((f) => (f.x = Math.round(x)));
  } else if (ev.event === "menu") {
    if (ev.action === "open") void openDx();
    else if (ev.action === "quiet") {
      memory = { ...memory, quietUntil: ev.checked ? Date.now() + 60 * 60_000 : undefined };
      lastKey = "";
      menuState();
      void tick();
    } else if (ev.action === "startup") {
      const on = !!ev.checked;
      const r = setFloppyStartup(on, floppyLauncher());
      if (r.ok) remember((f) => (f.startup = on));
      else send({ type: "mood", mood: current.view?.mood ?? "idle", tip: { title: "Start with Windows", text: r.message, icon: "error" }, announce: true });
      menuState();
    } else if (ev.action === "quit") {
      // Sent away: the dx app doesn't bring it back until `dx floppy`.
      remember((f) => (f.off = true));
      recordRun("floppy", true, "quit", "web");
      send({ type: "quit" });
      setTimeout(() => quit(0), 500);
    }
  }
});

timer = setInterval(() => void tick(), 2000);
process.on("SIGINT", () => quit(0));
process.on("SIGTERM", () => quit(0));
