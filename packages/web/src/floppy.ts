import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dxPath, ensureDxHome, type FloppyLaunch } from "@dx/core";

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
