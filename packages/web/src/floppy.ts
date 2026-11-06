import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dxPath, ensureDxHome, loadConfig, saveConfig, setFloppyStartup, writeFloppySprites, type FloppyLaunch } from "@dx/core";

/**
 * Starting and stopping Floppy, for `dx floppy` and the Startup shortcut. Floppy itself is
 * floppyapp.ts: a hidden node process that owns the window and asks the dashboard what's going on.
 */
export interface FloppyInfo {
  pid: number;
  startedAt: string;
}

export function floppyDir(): string {
  return dxPath("floppy");
}

export function floppySpritesDir(): string {
  return path.join(floppyDir(), "sprites");
}

export function floppyEntry(): string {
  return fileURLToPath(new URL("./floppyapp.js", import.meta.url));
}

function infoPath(): string {
  return path.join(floppyDir(), "floppy.json");
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The running Floppy, if there is one. */
export function readFloppyInfo(): FloppyInfo | undefined {
  try {
    const info = JSON.parse(fs.readFileSync(infoPath(), "utf8")) as FloppyInfo;
    return typeof info.pid === "number" && alive(info.pid) ? info : undefined;
  } catch {
    return undefined;
  }
}

export function writeFloppyInfo(pid = process.pid): void {
  ensureDxHome();
  fs.mkdirSync(floppyDir(), { recursive: true });
  fs.writeFileSync(infoPath(), JSON.stringify({ pid, startedAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
}

export function clearFloppyInfo(pid = process.pid): void {
  try {
    const info = JSON.parse(fs.readFileSync(infoPath(), "utf8")) as FloppyInfo;
    if (info.pid !== pid) return;
    fs.unlinkSync(infoPath());
  } catch {
    // already gone
  }
}

/**
 * What the Startup shortcut runs: node (its real path, since version managers hand out
 * per-shell links that don't last) with Floppy's entry and --detach, which starts Floppy hidden
 * and exits at once.
 */
export function floppyLauncher(): FloppyLaunch {
  let node = process.execPath;
  try {
    node = fs.realpathSync.native(node);
  } catch {
    // keep it as it is
  }
  return { command: node, args: [floppyEntry(), "--detach"], icon: path.join(floppySpritesDir(), "floppy.ico") };
}

export async function startFloppy(): Promise<{ started: boolean; pid?: number; message: string }> {
  if (process.platform !== "win32") return { started: false, message: "Floppy lives on the Windows taskbar for now. macOS and Linux come later." };
  const running = readFloppyInfo();
  if (running) return { started: false, pid: running.pid, message: "Floppy is already on your desktop." };
  ensureDxHome();
  const child = spawn(process.execPath, [floppyEntry()], { detached: true, stdio: "ignore", windowsHide: true, env: process.env });
  child.unref();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const info = readFloppyInfo();
    if (info) return { started: true, pid: info.pid, message: "Floppy is on your desktop." };
    if (child.exitCode !== null) break;
  }
  return { started: false, message: `Floppy didn't start. Its log is ${path.join(floppyDir(), "window.log")}.` };
}

/**
 * What `dx floppy` and the dashboard's Run Floppy button do before starting it: its frames drawn
 * (the shortcut shows its icon), and its Startup shortcut turned on the first time (you asked for
 * Floppy to start with Windows) or kept pointing at this dx. Says so the first time. No shortcut
 * while DX_HOME is set: a shortcut can't carry it, so it would start another dx's Floppy.
 */
export function settleFloppyStartup(): { message?: string; warning?: string } {
  const floppy = loadConfig().floppy ?? {};
  writeFloppySprites(floppySpritesDir(), floppy.colourway ?? "navy");
  if (process.env.DX_HOME) return {};
  if (floppy.startup === undefined) {
    const r = setFloppyStartup(true, floppyLauncher());
    const config = loadConfig();
    saveConfig({ ...config, floppy: { ...(config.floppy ?? {}), startup: r.ok } });
    return r.ok ? { message: "Floppy will start when you sign in to Windows." } : { warning: r.message };
  }
  if (floppy.startup) setFloppyStartup(true, floppyLauncher());
  return {};
}

/**
 * The dashboard's Run Floppy button: brings Floppy back if you'd sent it away (`floppy.off`, which
 * keeps the app from starting it) and starts it, as `dx floppy` does. `start` is for tests.
 */
export async function runFloppy(start: typeof startFloppy = startFloppy): Promise<{ started: boolean; running: boolean; message: string }> {
  if (process.platform !== "win32") return { started: false, running: false, message: "Floppy lives on the Windows taskbar for now. macOS and Linux come later." };
  const config = loadConfig();
  if (config.floppy?.off) {
    const floppy = { ...config.floppy };
    delete floppy.off;
    saveConfig({ ...config, floppy });
  }
  const settled = settleFloppyStartup();
  const r = await start();
  return { started: r.started, running: r.started || r.pid !== undefined, message: [r.message, r.started ? settled.message : undefined].filter(Boolean).join(" ") };
}

/** Takes Floppy off the desktop. Its window closes by itself once its controller is gone. */
export async function stopFloppy(): Promise<boolean> {
  const info = readFloppyInfo();
  if (!info) return false;
  try {
    process.kill(info.pid);
  } catch {
    // gone already
  }
  for (let i = 0; i < 20 && alive(info.pid); i++) await new Promise((r) => setTimeout(r, 100));
  clearFloppyInfo(info.pid);
  return true;
}
