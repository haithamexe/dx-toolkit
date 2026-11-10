import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dxHome } from "../config.js";
import { defaultAiEnv, disconnectAiTools, listAiTools, type AiEnv } from "./aiSetup.js";
import { appHome, appLauncherEntry, appSignInEntry, appStartMenuShortcut, listElectrons, removeApp } from "./appshell.js";
import { floppyShortcutPath } from "./floppy.js";
import { killProcess } from "./ports.js";
import { findDxInstalls, npmGlobalDirsAsync, removeFolderIfEmpty, removeInstallDir, removeInstallLink, runNpm } from "./selfinstall.js";
import { listSnapshots, removeSnapshot } from "./snapshots.js";

/**
 * Removing dx from this computer, every kind and version of it: the npm package and a linked build
 * of the repository (only the link: the repository stays), the `dx` and `dx-mcp` shims, the dx app
 * with every Electron version it installed, the shortcuts and sign-in entries, Floppy, dx's place in
 * AI tools, and everything still running from any of them. With `data`, ~/.dx goes too (snapshot
 * worktrees removed through git first).
 *
 * The dashboard runs from the install it removes, so the work is done by a copy of core in a temp
 * folder (`startUninstall`), which waits for the dashboard to close and then carries on alone.
 */

export interface ProcessRow {
  pid: number;
  ppid: number;
  name: string;
  command: string;
}

export interface UninstallEnv {
  /** npm's global folders. */
  dirs?: { root: string; binDir: string };
  npm?: (args: string[]) => { ok: boolean; out: string };
  /** Every process with its command line. */
  processes?: () => Promise<ProcessRow[]>;
  /** Stops a process, with its children when `tree`. */
  stop?: (pid: number, tree: boolean) => Promise<boolean>;
  alive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  ai?: AiEnv;
  /** Where the Startup, Start menu and launcher folders are. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  appHome?: string;
  /** This process: it and the processes that started it are never stopped. */
  self?: number;
}

export interface UninstallPlan {
  installs: Array<{ kind: "npm" | "local"; dir: string; version?: string }>;
  /** `dx` and `dx-mcp` shims that start dx. */
  shims: string[];
  app?: { dir: string; versions: string[] };
  /** Shortcuts and sign-in entries that exist. */
  entries: string[];
  /** AI tools dx is connected to. */
  aiTools: string[];
  /** What still runs from dx, besides this process. */
  processes: Array<{ pid: number; what: string }>;
  data: { dir: string; bytes: number; snapshots: number };
  /** Why it can't run here. */
  blocked?: string;
}

export interface UninstallResult {
  ok: boolean;
  removed: string[];
  /** What couldn't be removed, with why. */
  left: string[];
}

const SHIM_NAMES = ["dx", "dx.cmd", "dx.ps1", "dx-mcp", "dx-mcp.cmd", "dx-mcp.ps1"];

/** With DX_HOME set, dx is a test or demo copy: removing it means deleting that folder, never the computer's dx. */
export function uninstallBlocked(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.DX_HOME ? "DX_HOME is set, so this is a test or demo copy of dx. Delete that folder instead; dx's own install isn't touched from here." : undefined;
}

/** Everything with its default; npm's folders asked without holding up the dashboard. */
async function resolved(e: UninstallEnv) {
  return {
    dirs: e.dirs ?? (await npmGlobalDirsAsync()),
    npm: e.npm ?? ((args: string[]) => runNpm(args, { quiet: true })),
    processes: e.processes ?? listProcesses,
    stop: e.stop ?? stopProcess,
    alive: e.alive ?? isAlive,
    sleep: e.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    ai: e.ai ?? defaultAiEnv(),
    env: e.env ?? process.env,
    platform: e.platform ?? process.platform,
    appHome: e.appHome ?? appHome(),
    self: e.self ?? process.pid,
  };
}

/**
 * Where dx's programs live: the installs (for a linked build, the repository's built packages), the
 * app's folder and dx's own folder. Each with a trailing slash, so ~/.dx never matches ~/.dx-other.
 */
export interface DxPlaces {
  code: string[];
  app: string;
  home: string;
}

function dxPlaces(installs: ReturnType<typeof findDxInstalls>, home: string): DxPlaces {
  const code: string[] = [];
  if (installs.npm) code.push(installs.npm);
  if (installs.local) {
    code.push(path.join(installs.root, "@dx", "cli"));
    const repo = repoOf(installs.local);
    if (repo) code.push(...["web/dist", "web/shell", "mcp/dist", "cli/dist"].map((p) => path.join(repo, "packages", p)), path.join(repo, "node_modules", "@dx"));
    else code.push(installs.local);
  }
  return { code: code.map(slashed), app: slashed(home), home: slashed(dxHome()) };
}

const slashed = (f: string) => norm(f).replace(/\/+$/, "") + "/";

/** The repository a linked @dx/cli points at (its packages/cli folder). */
function repoOf(cliDir: string): string | undefined {
  const parent = path.dirname(cliDir);
  return path.basename(cliDir) === "cli" && path.basename(parent) === "packages" ? path.dirname(parent) : undefined;
}

/**
 * A program dx runs, judged by the program and what it runs, never by a path anywhere on its command
 * line: an editor with a file of ~/.dx open, or a terminal tailing dx's run log, isn't dx and is
 * left alone (stopping it would take its windows and children too).
 */
export function isDxProcess(row: ProcessRow, places: DxPlaces): boolean {
  const name = path.posix.basename(norm(row.name || row.command.split(" ")[0] || "")).replace(/\.exe$/, "");
  const c = norm(row.command);
  if (name === "node" || name === "bun") return places.code.some((f) => c.includes(f));
  if (name === "dx" || name === "electron") return c.includes(places.app);
  if (/^(chrome|msedge|brave|chromium|chromium-browser|google-chrome)$/.test(name)) return c.includes("--user-data-dir") && c.includes(`${places.home}browser-profile`);
  if (name === "powershell" || name === "pwsh") return c.includes(`${places.home}floppy/`);
  return false;
}

/** The process and the ones that started it. */
function ancestors(rows: ProcessRow[], pid: number): Set<number> {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const out = new Set<number>([pid]);
  let cur = byPid.get(pid);
  for (let i = 0; cur && i < 64; i++) {
    if (out.has(cur.ppid) || cur.ppid <= 0) break;
    out.add(cur.ppid);
    cur = byPid.get(cur.ppid);
  }
  return out;
}

/** The processes a process started directly. */
function childrenOf(rows: ProcessRow[], pid: number): ProcessRow[] {
  return rows.filter((r) => r.ppid === pid && r.pid !== pid);
}

/** Processes running from dx, never this one or what started it. */
function dxProcesses(rows: ProcessRow[], places: DxPlaces, self: number): ProcessRow[] {
  const keep = ancestors(rows, self);
  return rows.filter((r) => !keep.has(r.pid) && r.command && isDxProcess(r, places));
}

/** What a dx process is, in words. */
export function describeDxProcess(command: string): string {
  const c = norm(command);
  if (/\/web\/dist\/(background|server|index)\.js/.test(c)) return "the dashboard";
  if (/\/mcp\/dist\/|dx-mcp/.test(c)) return "an AI tool's dx server";
  if (/floppy/.test(c)) return "Floppy";
  if (/browser-profile/.test(c)) return "the dx browser";
  if (/\/\.dx\/app\/|\/shell(["\s]|$)/.test(c)) return "the dx app";
  if (/\/cli\/dist\/|dx-devkit\/dist\/index\.js/.test(c)) return "a dx command";
  return "a dx process";
}

/** What would be removed. Reads only. */
export async function planUninstall(e: UninstallEnv = {}): Promise<UninstallPlan> {
  const r = await resolved(e);
  const installs = findDxInstalls(r.dirs);
  const plan: UninstallPlan = { installs: [], shims: [], entries: [], aiTools: [], processes: [], data: { dir: dxHome(), bytes: 0, snapshots: 0 }, blocked: uninstallBlocked() };
  if (installs.npm) plan.installs.push({ kind: "npm", dir: installs.npm, version: versionOf(installs.npm) });
  if (installs.local) plan.installs.push({ kind: "local", dir: repoOf(installs.local) ?? installs.local, version: versionOf(installs.local) });
  plan.shims = dxShims(r.dirs.binDir, installs);
  if (fs.existsSync(r.appHome)) plan.app = { dir: r.appHome, versions: [...new Set(listElectrons(r.appHome, r.platform).map((x) => x.version))] };
  plan.entries = entryFiles(r.env, r.platform).filter((f) => fs.existsSync(f));
  plan.aiTools = (await listAiTools(r.ai).catch(() => [])).filter((t) => t.connected).map((t) => t.name);
  const rows = await r.processes().catch(() => [] as ProcessRow[]);
  plan.processes = dxProcesses(rows, dxPlaces(installs, r.appHome), r.self).map((p) => ({ pid: p.pid, what: describeDxProcess(p.command) }));
  plan.data = { dir: dxHome(), bytes: await folderSize(dxHome()), snapshots: listSnapshots().length };
  return plan;
}

/** Removes dx. `waitFor` is a process to let close first (the dashboard that asked). */
export async function runUninstall(options: { data: boolean; waitFor?: number; log?: (line: string) => void; env?: UninstallEnv }): Promise<UninstallResult> {
  const r = await resolved(options.env ?? {});
  const log = options.log ?? (() => undefined);
  const removed: string[] = [];
  const left: string[] = [];
  const installs = findDxInstalls(r.dirs);
  const places = dxPlaces(installs, r.appHome);
  const shims = dxShims(r.dirs.binDir, installs);

  // The dashboard that asked closes by itself (its dev servers with it); it started this process, so it isn't stopped as a tree.
  if (options.waitFor && options.waitFor !== r.self) {
    for (let i = 0; i < 300 && r.alive(options.waitFor); i++) await r.sleep(200);
    if (r.alive(options.waitFor)) {
      // What it still runs (dev servers, a stack's processes) goes first, each with its children, never
      // this process; then the dashboard alone, since stopping it as a tree would take this process too.
      log(`The dashboard (PID ${options.waitFor}) didn't close in a minute; stopping it and what it runs.`);
      const rows = await r.processes().catch(() => [] as ProcessRow[]);
      for (const child of childrenOf(rows, options.waitFor).filter((x) => x.pid !== r.self)) await r.stop(child.pid, true);
      await r.stop(options.waitFor, false);
    }
  }

  // AI tools first, so none starts dx again while it goes.
  for (const t of await disconnectAiTools(undefined, r.ai).catch((err) => [{ name: "AI tools", ok: false, message: (err as Error).message }])) {
    (t.ok ? removed : left).push(t.ok ? `dx in ${t.name}` : `dx in ${t.name}: ${t.message}`);
    log(`${t.name}: ${t.message}`);
  }

  const stopAll = async () => {
    const procs = dxProcesses(await r.processes().catch(() => [] as ProcessRow[]), places, r.self);
    for (const p of procs) {
      const ok = await r.stop(p.pid, true);
      log(`${ok ? "Stopped" : "Couldn't stop"} ${describeDxProcess(p.command)} (PID ${p.pid}).`);
    }
    return procs.length;
  };
  // Twice: a process can start another on its way out (an AI tool's server starting the dashboard).
  if (await stopAll()) {
    await r.sleep(1000);
    await stopAll();
  }

  // The app: its shortcuts and entries, then ~/.dx/app with every Electron version.
  if (fs.existsSync(r.appHome) || entryFiles(r.env, r.platform).some((f) => fs.existsSync(f))) {
    let app = removeApp(r.env, r.appHome, r.platform);
    if (!app.ok) {
      await stopAll();
      await r.sleep(1000);
      app = removeApp(r.env, r.appHome, r.platform);
    }
    (app.ok ? removed : left).push(app.ok ? "the dx app" : app.message);
    log(app.ok ? "Removed the dx app and its shortcuts." : app.message);
  }
  if (r.platform === "win32") {
    const floppy = floppyShortcutPath(r.env);
    if (floppy && fs.existsSync(floppy)) {
      fs.rmSync(floppy, { force: true });
      removed.push("Floppy's Startup shortcut");
      log("Removed Floppy's Startup shortcut.");
    }
  }

  // The installs. A linked build loses its link only: the repository stays as it is.
  if (installs.npm) {
    const name = `dx-devkit ${versionOf(installs.npm) ?? ""}`.trim();
    r.npm(["uninstall", "-g", "dx-devkit"]);
    removeInstallDir(installs.npm);
    report(installs.npm, name);
  }
  if (installs.local) {
    const link = path.join(installs.root, "@dx", "cli");
    removeInstallLink(link);
    report(link, `the link to your build in ${repoOf(installs.local) ?? installs.local}`);
    removeFolderIfEmpty(path.join(installs.root, "@dx"));
  }
  for (const shim of shims) {
    try {
      fs.rmSync(shim, { force: true });
      removed.push(`the ${path.basename(shim)} shim`);
    } catch (err) {
      left.push(`${shim}: ${(err as Error).message}`);
    }
  }

  // What dx keeps.
  if (options.data) {
    for (const s of listSnapshots()) {
      try {
        await removeSnapshot(s.id);
        log(`Removed the snapshot of ${s.project} (its worktree, through git).`);
      } catch (err) {
        left.push(`the snapshot of ${s.project} at ${s.path}: ${(err as Error).message}. Run git worktree prune in ${s.repo}`);
      }
    }
    const home = dxHome();
    const why = unsafeDataDir(home);
    if (why) left.push(why);
    else {
      try {
        fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
        removed.push(home);
        log(`Removed ${home}.`);
      } catch (err) {
        left.push(`${home}: ${(err as Error).message}`);
      }
    }
  } else {
    // Only what describes a dx that's gone; settings, history and the rest stay.
    for (const f of ["dashboard.json", "dashboard.lock", path.join("floppy", "floppy.json")]) fs.rmSync(path.join(dxHome(), f), { recursive: true, force: true });
  }

  for (const line of left) log(`Left: ${line}`);
  return { ok: left.length === 0, removed, left };

  function report(dir: string, name: string) {
    if (fs.existsSync(dir)) {
      left.push(`${name}: still at ${dir}. Close what runs dx and delete it.`);
      log(`Couldn't remove ${name} (${dir}).`);
    } else {
      removed.push(name);
      log(`Removed ${name}.`);
    }
  }
}

/** Why a folder mustn't be deleted as dx's data, or undefined when it may. */
export function unsafeDataDir(dir: string): string | undefined {
  const abs = path.resolve(dir);
  const home = path.resolve(os.homedir());
  const inside = (child: string, parent: string) => {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  if (path.parse(abs).root === abs) return `${abs} is a drive's root; dx won't delete it.`;
  if (inside(home, abs)) return `${abs} holds your home folder; dx won't delete it.`;
  return undefined;
}

/**
 * Starts the removal in a process of its own, from a copy of core in a temp folder, since the
 * install it removes may be the one running. Returns at once; the log is written as it goes.
 */
export function startUninstall(options: { data: boolean; waitFor?: number; foreground?: boolean; from?: "web" | "cli" }): { log: string; status?: number } {
  const dist = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dx-uninstall-"));
  const core = path.join(tmp, "core");
  fs.cpSync(dist, core, { recursive: true, filter: (src) => !/[\\/]__tests__([\\/]|$)/.test(src) && !src.endsWith(".map") && !src.endsWith(".d.ts") });
  fs.writeFileSync(path.join(core, "package.json"), '{ "type": "module" }\n');
  const log = path.join(tmp, "uninstall.log");
  const args = [path.join(core, "uninstallRunner.js"), "--log", log, ...(options.data ? ["--data"] : []), ...(options.waitFor ? ["--wait", String(options.waitFor)] : []), "--from", options.from ?? "cli"];
  if (options.foreground) {
    const r = spawnSync(process.execPath, args, { cwd: tmp, stdio: "inherit", windowsHide: true });
    return { log, status: r.status ?? 1 };
  }
  const child = spawn(process.execPath, args, { cwd: tmp, detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return { log };
}

// ------------------------------------------------------------ helpers

function entryFiles(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const files = [appSignInEntry(env, platform)];
  if (platform === "win32") files.push(appStartMenuShortcut(env), floppyShortcutPath(env));
  else if (platform !== "darwin") files.push(appLauncherEntry(env));
  return files.filter((f): f is string => !!f);
}

/**
 * The dx and dx-mcp shims that start dx: dx-devkit, the @dx/cli link, or the linked repository's
 * own packages/cli (never another project's linked CLI that happens to be called dx).
 */
function dxShims(binDir: string, installs: ReturnType<typeof findDxInstalls>): string[] {
  const repo = installs.local ? repoOf(installs.local) : undefined;
  return SHIM_NAMES.map((n) => path.join(binDir, n)).filter((f) => {
    let text: string;
    try {
      text = norm(fs.lstatSync(f).isSymbolicLink() ? fs.readlinkSync(f) : fs.readFileSync(f, "utf8").slice(0, 4096));
    } catch {
      return false;
    }
    return /node_modules\/(dx-devkit|@dx\/cli)\//.test(text) || (!!repo && text.includes(`${slashed(repo)}packages/cli/dist/`));
  });
}

function versionOf(dir: string): string | undefined {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

function norm(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** Bytes in a folder, without following links (snapshots link node_modules). */
async function folderSize(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    let items: fs.Dirent[];
    try {
      items = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isSymbolicLink()) continue;
      if (it.isDirectory()) await walk(p);
      else if (it.isFile()) total += (await fs.promises.lstat(p).catch(() => ({ size: 0 }))).size;
    }
  };
  await walk(dir);
  return total;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function stopProcess(pid: number, tree: boolean): Promise<boolean> {
  if (tree) return (await killProcess(pid)).ok;
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
}

/** Every process with its command line: one CIM query on Windows, ps elsewhere. */
export function listProcesses(): Promise<ProcessRow[]> {
  if (process.platform === "win32") {
    const script = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\nGet-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = $_.ProcessId; q = $_.ParentProcessId; n = $_.Name; c = $_.CommandLine } } | ConvertTo-Json -Compress";
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return new Promise((resolve) =>
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (_err, stdout) => {
        try {
          const raw = JSON.parse(stdout || "[]") as Array<{ p: number; q: number; n: string; c: string | null }> | { p: number; q: number; n: string; c: string | null };
          resolve((Array.isArray(raw) ? raw : [raw]).map((x) => ({ pid: x.p, ppid: x.q, name: x.n ?? "", command: x.c ?? "" })));
        } catch {
          resolve([]);
        }
      }),
    );
  }
  return new Promise((resolve) =>
    execFile("ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "args="], { timeout: 15_000, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (_err, stdout) => {
      const rows: ProcessRow[] = [];
      for (const line of (stdout ?? "").split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name: path.basename(m[3].split(" ")[0] ?? ""), command: m[3] });
      }
      resolve(rows);
    }),
  );
}
