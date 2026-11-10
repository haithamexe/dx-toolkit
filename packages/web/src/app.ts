import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appHome,
  appReady,
  electronInstalling,
  findElectron,
  installElectron,
  isLoopbackUrl,
  linkedProgram,
  loadConfig,
  nameAppProgram,
  openAppWindow,
  pointCurrentAt,
  pruneElectrons,
  saveConfig,
  setAppStartup,
  writeAppLauncherEntry,
  writeFileAtomic,
  writeFloppySprites,
  type ShortcutLaunch,
} from "@dx/core";
import { floppySpritesDir, floppySupported, readFloppyInfo, startFloppy } from "./floppy.js";

/**
 * Opening the dx app: the dashboard in a window of its own, run by the Electron dx installs in
 * ~/.dx/app (core's appshell.ts). The window's code is web/shell/main.js. Until Electron is there,
 * or when it can't be installed, the dashboard opens as an Edge app window, then in the browser.
 */

/** The folder Electron runs: web/shell, with its package.json and main.js. */
export function appShellDir(): string {
  return fileURLToPath(new URL("../shell", import.meta.url));
}

function appInstallEntry(): string {
  return fileURLToPath(new URL("./appinstall.js", import.meta.url));
}

/** Node's real path: version managers hand out per-shell links that don't last. */
function realNode(): string {
  try {
    return fs.realpathSync.native(process.execPath);
  } catch {
    return process.execPath;
  }
}

/** Floppy as the app's icon: the .ico with every size on Windows, the .icns on macOS, a large PNG elsewhere. */
export function appIcon(platform: NodeJS.Platform = process.platform): string {
  const manifest = writeFloppySprites(floppySpritesDir(), loadConfig().floppy?.colourway ?? "navy");
  return path.join(floppySpritesDir(), platform === "win32" ? manifest.icon : platform === "darwin" ? "floppy.icns" : "floppy-256.png");
}

/** The window's and shortcuts' icon: the .ico on Windows, the PNG elsewhere (macOS takes the Dock's from the bundle). */
function windowIcon(): string {
  return appIcon(process.platform === "win32" ? "win32" : "linux");
}

/**
 * What the window needs to start the dashboard by itself, when it's opened from the Start menu or
 * at sign-in: dx's node, and the icon. Written each time dx opens the app, so it follows updates.
 */
export function writeAppLaunch(): void {
  fs.mkdirSync(appHome(), { recursive: true });
  writeFileAtomic(path.join(appHome(), "launch.json"), JSON.stringify({ node: realNode(), icon: windowIcon() }, null, 2) + "\n", { mode: 0o600 });
}

/**
 * What a shortcut or sign-in entry starts to open the app: the program through `current`, with
 * dx's shell folder. Undefined until Electron is installed.
 */
export function appLauncher(): ShortcutLaunch | undefined {
  const electron = findElectron();
  return electron ? { command: linkedProgram(electron), args: [appShellDir()], icon: windowIcon() } : undefined;
}

/**
 * Sign-in entries and launchers can't carry DX_HOME, so with it set (tests, demos) dx writes none:
 * one would open the app on the everyday ~/.dx instead.
 */
export function canWriteShortcuts(): boolean {
  return !process.env.DX_HOME;
}

function launch(program: string, url: string): Promise<void> {
  writeAppLaunch();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return new Promise((resolve, reject) => {
    const child = spawn(program, [appShellDir(), `--url=${url}`], { detached: true, stdio: "ignore", windowsHide: false, env });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** Installs (or updates) Electron in a process of its own, unless one is at it already. The running app isn't touched. */
export function updateAppInBackground(): boolean {
  if (appReady() || electronInstalling()) return false;
  const child = spawn(realNode(), [appInstallEntry()], { detached: true, stdio: "ignore", windowsHide: true });
  child.once("error", () => undefined);
  child.unref();
  return true;
}

/**
 * After an install: dx's name and Floppy's icon on the program, `current` pointed at it, and the
 * versions nothing uses any more removed. A naming failure only leaves Electron's name.
 */
export async function settleElectron(): Promise<{ message?: string }> {
  const electron = findElectron();
  if (!electron) return { message: "Electron isn't installed." };
  const named = await nameAppProgram(appIcon(), electron).catch((err: Error) => ({ ok: false, changed: false, message: err.message }));
  const now = findElectron() ?? electron;
  pointCurrentAt(now);
  pruneElectrons();
  return { message: named.ok ? undefined : named.message };
}

export interface AppOpen {
  /** "app" is the dx app; "window" an Edge (or Chrome) app window; "browser" a tab. */
  opened: "app" | "window" | "browser";
  /** Electron is being installed or updated in the background, for next time. */
  installing?: boolean;
  /** What went wrong on the way, when something did (the install, the update, the naming). */
  message?: string;
}

/**
 * Opens the dashboard at `url` in the dx app. `install` says what to do when the pinned Electron
 * isn't there: "wait" installs it first (dx ui, in a terminal), "background" opens what's there
 * now (an older Electron, else an app window) and installs it for next time (Floppy's click), "no"
 * only opens. An update installs next to the running app, so it never has to close.
 */
export async function openDxApp(url: string, options: { install?: "wait" | "background" | "no"; onLine?: (line: string) => void } = {}): Promise<AppOpen> {
  if (!isLoopbackUrl(url)) throw new Error("Only addresses on this computer open in the dx app.");
  let message: string | undefined;
  let installing = false;
  if (!appReady()) {
    if (options.install === "wait") {
      const r = await installElectron({ onLine: options.onLine });
      if (!r.ok) message = r.message;
    } else if (options.install === "background") installing = updateAppInBackground() || electronInstalling();
  }
  const electron = findElectron();
  if (electron) {
    if (!installing) message = (await settleElectron()).message ?? message;
    await launch(linkedProgram(findElectron() ?? electron), url);
    startFloppyWithApp();
    return { opened: "app", installing, message };
  }
  const opened = (await openAppWindow(url)) === "app" ? "window" : "browser";
  return { opened, installing, message };
}

/**
 * Floppy comes with the app on Windows, unless you sent it away (its menu's Quit, or
 * `dx floppy --stop`; `dx floppy` brings it back). Starting is quick and doesn't wait for it.
 */
export function startFloppyWithApp(): void {
  if (!floppySupported() || loadConfig().floppy?.off || readFloppyInfo()) return;
  void startFloppy().catch(() => undefined);
}

/**
 * Called after the app opens: the first time, it sets the app to open when you sign in (as
 * Floppy does) and says how to undo it; after that it keeps the entry's paths up to date. On
 * Linux it also writes the launcher entry. Returns what to tell the user the first time, if anything.
 */
export function settleAppStartup(): string | undefined {
  if (!canWriteShortcuts()) return undefined;
  const launcher = appLauncher();
  if (!launcher) return undefined;
  writeAppLauncherEntry(launcher);
  const config = loadConfig();
  const dashboard = { ...(config.dashboard ?? {}) };
  if (dashboard.startup === undefined) {
    const r = setAppStartup(true, launcher);
    dashboard.startup = r.ok;
    saveConfig({ ...loadConfig(), dashboard });
    return r.ok ? r.message : undefined;
  }
  if (dashboard.startup) setAppStartup(true, launcher);
  return undefined;
}
