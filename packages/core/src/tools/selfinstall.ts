import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { killProcess } from "./ports.js";
import { listDevProcesses, type DevProcess } from "./background.js";

/**
 * Installing and switching the dx command itself.
 *
 * npm alone gets stuck: `npm install -g dx-devkit` fails with EEXIST while another install (the
 * repository's `npm run link`, or a broken earlier one) owns the `dx` shims, and on Windows an
 * install can't be replaced while a dx process still runs from it (EPERM / EBUSY). `dx update`
 * and `npm run link` / `unlink` stop the dashboard, remove the other install and the shims it
 * left, ask before stopping what still runs from it, and then install.
 */

export type DxInstallKind = "npm" | "local";

export interface DxInstalls {
  /** `npm root -g` */
  root: string;
  /** Where npm puts command shims. */
  binDir: string;
  /** dx-devkit from npm. */
  npm?: string;
  /** @dx/cli, linked from a clone of this repository (the folder it points at). */
  local?: string;
  /** `dx` shims that start an install that isn't there any more: they make npm say EEXIST. */
  strayShims: string[];
}

const win = process.platform === "win32";

/** npm with fixed arguments. npm.cmd runs through cmd.exe on Windows (Node won't start a .cmd itself). */
export function runNpm(args: string[], options: { quiet?: boolean; cwd?: string } = {}): { ok: boolean; out: string } {
  const [file, list] = win ? ["cmd.exe", ["/d", "/s", "/c", "npm", ...args]] : ["npm", args];
  const r = spawnSync(file, list, { cwd: options.cwd, encoding: "utf8", stdio: options.quiet ? "pipe" : "inherit", windowsHide: true });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** npm with fixed arguments, without waiting for it on the main thread (the dashboard asks while it serves other requests). */
function runNpmAsync(args: string[]): Promise<string> {
  const [file, list] = win ? ["cmd.exe", ["/d", "/s", "/c", "npm", ...args]] : ["npm", args];
  return new Promise((resolve) => execFile(file, list, { encoding: "utf8", windowsHide: true, timeout: 15_000 }, (_err, stdout, stderr) => resolve(`${stdout ?? ""}${stderr ?? ""}`)));
}

/** npm's global folders, both asked at once, for callers that mustn't hold the dashboard up. */
export async function npmGlobalDirsAsync(): Promise<{ root: string; binDir: string }> {
  const last = (out: string) => out.trim().split(/\r?\n/).pop() ?? "";
  const [root, prefix] = await Promise.all([runNpmAsync(["root", "-g"]).then(last), runNpmAsync(["prefix", "-g"]).then(last)]);
  return { root, binDir: win ? prefix : path.join(prefix, "bin") };
}

/** npm's global folders, asked once. */
export function npmGlobalDirs(): { root: string; binDir: string } {
  const last = (out: string) => out.trim().split(/\r?\n/).pop() ?? "";
  const root = last(runNpm(["root", "-g"], { quiet: true }).out);
  const prefix = last(runNpm(["prefix", "-g"], { quiet: true }).out);
  return { root, binDir: win ? prefix : path.join(prefix, "bin") };
}

/** findDxInstalls, asking npm without holding up the dashboard. */
export async function findDxInstallsAsync(): Promise<DxInstalls> {
  return findDxInstalls(await npmGlobalDirsAsync());
}

/** What's installed globally as dx, and the shims nothing owns any more. */
export function findDxInstalls(dirs: { root: string; binDir: string } = npmGlobalDirs()): DxInstalls {
  const npmDir = path.join(dirs.root, "dx-devkit");
  const localDir = path.join(dirs.root, "@dx", "cli");
  const out: DxInstalls = { ...dirs, strayShims: [] };
  if (fs.existsSync(path.join(npmDir, "package.json"))) out.npm = npmDir;
  if (fs.existsSync(path.join(localDir, "package.json"))) out.local = realOr(localDir);
  for (const name of ["dx", "dx.cmd", "dx.ps1"]) {
    const file = path.join(dirs.binDir, name);
    const target = shimTarget(file);
    if (!target) continue;
    const owner = target === "npm" ? out.npm : out.local;
    if (!owner) out.strayShims.push(file);
  }
  return out;
}

/** Which dx install a shim starts ("npm" or "local"), or undefined when it isn't one of dx's. */
export function shimTarget(file: string): DxInstallKind | undefined {
  let text: string;
  try {
    text = fs.lstatSync(file).isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file, "utf8").slice(0, 4096);
  } catch {
    return undefined;
  }
  if (/node_modules[\\/]dx-devkit[\\/]/.test(text)) return "npm";
  if (/node_modules[\\/]@dx[\\/]cli[\\/]|packages[\\/]cli[\\/]dist[\\/]/.test(text)) return "local";
  return undefined;
}

/** Processes started from inside `dir`: an old dashboard, dx's MCP servers in AI tools. Never this process. */
export async function processesRunningFrom(dir: string): Promise<DevProcess[]> {
  const wanted = [norm(dir), norm(realOr(dir))];
  const list = await listDevProcesses({ ownerPids: [process.pid] }).catch(() => [] as DevProcess[]);
  return list.filter((p) => p.pid !== process.pid && wanted.some((w) => norm(p.command).includes(w)));
}

export interface SwitchOptions {
  /** The repository to link, for "local". */
  repo?: string;
  /** Asked before stopping processes that run from an install being replaced. No answer means no. */
  confirm?: (processes: DevProcess[]) => Promise<boolean>;
  log?: (line: string) => void;
  /** Stops the dashboard first (it runs from the install). */
  stopDashboard?: () => Promise<void> | void;
}

export interface SwitchResult {
  ok: boolean;
  /** `dx --version` of the global dx afterwards. */
  version?: string;
  message: string;
}

/** Makes the global dx the npm package (latest) or the repository's build, whatever was there before. */
export async function switchDx(kind: DxInstallKind, options: SwitchOptions = {}): Promise<SwitchResult> {
  const log = options.log ?? (() => undefined);
  if (kind === "local" && !options.repo) return { ok: false, message: "Which repository? Run this from your dx-toolkit folder." };
  await options.stopDashboard?.();
  const before = findDxInstalls();

  const stopFrom = async (dir: string) => {
    const procs = await processesRunningFrom(dir);
    if (!procs.length) return;
    log(`${procs.length} process(es) still run dx from ${dir}:`);
    for (const p of procs) log(`  PID ${p.pid}  ${p.label}${p.startedBy ? ` (started by ${p.startedBy})` : ""}`);
    if (!(await options.confirm?.(procs))) {
      if (win) log("Left running. If npm fails with EPERM or EBUSY, close those tools and try again.");
      return;
    }
    for (const p of procs) log(`  ${(await killProcess(p.pid)).message}`);
  };

  // The other install goes, after what still runs from it.
  const other = kind === "npm" ? before.local : before.npm;
  if (other) {
    if (kind === "local") await stopFrom(other);
    const name = kind === "npm" ? "@dx/cli" : "dx-devkit";
    log(`Removing ${name}…`);
    runNpm(["uninstall", "-g", name], { quiet: true });
    if (kind === "npm") removeLink(path.join(before.root, "@dx", "cli"));
    else removeDir(path.join(before.root, "dx-devkit"));
  }
  // Updating the npm package replaces its files; a link replaces nothing.
  if (kind === "npm" && before.npm) await stopFrom(before.npm);

  // Shims nothing owns now: the cause of EEXIST.
  const after = findDxInstalls({ root: before.root, binDir: before.binDir });
  for (const file of [...after.strayShims, ...shimsOf(before.binDir, kind === "npm" ? "local" : "npm")]) {
    try {
      fs.rmSync(file, { force: true });
      log(`Removed the leftover ${path.basename(file)} shim.`);
    } catch {
      // gone already
    }
  }
  removeIfEmpty(path.join(before.root, "@dx"));

  const target = kind === "local" ? "./packages/cli" : "dx-devkit@latest";
  log(`npm install -g ${target}`);
  const install = runNpm(["install", "-g", target], { cwd: options.repo });
  if (!install.ok) return { ok: false, message: "npm couldn't install dx. Close terminals and AI tools that use dx, then try again." };

  const shim = path.join(before.binDir, win ? "dx.cmd" : "dx");
  const run = win ? spawnSync("cmd.exe", ["/d", "/s", "/c", shim, "--version"], { encoding: "utf8", windowsHide: true }) : spawnSync(shim, ["--version"], { encoding: "utf8" });
  const version = run.status === 0 ? run.stdout.trim() : undefined;
  if (!version) return { ok: false, message: `Installed, but ${shim} didn't run. Open a new terminal and try dx --version.` };
  return { ok: true, version, message: `dx ${version} now runs ${kind === "local" ? "this folder's build" : "the npm package"}.` };
}

function shimsOf(binDir: string, kind: DxInstallKind): string[] {
  return ["dx", "dx.cmd", "dx.ps1"].map((f) => path.join(binDir, f)).filter((f) => shimTarget(f) === kind);
}

function realOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function norm(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** The npm package's own folder, left behind by a failed uninstall. Never a link: that would reach into what it points at. */
export function removeInstallDir(dir: string): void {
  removeDir(dir);
}

/** The link to a repository: only the link goes, never anything inside it. */
export function removeInstallLink(link: string): void {
  removeLink(link);
}

/** A folder, only when nothing is left in it. */
export function removeFolderIfEmpty(dir: string): void {
  removeIfEmpty(dir);
}

function removeDir(dir: string): void {
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return removeLink(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // not there
  }
}

/** The link to a repository (a junction on Windows): only the link goes, never anything inside it. */
function removeLink(link: string): void {
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return;
  } catch {
    return;
  }
  try {
    fs.unlinkSync(link);
  } catch {
    try {
      fs.rmdirSync(link); // a junction, removed without touching its target
    } catch {
      // left for npm
    }
  }
}

function removeIfEmpty(dir: string): void {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    // not there, or not empty
  }
}
