import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dxPath, ensureDxHome } from "../config.js";
import { startMenuFolder, startupFolder, writeShortcut, type ShortcutLaunch } from "./shortcuts.js";

/**
 * The dx app: the dashboard in a window of its own, run by Electron. Electron isn't in dx's npm
 * package (a 100 MB download, about 370 MB installed): dx installs one pinned version from npm
 * the first time the app opens, and uses it from then on. The window itself is web/shell/main.js.
 *
 * Each Electron has a folder of its own, `~/.dx/app/runtime/<version>`, and `~/.dx/app/current`
 * is a link to the one in use (a junction on Windows). Shortcuts start the app through `current`,
 * so their path never changes. An update installs next to the running app, then moves `current`;
 * an old version is removed once nothing runs from it.
 */

/** The Electron dx installs. Pinned, so every machine runs the same one; bumped with dx's releases (scripts/check-electron.mjs). */
export const ELECTRON_VERSION = "45.2.3";

/**
 * rcedit, the Electron project's tool for a Windows program's name and icon, also pinned. On
 * Windows the app runs as `dx.exe`, a copy of Electron's program with dx's name and Floppy's icon
 * written in, so Task Manager, the Startup apps list and the taskbar say dx, not Electron.
 */
export const RCEDIT_VERSION = "5.0.2";

/**
 * The app's names: its program on Windows, its bundle on macOS, the name and company written in,
 * and its id (Windows' taskbar id, the macOS bundle id and sign-in item, matching shellrules' APP_ID).
 */
export const APP_PROGRAM = { file: "dx.exe", bundle: "dx.app", name: "dx", company: "dx", id: "dx.dashboard" } as const;

/** Where the app's Electron, its window settings and its browser data live. */
export function appHome(): string {
  return dxPath("app");
}

/** The npm folder for one Electron version. */
export function runtimeDir(version = ELECTRON_VERSION, home = appHome()): string {
  return path.join(home, "runtime", version);
}

/** The link shortcuts start the app through, pointing at the Electron in use. */
export function currentLink(home = appHome()): string {
  return path.join(home, "current");
}

export interface ElectronInstall {
  /** The program: dx.exe or dx.app once named, else Electron's own. */
  path: string;
  version: string;
  /** It's the version this dx pins. */
  current: boolean;
  /** The npm folder it's installed in. */
  dir: string;
  /** Electron's dist folder, which `current` points at. */
  dist: string;
}

const VERSION = /^\d+\.\d+\.\d+$/;

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** The program in an Electron dist folder: named when it has been, else what Electron's install wrote down. */
function programIn(dist: string, pkg: string, platform: NodeJS.Platform): string | undefined {
  const named = platform === "win32" ? path.join(dist, APP_PROGRAM.file) : platform === "darwin" ? path.join(dist, APP_PROGRAM.bundle, "Contents", "MacOS", "Electron") : undefined;
  if (named && fs.existsSync(named)) return named;
  const rel = fs.readFileSync(path.join(pkg, "path.txt"), "utf8").trim();
  if (!rel || rel.includes("..") || path.isAbsolute(rel)) return undefined;
  const file = path.join(dist, rel);
  return fs.existsSync(file) ? file : undefined;
}

/** The Electron in one npm folder, if its program is there. */
export function electronIn(dir: string, platform: NodeJS.Platform = process.platform): ElectronInstall | undefined {
  const pkg = path.join(dir, "node_modules", "electron");
  try {
    const version = (JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")) as { version: string }).version;
    const dist = path.join(pkg, "dist");
    const file = programIn(dist, pkg, platform);
    return file ? { path: file, version, current: version === ELECTRON_VERSION, dir, dist } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every Electron dx has installed, the pinned one first, then newest first. The layout before
 * runtime folders (node_modules right in ~/.dx/app) counts too, so an install made by an earlier
 * build keeps working until a newer one replaces it.
 */
export function listElectrons(home = appHome(), platform: NodeJS.Platform = process.platform): ElectronInstall[] {
  const dirs: string[] = [];
  try {
    for (const name of fs.readdirSync(path.join(home, "runtime"))) if (VERSION.test(name)) dirs.push(path.join(home, "runtime", name));
  } catch {
    // no runtime folders yet
  }
  dirs.push(home);
  return dirs
    .map((d) => electronIn(d, platform))
    .filter((e): e is ElectronInstall => !!e)
    .sort((a, b) => Number(b.current) - Number(a.current) || compareVersions(b.version, a.version));
}

/** The Electron the app runs on: the pinned one when it's there, else the newest installed. */
export function findElectron(home = appHome(), platform: NodeJS.Platform = process.platform): ElectronInstall | undefined {
  return listElectrons(home, platform)[0];
}

/** rcedit's program in an npm folder, when it's installed (Windows only; x64 also runs on Arm). */
export function findRcedit(dir: string): string | undefined {
  const file = path.join(dir, "node_modules", "rcedit", "bin", process.arch === "ia32" ? "rcedit.exe" : "rcedit-x64.exe");
  return fs.existsSync(file) ? file : undefined;
}

/** Everything the app needs is installed: the pinned Electron, and on Windows rcedit to name it. */
export function appReady(home = appHome(), platform: NodeJS.Platform = process.platform): boolean {
  const e = findElectron(home, platform);
  return !!e?.current && (platform !== "win32" || !!findRcedit(e.dir));
}

/** npm's arguments for the install: fixed words and the pinned versions, nothing else. */
export function electronInstallArgs(platform: NodeJS.Platform = process.platform): string[] {
  const packages = [`electron@${ELECTRON_VERSION}`, ...(platform === "win32" ? [`rcedit@${RCEDIT_VERSION}`] : [])];
  return ["install", ...packages, "--save-exact", "--no-audit", "--no-fund", "--no-package-lock", "--loglevel=error"];
}

/** An install another dx process is running: its lock folder, and how long until it counts as left over. */
const LOCK = ".installing";
const STALE_MS = 15 * 60_000;

/**
 * Installs the pinned Electron (and rcedit on Windows) with npm into its own runtime folder,
 * unless it's already there; a running app on another version is never touched. A second caller
 * while one runs waits for it. Electron's own install step downloads its program (from GitHub, or
 * ELECTRON_MIRROR); when npm skipped install scripts, dx runs that step itself.
 */
export async function installElectron(options: { home?: string; onLine?: (line: string) => void } = {}): Promise<{ ok: boolean; message: string; electron?: ElectronInstall }> {
  const home = options.home ?? appHome();
  const have = findElectron(home);
  if (appReady(home)) return { ok: true, message: `Electron ${have!.version} is ready.`, electron: have };
  ensureDxHome();
  fs.mkdirSync(home, { recursive: true });

  const lock = path.join(home, LOCK);
  if (!takeLock(lock)) {
    options.onLine?.("Another dx is getting the app ready; waiting for it…");
    const deadline = Date.now() + STALE_MS;
    while (fs.existsSync(lock) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
    return appReady(home) ? { ok: true, message: "The app is ready.", electron: findElectron(home) } : { ok: false, message: "The other install didn't finish. Run dx ui again." };
  }
  try {
    // The pinned Electron already there (only rcedit missing) gets it added in place.
    const dir = have?.current ? have.dir : runtimeDir(ELECTRON_VERSION, home);
    fs.mkdirSync(dir, { recursive: true });
    const pkgFile = path.join(dir, "package.json");
    if (!fs.existsSync(pkgFile)) {
      fs.writeFileSync(pkgFile, JSON.stringify({ name: "dx-app", private: true, description: "The Electron the dx app runs in, installed by dx. dx ui --remove-app removes it." }, null, 2) + "\n");
    }
    const npm = await runLogged("npm", electronInstallArgs(), dir, options.onLine);
    if (!npm.ok) return { ok: false, message: `npm couldn't install Electron: ${npm.last || "it failed"}` };
    if (!electronIn(dir)) {
      // npm ran with install scripts off (ignore-scripts); Electron's own step fetches the program.
      const script = path.join(dir, "node_modules", "electron", "install.js");
      if (fs.existsSync(script)) await runLogged(process.execPath, [script], dir, options.onLine, false);
    }
    const ready = electronIn(dir);
    if (!ready) return { ok: false, message: "Electron's program didn't download. Check your connection (or set ELECTRON_MIRROR) and run dx ui again." };
    if (process.platform === "win32" && !findRcedit(dir)) return { ok: false, message: "npm didn't install rcedit, which names the app's program.", electron: ready };
    return { ok: true, message: `Electron ${ready.version} is ready.`, electron: ready };
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** An install in progress, by this dx or another one. */
export function electronInstalling(home = appHome()): boolean {
  try {
    return Date.now() - fs.statSync(path.join(home, LOCK)).mtimeMs < STALE_MS;
  } catch {
    return false;
  }
}

function takeLock(lock: string): boolean {
  try {
    fs.mkdirSync(lock);
    return true;
  } catch {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > STALE_MS) {
        fs.rmSync(lock, { recursive: true, force: true });
        fs.mkdirSync(lock);
        return true;
      }
    } catch {
      // someone else took it
    }
    return false;
  }
}

/** Runs a fixed command, passing its lines on as they come. npm.cmd goes through cmd.exe on Windows. */
function runLogged(command: string, args: string[], cwd: string, onLine?: (line: string) => void, viaShell = command === "npm"): Promise<{ ok: boolean; last: string }> {
  return new Promise((resolve) => {
    const win = process.platform === "win32";
    const [file, list] = win && viaShell ? ["cmd.exe", ["/d", "/s", "/c", command, ...args]] : [command, args];
    // npm settings a dx started by `npm run` would pass on, which would make this a global install.
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^npm_config_(global|prefix|location)$/i.test(key)) delete env[key];
    const child = spawn(file, list, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let last = "";
    let partial = "";
    const take = (chunk: Buffer) => {
      const text = partial + chunk.toString("utf8");
      const lines = text.split(/\r?\n|\r/);
      partial = lines.pop() ?? "";
      for (const line of lines) {
        const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
        if (!clean) continue;
        last = clean;
        onLine?.(clean);
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.once("error", (err) => resolve({ ok: false, last: err.message }));
    child.once("close", (code) => resolve({ ok: code === 0, last: (partial.trim() || last).slice(0, 200) }));
  });
}

// ------------------------------------------------------------ `current`, and old versions

/** Removes `p` only when it's a link (a symlink, or a junction on Windows): the folder it points at stays. */
function removeLinkOnly(p: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return;
  }
  if (!st.isSymbolicLink()) return;
  try {
    fs.unlinkSync(p);
  } catch {
    // A junction some Node versions won't unlink: rmdir removes the link itself, not its contents.
    fs.rmdirSync(p);
  }
}

function samePath(a: string, b: string): boolean {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return false;
  }
}

/**
 * Points `current` at an Electron. Works while an app runs through the old link (checked on
 * Windows: the running program carries on). A folder named `current` that isn't a link is left alone.
 */
export function pointCurrentAt(e: ElectronInstall, home = appHome()): boolean {
  const link = currentLink(home);
  if (samePath(link, e.dist)) return true;
  try {
    removeLinkOnly(link);
    if (fs.existsSync(link)) return false;
    fs.symlinkSync(e.dist, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

/** The program as shortcuts start it: through `current` when it points at this Electron, so the path survives updates. */
export function linkedProgram(e: ElectronInstall, home = appHome()): string {
  const link = currentLink(home);
  return samePath(link, e.dist) ? path.join(link, path.relative(e.dist, e.path)) : e.path;
}

/**
 * Something runs from this Electron. On Windows a running program can't be opened for writing
 * (EBUSY), which is checked for every program in its dist folder (dx.exe, electron.exe). macOS and
 * Linux let a running program's files go, so there any dx app process counts as using all of them.
 */
export function electronInUse(e: ElectronInstall, home = appHome(), platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") {
    for (const name of [APP_PROGRAM.file, "electron.exe"]) {
      const file = path.join(e.dist, name);
      if (!fs.existsSync(file)) continue;
      try {
        fs.closeSync(fs.openSync(file, "r+"));
      } catch {
        return true;
      }
    }
    return false;
  }
  const ps = spawnSync("ps", ["-A", "-o", "command="], { encoding: "utf8" });
  return ps.status !== 0 || ps.stdout.includes(home);
}

/**
 * Removes the Electrons the app no longer uses, once the pinned one is in place and nothing runs
 * from them. Returns the versions removed.
 */
export function pruneElectrons(home = appHome(), platform: NodeJS.Platform = process.platform): string[] {
  const keep = findElectron(home, platform);
  if (!keep?.current) return [];
  const removed: string[] = [];
  for (const e of listElectrons(home, platform)) {
    if (e.dir === keep.dir || electronInUse(e, home, platform)) continue;
    const legacy = e.dir === home;
    const folder = legacy ? path.join(home, "node_modules") : e.dir;
    try {
      // Moved aside first, so a removal that stops halfway never leaves a half Electron that looks whole.
      const aside = `${folder}.removing`;
      fs.rmSync(aside, { recursive: true, force: true });
      fs.renameSync(folder, aside);
      fs.rmSync(aside, { recursive: true, force: true, maxRetries: 2 });
      if (legacy) for (const f of ["package.json", "program.json"]) fs.rmSync(path.join(home, f), { force: true });
      removed.push(e.version);
    } catch {
      // next time
    }
  }
  return removed;
}

// ------------------------------------------------------------ the program's name

/** rcedit's arguments: the program, Floppy's icon, and dx's name in the fields Windows shows. */
export function nameProgramArgs(program: string, icon: string): string[] {
  const field = (name: string, value: string) => ["--set-version-string", name, value];
  return [
    program,
    "--set-icon",
    icon,
    ...field("FileDescription", APP_PROGRAM.name),
    ...field("ProductName", APP_PROGRAM.name),
    ...field("CompanyName", APP_PROGRAM.company),
    ...field("InternalName", APP_PROGRAM.name),
    ...field("OriginalFilename", APP_PROGRAM.file),
  ];
}

/** The Info.plist keys dx sets on macOS, as `plutil -replace <key> -string <value>`. */
export function macPlistValues(): [string, string][] {
  return [
    ["CFBundleName", APP_PROGRAM.name],
    ["CFBundleDisplayName", APP_PROGRAM.name],
    ["CFBundleIdentifier", APP_PROGRAM.id],
    ["CFBundleIconFile", "dx.icns"],
  ];
}

/**
 * Gives the app dx's name and Floppy's icon, so the system shows dx, not Electron. Windows: dx.exe,
 * a copy of electron.exe with the name, company and icon written in by rcedit (a copy, so it works
 * while an app window still runs from the old one; electron.exe goes once nothing runs from it).
 * macOS: Electron.app becomes dx.app with its Info.plist's name, id and icon changed, then signed
 * again ad hoc (`codesign --sign -`), since changing Info.plist breaks Electron's signature. Linux
 * names the app through its launcher entry instead. Named again when Electron or the icon changes
 * (program.json keeps what it was made from).
 */
export async function nameAppProgram(icon: string, e = findElectron(), platform: NodeJS.Platform = process.platform): Promise<{ ok: boolean; changed: boolean; message: string }> {
  if (platform !== "win32" && platform !== "darwin") return { ok: true, changed: false, message: "Named by its launcher entry." };
  if (!e) return { ok: false, changed: false, message: "Electron isn't installed." };
  let iconBytes: Buffer;
  try {
    if (path.extname(icon).toLowerCase() !== (platform === "win32" ? ".ico" : ".icns") || !fs.statSync(icon).isFile()) throw new Error("not an icon file");
    iconBytes = fs.readFileSync(icon);
  } catch {
    return { ok: false, changed: false, message: "Floppy's icon isn't there." };
  }
  const key = `${e.version}:${createHash("sha256").update(iconBytes).digest("hex").slice(0, 16)}`;
  const keyFile = path.join(e.dir, "program.json");
  let made: string | undefined;
  try {
    made = (JSON.parse(fs.readFileSync(keyFile, "utf8")) as { key?: string }).key;
  } catch {
    // not named yet
  }
  const r = platform === "win32" ? await nameWindowsProgram(e, icon, made === key) : nameMacBundle(e, icon, made === key);
  if (r.ok && r.changed) fs.writeFileSync(keyFile, JSON.stringify({ key }) + "\n");
  return r;
}

async function nameWindowsProgram(e: ElectronInstall, icon: string, done: boolean): Promise<{ ok: boolean; changed: boolean; message: string }> {
  const named = path.join(e.dist, APP_PROGRAM.file);
  const original = path.join(e.dist, "electron.exe");
  const removeOriginal = () => {
    try {
      if (fs.existsSync(named)) fs.rmSync(original, { force: true });
    } catch {
      // an app window still runs from it; next time
    }
  };
  if (done && fs.existsSync(named)) {
    removeOriginal();
    return { ok: true, changed: false, message: "dx.exe is named." };
  }
  const rcedit = findRcedit(e.dir);
  if (!rcedit) return { ok: false, changed: false, message: "rcedit isn't installed." };
  const tmp = `${named}.tmp`;
  try {
    fs.copyFileSync(fs.existsSync(original) ? original : named, tmp);
    const r = await runLogged(rcedit, nameProgramArgs(tmp, icon), e.dist, undefined, false);
    if (!r.ok) throw new Error(`rcedit: ${r.last || "it failed"}`);
    fs.renameSync(tmp, named);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    const busy = ["EBUSY", "EPERM"].includes((err as NodeJS.ErrnoException).code ?? "");
    return { ok: false, changed: false, message: busy ? "Close dx and open it again to finish naming it." : `Couldn't name dx.exe: ${(err as Error).message}` };
  }
  removeOriginal();
  return { ok: true, changed: true, message: "dx.exe is named." };
}

function nameMacBundle(e: ElectronInstall, icon: string, done: boolean): { ok: boolean; changed: boolean; message: string } {
  const bundle = path.join(e.dist, APP_PROGRAM.bundle);
  if (done && fs.existsSync(bundle)) return { ok: true, changed: false, message: "dx.app is named." };
  try {
    // A running Electron.app carries on after the rename; nothing else starts it.
    if (!fs.existsSync(bundle)) fs.renameSync(path.join(e.dist, "Electron.app"), bundle);
    const plist = path.join(bundle, "Contents", "Info.plist");
    for (const [key, value] of macPlistValues()) {
      const r = spawnSync("/usr/bin/plutil", ["-replace", key, "-string", value, plist], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`plutil: ${(r.stderr || r.error?.message || "it failed").trim()}`);
    }
    fs.copyFileSync(icon, path.join(bundle, "Contents", "Resources", "dx.icns"));
    const sign = spawnSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle], { encoding: "utf8" });
    if (sign.status !== 0) throw new Error(`codesign: ${(sign.stderr || sign.error?.message || "it failed").trim().split("\n")[0]}`);
  } catch (err) {
    return { ok: false, changed: false, message: `Couldn't name dx.app: ${(err as Error).message}` };
  }
  return { ok: true, changed: true, message: "dx.app is named." };
}

// ------------------------------------------------------------ opening at sign-in, and launchers

/**
 * Where the app's sign-in entry goes: a shortcut in the Startup folder (Windows), a LaunchAgent
 * (macOS), an XDG autostart entry (Linux and the other Unixes).
 */
export function appSignInEntry(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (platform === "win32") {
    const dir = startupFolder(env);
    return dir ? path.join(dir, "dx.lnk") : undefined;
  }
  if (platform === "darwin") return path.join(home, "Library", "LaunchAgents", `${APP_PROGRAM.id}.plist`);
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "autostart", "dx.desktop");
}

/** The Start menu entry the app writes for itself on Windows (with its taskbar id, so a pin stays one icon). */
export function appStartMenuShortcut(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = startMenuFolder(env);
  return dir ? path.join(dir, "dx.lnk") : undefined;
}

/** The app's entry in Linux launchers (the applications menu, search), which also names its windows. */
export function appLauncherEntry(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || os.homedir();
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "applications", "dx.desktop");
}

export function appStartsAtSignIn(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const file = appSignInEntry(env, platform);
  return !!file && fs.existsSync(file);
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A macOS LaunchAgent that starts the app, minimised, when you sign in. */
export function launchAgentPlist(launch: ShortcutLaunch): string {
  const args = [launch.command, ...launch.args, "--minimized"].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${APP_PROGRAM.id}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    args,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/**
 * One argument of a desktop entry's Exec line: quoted when it needs to be, with ", `, $ and \ escaped
 * inside the quotes, then backslashes doubled again and % doubled for the file's own escaping (as
 * the Desktop Entry spec asks).
 */
export function desktopExecArg(arg: string): string {
  const quoted = /[\s"'\\><~|&;$*?#()`]/.test(arg) || arg === "" ? `"${arg.replace(/(["`$\\])/g, "\\$1")}"` : arg;
  return quoted.replace(/\\/g, "\\\\").replace(/%/g, "%%");
}

/** A desktop entry for the app: in the launchers, or (with `autostart`) at sign-in, minimised. */
export function desktopEntry(launch: ShortcutLaunch, options: { autostart?: boolean } = {}): string {
  const exec = [launch.command, ...launch.args, ...(options.autostart ? ["--minimized"] : [])].map(desktopExecArg).join(" ");
  const line = (s: string) => s.replace(/[\r\n]/g, " ");
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${APP_PROGRAM.name}`,
    "Comment=Your projects, dev servers and tools",
    `Exec=${line(exec)}`,
    ...(launch.icon ? [`Icon=${line(launch.icon)}`] : []),
    "Terminal=false",
    "Categories=Development;",
    `StartupWMClass=${APP_PROGRAM.name}`,
    ...(options.autostart ? ["X-GNOME-Autostart-enabled=true"] : []),
    "",
  ].join("\n");
}

/** Writes the Linux launcher entry (the app writes its own Start menu entry on Windows). */
export function writeAppLauncherEntry(launch: ShortcutLaunch, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32" || platform === "darwin") return;
  const file = appLauncherEntry(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, desktopEntry(launch));
}

/**
 * Adds or removes the app's sign-in entry. It starts the app minimised, so dx is one click away
 * without a window in your face at every sign-in.
 */
export function setAppStartup(on: boolean, launch?: ShortcutLaunch, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { ok: boolean; message: string } {
  const file = appSignInEntry(env, platform);
  if (!file) return { ok: false, message: "Couldn't find your Startup folder (APPDATA isn't set)." };
  if (!on) {
    fs.rmSync(file, { force: true });
    return { ok: true, message: "dx won't open when you sign in." };
  }
  if (!launch) return { ok: false, message: "The dx app isn't installed yet." };
  if (platform === "win32") {
    const r = writeShortcut(file, { ...launch, args: [...launch.args, "--minimized"] }, "dx");
    if (!r.ok) return { ok: false, message: r.message.replace("the shortcut", "the Startup shortcut") };
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, platform === "darwin" ? launchAgentPlist(launch) : desktopEntry(launch, { autostart: true }));
  }
  return { ok: true, message: "dx opens on your taskbar when you sign in." };
}

/**
 * Removes the app: its shortcuts and entries, then ~/.dx/app (Electron, the window's settings
 * and its browser data). `current` goes first and only as a link. Fails while the app is open on
 * Windows, which keeps its files locked.
 */
export function removeApp(env: NodeJS.ProcessEnv = process.env, home = appHome(), platform: NodeJS.Platform = process.platform): { ok: boolean; message: string } {
  const entries = [appSignInEntry(env, platform), platform === "win32" ? appStartMenuShortcut(env) : platform === "darwin" ? undefined : appLauncherEntry(env)];
  for (const file of entries) if (file) fs.rmSync(file, { force: true });
  try {
    removeLinkOnly(currentLink(home));
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 2 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, message: code === "EBUSY" || code === "EPERM" ? "Close the dx app first: its files are in use." : `Couldn't remove ${home}: ${(err as Error).message}` };
  }
  return { ok: true, message: "The dx app is removed. dx ui opens the dashboard in your browser now." };
}
