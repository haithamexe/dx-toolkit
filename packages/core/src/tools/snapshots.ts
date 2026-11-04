import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dxPath, ensureDxHome } from "../config.js";
import { commandExists } from "./doctor.js";
import { findEnvFiles, isExampleFile } from "./envaudit.js";
import { GIT_LOG_FORMAT, GitError, gitFailure, gitRoot, gitRun, parseCommitLog, type GitCommit } from "./git.js";
import { detectPackageManager, readProject, type PackageManager, type Project } from "./projects.js";

/**
 * Running a project as it was at any commit, next to your own checkout: a detached git worktree
 * under ~/.dx/snapshots, with its packages linked from the project when the lock file is the
 * same (or installed when it isn't), and the project's own .env files copied in. Your working
 * copy, branch and index are never touched; removing a snapshot deletes only its folder.
 */

export interface Snapshot {
  /** Its folder's name under ~/.dx/snapshots: shop-website-abc1234. */
  id: string;
  /** How it's shown and run: shop-website@abc1234. */
  name: string;
  /** The project it was taken from. */
  project: string;
  projectDir: string;
  /** The project's repository top folder, where `git worktree` is run. */
  repo: string;
  hash: string;
  short: string;
  subject: string;
  /** Commit time, ms. */
  at: number;
  /** The worktree's folder. */
  path: string;
  /** The project's folder inside it: `path`, unless the project is a subfolder of its repository. */
  dir: string;
  createdAt: string;
  /** How node_modules got there: linked from the project (same lock file), installed, or not needed. */
  packages: "linked" | "installed" | "failed" | "none";
  /** node_modules links in the snapshot: removed as links, never followed. */
  links: string[];
  /** .env files copied from the project. */
  envFiles: string[];
}

export interface CommitMatch extends GitCommit {
  /** What matched: the message, the hash, the author, or a file it changed. */
  matched: ("message" | "hash" | "author" | "file")[];
  /** The files it changed whose path has the search words in it. */
  files?: string[];
}

export interface InstallCommand {
  label: string;
  command: string;
  args: string[];
  cwd: string;
  shell: boolean;
}

export interface SnapshotOptions {
  /** Called as each step starts, for progress. */
  onStep?: (step: string) => void;
  /** Called with each line the install prints. */
  onOutput?: (line: string) => void;
  /** Runs the install; tests pass a fake. */
  runInstall?: (cmd: InstallCommand, onOutput?: (line: string) => void) => Promise<{ ok: boolean; output: string }>;
}

const FILE = "snapshots.json";
const SEARCH_FILES_OVER = 2000;
const LOCKS = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"];
const ENV_MAX = 256 * 1024;

type Store = Record<string, Snapshot>;

/** The folder every snapshot lives in. */
export function snapshotsRoot(): string {
  return dxPath("snapshots");
}

function same(a: string, b: string): boolean {
  return process.platform === "linux" ? path.resolve(a) === path.resolve(b) : path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/** True when `p` is a folder inside ~/.dx/snapshots (not the folder itself). */
function insideRoot(p: string): boolean {
  const rel = path.relative(snapshotsRoot(), path.resolve(p));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function load(): Store {
  try {
    const raw = JSON.parse(fs.readFileSync(dxPath(FILE), "utf8")) as Store;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function save(store: Store): void {
  ensureDxHome();
  const tmp = dxPath(`${FILE}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, dxPath(FILE));
}

/** "shop-website" at abc1234… → "shop-website-abc1234". */
export function snapshotId(project: string, hash: string): string {
  const base = project.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "project";
  return `${base.slice(0, 60)}-${hash.slice(0, 7)}`;
}

function checkHash(hash: unknown): string {
  if (typeof hash !== "string" || !/^[0-9a-f]{4,40}$/i.test(hash)) throw new GitError("Which commit? Give its hash (4 to 40 hex characters).");
  return hash.toLowerCase();
}

/** A hash (or a prefix of one) as the commit it names, or a 404 when the repository has none. */
export async function resolveCommit(dir: string, hash: string): Promise<GitCommit & { root: string }> {
  const rev = checkHash(hash);
  const root = await gitRoot(dir);
  const r = await gitRun(root, ["rev-parse", "--verify", "-q", `${rev}^{commit}`]);
  const oid = r.stdout.trim();
  if (r.code !== 0 || !/^[0-9a-f]{40,64}$/.test(oid)) throw new GitError("That commit isn't in this repository.", 404);
  const [commit] = await showCommits(root, [oid]);
  if (!commit) throw new GitError("That commit isn't in this repository.", 404);
  return { ...commit, root };
}

async function showCommits(root: string, oids: string[]): Promise<GitCommit[]> {
  if (!oids.length) return [];
  const r = await gitRun(root, ["show", "-s", "--decorate=full", `--format=${GIT_LOG_FORMAT}`, ...oids, "--"]);
  return r.code === 0 ? parseCommitLog(r.stdout) : [];
}

// ------------------------------------------------------------------ search

/**
 * Commits on any branch, remote branch or tag whose message, hash, author or changed files
 * match `query`: words, not patterns (fixed strings, any case). Newest first.
 */
export async function searchCommits(dir: string, query: string, options: { limit?: number } = {}): Promise<CommitMatch[]> {
  const q = query.trim().slice(0, 200);
  const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 50)));
  if (!q) return [];
  const root = await gitRoot(dir);
  const range = ["--branches", "--remotes", "--tags", "HEAD"];
  const log = (args: string[]) => gitRun(root, ["log", ...range, "--topo-order", "--decorate=full", `--format=${GIT_LOG_FORMAT}`, ...args, "--"]);
  const isHash = /^[0-9a-f]{4,40}$/i.test(q);
  const [message, author, files, hash] = await Promise.all([
    log(["-i", "--fixed-strings", `--grep=${q}`, `-n${limit}`]),
    log(["-i", "--fixed-strings", `--author=${q}`, `-n${limit}`]),
    gitRun(root, ["log", ...range, "--topo-order", `-n${SEARCH_FILES_OVER}`, "--name-only", "--format=%x1d%H", "--"]),
    isHash ? gitRun(root, ["rev-parse", "--verify", "-q", `${q.toLowerCase()}^{commit}`]) : undefined,
  ]);
  // A repository with no commits: nothing to find.
  if (message.code !== 0 && author.code !== 0 && files.code !== 0) return [];

  const found = new Map<string, CommitMatch>();
  const add = (c: GitCommit, kind: CommitMatch["matched"][number]) => {
    const m = found.get(c.hash) ?? found.set(c.hash, { ...c, matched: [] }).get(c.hash)!;
    if (!m.matched.includes(kind)) m.matched.push(kind);
    return m;
  };
  if (message.code === 0) for (const c of parseCommitLog(message.stdout)) add(c, "message");
  if (author.code === 0) for (const c of parseCommitLog(author.stdout)) add(c, "author");

  // Files and hash prefixes over the newest commits; the commits themselves are read after.
  const byFile = new Map<string, string[]>();
  const byHash: string[] = [];
  const needle = q.toLowerCase();
  if (files.code === 0) {
    for (const record of files.stdout.split("\x1d")) {
      const [first, ...rest] = record.split(/\r?\n/);
      const oid = first.trim();
      if (!/^[0-9a-f]{40,64}$/.test(oid)) continue;
      if (isHash && oid.startsWith(needle)) byHash.push(oid);
      const hits = rest.map((l) => l.trim()).filter((l) => l && l.toLowerCase().includes(needle));
      if (hits.length) byFile.set(oid, hits.slice(0, 20));
    }
  }
  const exact = hash && hash.code === 0 ? hash.stdout.trim() : "";
  if (exact && !byHash.includes(exact)) byHash.unshift(exact);
  const missing = [...new Set([...byHash, ...byFile.keys()])].filter((h) => !found.has(h)).slice(0, limit * 2);
  for (const c of await showCommits(root, missing)) found.set(c.hash, { ...c, matched: [] });
  for (const oid of byHash) {
    const m = found.get(oid);
    if (m && !m.matched.includes("hash")) m.matched.unshift("hash");
  }
  for (const [oid, hits] of byFile) {
    const m = found.get(oid);
    if (!m) continue;
    if (!m.matched.includes("file")) m.matched.push("file");
    m.files = hits;
  }
  return [...found.values()]
    .filter((m) => m.matched.length)
    .sort((a, b) => Number(b.matched.includes("hash")) - Number(a.matched.includes("hash")) || b.at - a.at)
    .slice(0, limit);
}

// ------------------------------------------------------------------ time travel

export interface CommitAtTime extends GitCommit {
  /** "reflog" when HEAD's own record says so; "history" when it's the branch's last commit before then. */
  from: "reflog" | "history";
  /** When HEAD moved there, ms (from the reflog). */
  since?: number;
}

/** The commit HEAD was on at `atMs`: the newest reflog entry at or before then, else the last commit before then. */
export async function commitAt(dir: string, atMs: number): Promise<CommitAtTime | undefined> {
  if (!Number.isFinite(atMs) || atMs <= 0) throw new GitError("Which moment? Give a time in ms.");
  const root = await gitRoot(dir);
  const at = Math.floor(atMs / 1000);
  const reflog = await gitRun(root, ["log", "-g", "--date=unix", "--format=%H%x1f%gd", "-n5000", "HEAD", "--"]);
  if (reflog.code === 0) {
    for (const line of reflog.stdout.split(/\r?\n/)) {
      const [oid, selector] = line.split("\x1f");
      const t = Number(/@\{(\d+)\}$/.exec(selector ?? "")?.[1]);
      if (!oid || !Number.isFinite(t) || t > at) continue;
      const [c] = await showCommits(root, [oid.trim()]);
      if (c) return { ...c, from: "reflog", since: t * 1000 };
      break;
    }
  }
  const before = await gitRun(root, ["rev-list", "-1", `--before=${at}`, "HEAD", "--"]);
  const oid = before.stdout.trim();
  if (before.code !== 0 || !oid) return undefined;
  const [c] = await showCommits(root, [oid]);
  return c && { ...c, from: "history" };
}

// ------------------------------------------------------------------ snapshots

/** Registered snapshots whose folder is still there, newest first. Ones whose folder is gone are dropped. */
export function listSnapshots(): Snapshot[] {
  const store = load();
  let changed = false;
  for (const [id, s] of Object.entries(store)) {
    if (!s || !insideRoot(s.path) || !fs.existsSync(s.path)) {
      delete store[id];
      changed = true;
    }
  }
  if (changed) {
    try {
      save(store);
    } catch {
      // the list is still right; the file is tidied next time
    }
  }
  return Object.values(store).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The registered snapshot whose project folder is `dir`: only those are run like projects. */
export function snapshotByDir(dir: string): Snapshot | undefined {
  if (!dir || !insideRoot(dir)) return undefined;
  return listSnapshots().find((s) => same(s.dir, dir));
}

/** A snapshot as a project to run: its own folder, named shop-website@abc1234. */
export function snapshotProject(s: Snapshot): Project | undefined {
  const p = readProject(s.dir, path.dirname(s.dir));
  return p && { ...p, name: s.name };
}

function realPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Checks out `hash` of the project in its own folder under ~/.dx/snapshots (reused when it's
 * already there at that commit), gets its packages ready and copies the project's .env files in.
 */
export async function createSnapshot(project: Pick<Project, "name" | "dir">, hash: string, options: SnapshotOptions = {}): Promise<Snapshot> {
  const c = await resolveCommit(project.dir, hash);
  const id = snapshotId(project.name, c.hash);
  const wt = path.join(snapshotsRoot(), id);
  // Real paths on both sides: a folder can be named two ways on Windows (C:\Users\RUNNER~1 and
  // C:\Users\runneradmin), and git always gives the long one.
  const rel = path.relative(realPath(c.root), realPath(project.dir));
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new GitError("The project isn't inside its repository.");
  const store = load();
  const existing = store[id];
  if (existing && fs.existsSync(existing.dir) && (await headOf(existing.path)) === c.hash) {
    if (existing.packages !== "failed") return existing;
    // The install failed last time: try it again in the same folder.
    await preparePackages(existing, path.resolve(project.dir), options);
    const latest = load();
    latest[id] = existing;
    save(latest);
    return existing;
  }

  // Something left at that place (a run that broke half way): cleared first, links unlinked.
  if (fs.existsSync(wt) || existing) await removeFolder(existing ?? { path: wt, dir: rel ? path.join(wt, rel) : wt, repo: c.root, links: [] });
  fs.mkdirSync(snapshotsRoot(), { recursive: true });
  options.onStep?.(`Checking out ${c.short}`);
  const add = await gitRun(c.root, ["worktree", "add", "--detach", wt, c.hash], { timeoutMs: 300_000 });
  if (add.code !== 0) throw gitFailure(add, "Couldn't check out that commit");
  const dir = rel ? path.join(wt, rel) : wt;
  const snap: Snapshot = {
    id,
    name: `${project.name}@${c.short}`,
    project: project.name,
    projectDir: path.resolve(project.dir),
    repo: c.root,
    hash: c.hash,
    short: c.short,
    subject: c.subject,
    at: c.at,
    path: wt,
    dir,
    createdAt: new Date().toISOString(),
    packages: "none",
    links: [],
    envFiles: [],
  };
  if (!fs.existsSync(dir)) {
    await removeFolder(snap);
    throw new GitError(`${project.name} wasn't in the repository yet at ${c.short}.`);
  }
  // Registered at once, so a snapshot whose install fails can still be removed.
  store[id] = snap;
  save(store);

  snap.envFiles = copyEnvFiles(project.dir, dir);
  if (snap.envFiles.length) options.onStep?.(`Copied ${snap.envFiles.join(", ")}`);
  await preparePackages(snap, path.resolve(project.dir), options);
  const latest = load();
  latest[id] = snap;
  save(latest);
  return snap;
}

/** Removes a snapshot: its node_modules links first (never what they point at), then the worktree, then the entry. */
export async function removeSnapshot(id: string): Promise<Snapshot> {
  const store = load();
  const s = typeof id === "string" ? store[id] : undefined;
  if (!s) throw new GitError("That snapshot isn't there any more.", 404);
  await removeFolder(s);
  const latest = load();
  delete latest[id];
  save(latest);
  return s;
}

async function headOf(dir: string): Promise<string | undefined> {
  if (!fs.existsSync(dir)) return undefined;
  const r = await gitRun(dir, ["rev-parse", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

async function removeFolder(s: Pick<Snapshot, "path" | "dir" | "repo" | "links">): Promise<void> {
  if (!insideRoot(s.path)) throw new GitError("Only folders dx made under ~/.dx/snapshots are removed.");
  for (const link of [...(s.links ?? []), ...nodeModulesIn(s.dir)]) unlinkIfLink(link);
  if (fs.existsSync(s.repo)) await gitRun(s.repo, ["worktree", "remove", "--force", "--force", s.path], { timeoutMs: 300_000 });
  if (fs.existsSync(s.path)) {
    // What git left (untracked files it wouldn't touch): links are gone, so nothing outside is reached.
    for (const link of nodeModulesIn(s.dir)) unlinkIfLink(link);
    fs.rmSync(s.path, { recursive: true, force: true, maxRetries: 3 });
  }
  if (fs.existsSync(s.repo)) await gitRun(s.repo, ["worktree", "prune"]);
}

/** Removes `p` only when it's a link (a symlink, or a junction on Windows): the folder it points at stays. */
function unlinkIfLink(p: string): void {
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

/** node_modules folders (or links) in a project, its root first, a few levels down; never inside one. */
function nodeModulesIn(dir: string, depth = 3): string[] {
  const out: string[] = [];
  const walk = (d: string, level: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= 200) return;
      const p = path.join(d, e.name);
      if (e.name === "node_modules") {
        if (e.isDirectory() || e.isSymbolicLink()) out.push(p);
        continue;
      }
      if (level < depth && e.isDirectory() && !e.name.startsWith(".") && !["dist", "build", "out", "vendor", "target"].includes(e.name)) walk(p, level + 1);
    }
  };
  walk(dir, 0);
  return out;
}

/** The project's .env files that the commit doesn't have, copied in so the app can run. Example files are tracked anyway. */
function copyEnvFiles(from: string, to: string): string[] {
  const copied: string[] = [];
  for (const rel of findEnvFiles(from)) {
    if (isExampleFile(rel)) continue;
    const src = path.join(from, rel);
    const dest = path.join(to, rel);
    try {
      const st = fs.lstatSync(src);
      if (!st.isFile() || st.size > ENV_MAX) continue;
      if (fs.existsSync(dest) || !fs.existsSync(path.dirname(dest))) continue;
      fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
      if (process.platform !== "win32") fs.chmodSync(dest, 0o600);
      copied.push(rel);
    } catch {
      // one that can't be copied is left out; the app says what it misses
    }
  }
  return copied;
}

async function preparePackages(snap: Snapshot, projectDir: string, options: SnapshotOptions): Promise<void> {
  if (!fs.existsSync(path.join(snap.dir, "package.json"))) return;
  const lock = LOCKS.find((f) => fs.existsSync(path.join(projectDir, f)));
  const own = path.join(projectDir, "node_modules");
  if (lock && isDir(own) && (await sameLock(snap, projectDir, lock))) {
    options.onStep?.(`Linking node_modules (${lock} is the same as now)`);
    // The root's, and a workspace package's own where the snapshot has that package too.
    for (const target of nodeModulesIn(projectDir)) {
      const rel = path.relative(projectDir, target);
      const link = path.join(snap.dir, rel);
      if (!fs.existsSync(path.dirname(link)) || fs.existsSync(link) || !isDir(target)) continue;
      fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
      snap.links.push(link);
    }
    snap.packages = "linked";
    return;
  }
  const cmd = await snapshotInstallCommand(snap.dir);
  if (!cmd) {
    snap.packages = "failed";
    options.onOutput?.(`${detectPackageManager(snap.dir)} isn't installed, so the packages couldn't be installed.`);
    return;
  }
  options.onStep?.(cmd.label);
  options.onOutput?.(`$ ${cmd.command} ${cmd.args.join(" ")}`);
  const r = await (options.runInstall ?? runStreaming)(cmd, options.onOutput);
  snap.packages = r.ok ? "installed" : "failed";
}

/** The lock file at the commit is byte for byte the one in the project now (line endings aside). */
async function sameLock(snap: Snapshot, projectDir: string, lock: string): Promise<boolean> {
  const rel = path.relative(snap.repo, path.join(projectDir, lock)).split(path.sep).join("/");
  const [then, now] = await Promise.all([
    gitRun(snap.repo, ["rev-parse", "--verify", "-q", `${snap.hash}:${rel}`]),
    gitRun(snap.repo, ["hash-object", "--", path.join(projectDir, lock)]),
  ]);
  if (then.code !== 0) return false;
  if (now.code === 0 && then.stdout.trim() === now.stdout.trim()) return true;
  if (lock.endsWith(".lockb")) return false;
  // core.autocrlf: the file on disk can differ from the blob by line endings only.
  const blob = await gitRun(snap.repo, ["cat-file", "blob", then.stdout.trim()]);
  try {
    const disk = fs.readFileSync(path.join(projectDir, lock), "utf8");
    return blob.code === 0 && blob.stdout.replace(/\r\n/g, "\n") === disk.replace(/\r\n/g, "\n");
  } catch {
    return false;
  }
}

/** The install the snapshot's lock file asks for, exactly as locked; corepack or npx when pnpm or yarn isn't installed. */
export async function snapshotInstallCommand(dir: string): Promise<InstallCommand | undefined> {
  const pm: PackageManager = detectPackageManager(dir, readPackageJson(dir));
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  const locked = pm === "npm" ? has("package-lock.json") || has("npm-shrinkwrap.json") : pm === "pnpm" ? has("pnpm-lock.yaml") : pm === "yarn" ? has("yarn.lock") : has("bun.lockb") || has("bun.lock");
  const args = pm === "npm" ? [locked ? "ci" : "install"] : locked ? ["install", "--frozen-lockfile"] : ["install"];
  const shell = process.platform === "win32";
  if (await commandExists(pm)) return { label: `Installing packages (${pm} ${args.join(" ")})`, command: pm, args, cwd: dir, shell };
  if (pm === "npm" || pm === "bun") return undefined;
  if (await commandExists("corepack")) return { label: `Installing packages (${pm}, through corepack)`, command: "corepack", args: [pm, ...args], cwd: dir, shell };
  return { label: `Installing packages (${pm}, through npx)`, command: "npx", args: ["--yes", pm, ...args], cwd: dir, shell };
}

function readPackageJson(dir: string): { packageManager?: string } | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { packageManager?: string };
  } catch {
    return undefined;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function runStreaming(cmd: InstallCommand, onOutput?: (line: string) => void): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    // Fixed words chosen above; nothing from a request reaches the command line.
    const child = cmd.shell
      ? spawn([cmd.command, ...cmd.args].join(" "), { cwd: cmd.cwd, shell: true, windowsHide: true, env: process.env })
      : spawn(cmd.command, cmd.args, { cwd: cmd.cwd, windowsHide: true, env: process.env });
    let output = "";
    let partial = "";
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output = (output + text).slice(-20_000);
      const lines = (partial + text).split(/\r?\n|\r/);
      partial = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) onOutput?.(l);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => resolve({ ok: false, output: err.message }));
    child.on("close", (code) => resolve({ ok: code === 0, output }));
  });
}
