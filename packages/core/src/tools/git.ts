import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Git for the dashboard's Git page: the commit graph, and the changes as a board to stage,
 * unstage and commit. Every command runs from the repository's top folder with its arguments as
 * an array, and paths are always literal (`--literal-pathspecs`), so a file called `*` or
 * `:(glob)…` is only ever that file.
 */

/** A git error the caller can show as it is; `status` is the HTTP status that fits it. */
export class GitError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export interface GitRef {
  name: string;
  kind: "branch" | "remote" | "tag" | "head";
  /** The branch HEAD is on. */
  current?: boolean;
}

export interface GraphRow {
  /** The lane the commit's dot is in. */
  lane: number;
  /** Lanes that come down into the dot from above (its children). */
  up: number[];
  /** Lanes the dot goes down into (its parents). */
  down: number[];
  /** Lanes that pass by without touching the dot. */
  through: number[];
  /** Lanes that come in from above at `from` and leave below at `to`: a branch joining the line on its left. */
  moves: [number, number][];
  /** How many lanes this row needs. */
  width: number;
}

export interface GitCommit {
  hash: string;
  short: string;
  parents: string[];
  refs: GitRef[];
  author: string;
  /** Commit time, ms. */
  at: number;
  subject: string;
}

export interface GitGraph {
  commits: (GitCommit & { row: GraphRow })[];
  /** The widest row, in lanes. */
  width: number;
  /** There are older commits than these. */
  more: boolean;
}

export interface GitFileStat {
  path: string;
  from?: string;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

export interface GitCommitDetail extends GitCommit {
  message: string;
  files: GitFileStat[];
  patch: string;
  truncated: boolean;
}

export interface GitFileStatus {
  path: string;
  /** Where a renamed file came from. */
  from?: string;
  /** Status letters as git gives them: index (staged side) and worktree. "." means unchanged. */
  index: string;
  worktree: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitStatus {
  /** The commit HEAD is on, so the page knows when to redraw the graph. */
  head?: string;
  branch?: string;
  detached: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  /** False in a repository with no commits yet. */
  hasCommits: boolean;
  files: GitFileStatus[];
  /** More than GIT_STATUS_MAX files changed; the rest aren't listed. */
  truncated: boolean;
  /** A merge, rebase, cherry-pick or revert that stopped half way (on a conflict, usually). */
  operation?: GitOperation;
}

export type GitOperation = "merge" | "rebase" | "cherry-pick" | "revert";

export interface GitHunk {
  /** A hash of the hunk's text: what the page sends back to stage exactly this one. */
  id: string;
  header: string;
  lines: string[];
}

export interface GitFileDiff {
  path: string;
  staged: boolean;
  untracked: boolean;
  binary: boolean;
  /** Blocks can be staged one by one (a plain change, not a new, deleted or renamed file). */
  stageable: boolean;
  hunks: GitHunk[];
  /** The exact diff text. */
  patch: string;
  truncated: boolean;
}

export const GIT_GRAPH_MAX = 2000;
export const GIT_STATUS_MAX = 1000;
const PATCH_MAX = 512 * 1024;
const UNTRACKED_MAX = 256 * 1024;
const MESSAGE_MAX = 10_000;

interface Result {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** stdout as bytes, for file contents (`cat-file blob`). */
  raw: Buffer;
}

/** Runs git with arguments as an array, never through a shell. Output past `max` is cut, not an error. */
export interface GitRunOptions {
  input?: string;
  max?: number;
  timeoutMs?: number;
  /** Extra environment, for the sequence editor of an interactive rebase. */
  env?: Record<string, string>;
  /**
   * false drops --literal-pathspecs, for a command given no paths at all: `stash push -u` with it
   * leaves new files behind (git matches its own internal pathspec literally).
   */
  literal?: boolean;
}

/** For gitops.ts: git run the way every command here runs it. */
export const gitRun = (cwd: string, args: string[], options: GitRunOptions = {}) => git(cwd, args, options);
export type GitResult = Result;

function git(cwd: string, args: string[], options: GitRunOptions = {}): Promise<Result> {
  return new Promise((resolve) => {
    const max = options.max ?? 64 * 1024 * 1024;
    const child = spawn("git", ["-c", "core.quotepath=false", "-c", "color.ui=false", ...(options.literal === false ? [] : ["--literal-pathspecs"]), ...args], {
      cwd,
      windowsHide: true,
      // No prompts (a hook asking for a password would hang the dashboard), and reads don't take
      // the index lock, so the page polling status never gets in the way of git in a terminal.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_EDITOR: "true", ...options.env },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let truncated = false;
    child.stdout.on("data", (b: Buffer) => {
      if (size >= max) return void (truncated = true);
      out.push(b);
      size += b.length;
    });
    child.stderr.on("data", (b: Buffer) => err.push(b));
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 60_000);
    child.once("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: e.message, truncated: false, raw: Buffer.alloc(0) });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const raw = Buffer.concat(out);
      let stdout = raw.toString("utf8");
      if (stdout.length > max) {
        stdout = stdout.slice(0, max);
        truncated = true;
      }
      resolve({ code: code ?? -1, stdout, stderr: Buffer.concat(err).toString("utf8"), truncated, raw });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });
}

export function gitFailure(r: Result, what: string): GitError {
  return failure(r, what);
}

function failure(r: Result, what: string): GitError {
  const text = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-12).join("\n");
  return new GitError(text ? `${what}: ${text}` : `${what} (git exited with ${r.code}).`);
}

/** The repository's top folder: every path git prints and takes is relative to it. */
export async function gitRoot(dir: string): Promise<string> {
  const r = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (r.code !== 0 || !r.stdout.trim()) throw new GitError("This project isn't a git repository.");
  return path.resolve(r.stdout.trim());
}

// ------------------------------------------------------------------ graph

const FORMAT = "%H%x1f%P%x1f%D%x1f%an%x1f%at%x1f%s%x1e";
/** For snapshots.ts: the log format every commit list here uses (with --decorate=full), and its parser. */
export const GIT_LOG_FORMAT = FORMAT;
export const parseCommitLog = (text: string): GitCommit[] => parseCommits(text);

function parseRefs(decorations: string): GitRef[] {
  const refs: GitRef[] = [];
  for (const raw of decorations.split(", ").map((s) => s.trim()).filter(Boolean)) {
    if (raw === "HEAD") refs.push({ name: "HEAD", kind: "head" });
    else if (raw.startsWith("HEAD -> refs/heads/")) refs.push({ name: raw.slice("HEAD -> refs/heads/".length), kind: "branch", current: true });
    else if (raw.startsWith("tag: refs/tags/")) refs.push({ name: raw.slice("tag: refs/tags/".length), kind: "tag" });
    else if (raw.startsWith("refs/heads/")) refs.push({ name: raw.slice("refs/heads/".length), kind: "branch" });
    else if (raw.startsWith("refs/remotes/")) {
      const name = raw.slice("refs/remotes/".length);
      if (!name.endsWith("/HEAD")) refs.push({ name, kind: "remote" });
    }
  }
  return refs;
}

function parseCommits(text: string): GitCommit[] {
  return text
    .split("\x1e")
    .map((s) => s.replace(/^\r?\n/, ""))
    .filter(Boolean)
    .map((record) => {
      const [hash, parents, refs, author, at, subject] = record.split("\x1f");
      return {
        hash,
        short: hash.slice(0, 7),
        parents: parents ? parents.split(" ").filter(Boolean) : [],
        refs: parseRefs(refs ?? ""),
        author: author ?? "",
        at: Number(at) * 1000,
        subject: (subject ?? "").trim(),
      };
    });
}

/**
 * Where each commit's dot and lines go. Commits come newest first (topological order); a lane
 * holds the commit it's waiting for. A lane keeps its place while it lives, and a new one takes
 * the leftmost free place, so lines don't jump sideways.
 */
export function layoutGraph(commits: { hash: string; parents: string[] }[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const free = () => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.length : i;
  };
  return commits.map((c) => {
    const up: number[] = [];
    lanes.forEach((h, i) => h === c.hash && up.push(i));
    const lane = up.length ? up[0] : free();
    const before = lanes.slice();
    for (const i of up) lanes[i] = null;
    const down: number[] = [];
    const moves: [number, number][] = [];
    c.parents.forEach((p, k) => {
      const existing = lanes.indexOf(p);
      if (existing !== -1 && k === 0 && existing > lane && lanes[lane] == null) {
        // A branch further right is waiting for this commit's first parent too: bring it over
        // into this lane, so the line the history follows stays on the left.
        lanes[existing] = null;
        lanes[lane] = p;
        moves.push([existing, lane]);
        down.push(lane);
      } else if (existing !== -1) down.push(existing);
      else {
        const slot = k === 0 && lanes[lane] == null ? lane : free();
        lanes[slot] = p;
        down.push(slot);
      }
    });
    const through: number[] = [];
    before.forEach((h, i) => h && h !== c.hash && lanes[i] === h && through.push(i));
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const width = Math.max(lane + 1, ...up.map((i) => i + 1), ...down.map((i) => i + 1), ...through.map((i) => i + 1), ...moves.map(([i]) => i + 1));
    return { lane, up, down, through, moves, width };
  });
}

/** The newest `limit` commits of every branch, remote branch and tag, laid out as a graph. Stashes stay out. */
export async function gitGraph(dir: string, options: { limit?: number } = {}): Promise<GitGraph> {
  const root = await gitRoot(dir);
  const limit = Math.min(GIT_GRAPH_MAX, Math.max(1, Math.floor(options.limit ?? 200)));
  const r = await git(root, ["log", "--branches", "--remotes", "--tags", "HEAD", "--topo-order", `-n${limit + 1}`, "--decorate=full", `--format=${FORMAT}`, "--"]);
  // A repository with no commits has no HEAD: an empty graph, not an error.
  if (r.code !== 0) {
    const empty = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
    if (empty.code !== 0) return { commits: [], width: 0, more: false };
    throw failure(r, "Couldn't read the history");
  }
  const all = parseCommits(r.stdout);
  const commits = all.slice(0, limit);
  const rows = layoutGraph(commits);
  return {
    commits: commits.map((c, i) => ({ ...c, row: rows[i] })),
    width: rows.reduce((w, row) => Math.max(w, row.width), 0),
    more: all.length > limit,
  };
}

function checkHash(hash: unknown): string {
  if (typeof hash !== "string" || !/^[0-9a-f]{4,40}$/i.test(hash)) throw new GitError("Which commit? Give its hash.");
  return hash;
}

/** One commit: its whole message, the files it changed, and its patch (a merge shows what it brought in). */
export async function gitCommitDetail(dir: string, hash: string): Promise<GitCommitDetail> {
  const root = await gitRoot(dir);
  const rev = checkHash(hash);
  const head = await git(root, ["show", "-s", "--decorate=full", "--format=%H%x1f%P%x1f%D%x1f%an%x1f%at%x1f%s%x1f%B", rev, "--"]);
  if (head.code !== 0) throw new GitError("That commit isn't in this repository.", 404);
  const [full, parents, refs, author, at, subject, ...body] = head.stdout.split("\x1f");
  const [numstat, patch] = await Promise.all([
    git(root, ["show", "--format=", "--numstat", "-z", "-M", "--diff-merges=first-parent", full, "--"]),
    git(root, ["show", "--format=", "--patch", "-M", "--no-ext-diff", "--diff-merges=first-parent", full, "--"], { max: PATCH_MAX }),
  ]);
  return {
    hash: full,
    short: full.slice(0, 7),
    parents: parents ? parents.split(" ").filter(Boolean) : [],
    refs: parseRefs(refs ?? ""),
    author: author ?? "",
    at: Number(at) * 1000,
    subject: (subject ?? "").trim(),
    message: body.join("\x1f").trim(),
    files: parseNumstat(numstat.stdout),
    patch: patch.stdout.replace(/^\n+/, ""),
    truncated: patch.truncated,
  };
}

/** `--numstat -z`: "add\tdel\tpath\0", or for a rename "add\tdel\t\0from\0to\0". Binary files have "-". */
function parseNumstat(text: string): GitFileStat[] {
  const parts = text.split("\0");
  const files: GitFileStat[] = [];
  for (let i = 0; i < parts.length; i++) {
    const m = /^\n?(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    const binary = m[1] === "-";
    const stat: GitFileStat = { path: m[3], additions: binary ? undefined : Number(m[1]), deletions: binary ? undefined : Number(m[2]), binary: binary || undefined };
    if (m[3] === "") {
      stat.from = parts[++i];
      stat.path = parts[++i];
    }
    files.push(stat);
  }
  return files;
}

// ------------------------------------------------------------------ status and staging

/** What's changed, staged and untracked, from `git status --porcelain=v2`. */
export async function gitStatus(dir: string): Promise<GitStatus> {
  const root = await gitRoot(dir);
  return statusAt(root);
}

/** The operation git is in the middle of, from the files it keeps while it waits. */
export async function gitOperation(root: string): Promise<GitOperation | undefined> {
  const r = await git(root, ["rev-parse", "--absolute-git-dir"]);
  const dir = r.stdout.trim();
  if (!dir) return undefined;
  const has = (name: string) => fs.existsSync(path.join(dir, name));
  if (has("rebase-merge") || has("rebase-apply")) return "rebase";
  if (has("MERGE_HEAD")) return "merge";
  if (has("CHERRY_PICK_HEAD")) return "cherry-pick";
  if (has("REVERT_HEAD")) return "revert";
  return undefined;
}

export async function gitStatusAt(root: string): Promise<GitStatus> {
  return statusAt(root);
}

async function statusAt(root: string): Promise<GitStatus> {
  const [r, operation] = await Promise.all([git(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]), gitOperation(root)]);
  if (r.code !== 0) throw failure(r, "Couldn't read the changes");
  const status: GitStatus = { detached: false, ahead: 0, behind: 0, hasCommits: true, files: [], truncated: false, operation };
  const parts = r.stdout.split("\0");
  // Splits off a fixed number of space-separated fields; the path is the rest, spaces and all.
  const fields = (line: string, n: number) => {
    const out: string[] = [];
    let rest = line;
    for (let k = 0; k < n; k++) {
      const at = rest.indexOf(" ");
      out.push(rest.slice(0, at));
      rest = rest.slice(at + 1);
    }
    out.push(rest);
    return out;
  };
  const add = (f: Omit<GitFileStatus, "staged" | "unstaged">) => {
    if (status.files.length >= GIT_STATUS_MAX) return void (status.truncated = true);
    status.files.push({ ...f, staged: !f.untracked && !f.conflicted && f.index !== ".", unstaged: f.untracked || f.conflicted || f.worktree !== "." });
  };
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith("# branch.oid ")) {
      const oid = line.slice(13);
      status.hasCommits = oid !== "(initial)";
      if (status.hasCommits) status.head = oid;
    }
    else if (line.startsWith("# branch.head ")) {
      const head = line.slice(14);
      if (head === "(detached)") status.detached = true;
      else status.branch = head;
    } else if (line.startsWith("# branch.upstream ")) status.upstream = line.slice(18);
    else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) [status.ahead, status.behind] = [Number(m[1]), Number(m[2])];
    } else if (line.startsWith("1 ")) {
      const f = fields(line, 8);
      add({ path: f[8], index: f[1][0], worktree: f[1][1], untracked: false, conflicted: false });
    } else if (line.startsWith("2 ")) {
      const f = fields(line, 9);
      add({ path: f[9], from: parts[++i], index: f[1][0], worktree: f[1][1], untracked: false, conflicted: false });
    } else if (line.startsWith("u ")) {
      const f = fields(line, 10);
      add({ path: f[10], index: f[1][0], worktree: f[1][1], untracked: false, conflicted: true });
    } else if (line.startsWith("? ")) add({ path: line.slice(2), index: "?", worktree: "?", untracked: true, conflicted: false });
  }
  return status;
}

/** The paths asked for, only those `git status` lists right now: nothing else can be staged or unstaged. */
function knownPaths(status: GitStatus, paths: unknown): { files: GitFileStatus[]; paths: string[] } {
  if (!Array.isArray(paths) || paths.length === 0) throw new GitError("Which files? Give their paths.");
  if (paths.length > GIT_STATUS_MAX) throw new GitError(`At most ${GIT_STATUS_MAX} files at a time.`);
  const byPath = new Map(status.files.map((f) => [f.path, f]));
  const files: GitFileStatus[] = [];
  for (const p of paths) {
    const f = typeof p === "string" ? byPath.get(p) : undefined;
    if (!f) throw new GitError(`${typeof p === "string" ? p : "That file"} isn't among the changed files any more. Refresh the list.`, 409);
    files.push(f);
  }
  // A rename is two paths to git: the new name and the old one.
  const all = files.flatMap((f) => (f.from ? [f.path, f.from] : [f.path]));
  return { files, paths: [...new Set(all)] };
}

const fromFile = (paths: string[]) => ({ args: ["--pathspec-from-file=-", "--pathspec-file-nul"], input: paths.join("\0") });

/** `git add` for files the status lists (a deleted file stages its deletion). */
export async function gitStage(dir: string, paths: string[]): Promise<GitStatus> {
  const root = await gitRoot(dir);
  const { paths: list } = knownPaths(await statusAt(root), paths);
  const spec = fromFile(list);
  const r = await git(root, ["add", "-A", ...spec.args], { input: spec.input });
  if (r.code !== 0) throw failure(r, "Couldn't stage");
  return statusAt(root);
}

/** Takes files out of the next commit and keeps their changes in the working folder. */
export async function gitUnstage(dir: string, paths: string[]): Promise<GitStatus> {
  const root = await gitRoot(dir);
  const status = await statusAt(root);
  const { paths: list } = knownPaths(status, paths);
  const spec = fromFile(list);
  // Before the first commit there's no HEAD to restore from: the files just leave the index.
  const r = status.hasCommits
    ? await git(root, ["restore", "--staged", ...spec.args], { input: spec.input })
    : await git(root, ["rm", "--cached", "-r", "-q", ...spec.args], { input: spec.input });
  if (r.code !== 0) throw failure(r, "Couldn't unstage");
  return statusAt(root);
}

function hunkId(header: string, lines: string[]): string {
  return crypto.createHash("sha1").update(header).update("\n").update(lines.join("\n")).digest("hex").slice(0, 12);
}

/** Splits a one-file diff into its header and blocks. Lines are split on "\n" only, so CRLF files keep their "\r". */
function parseFileDiff(patch: string): { header: string[]; hunks: GitHunk[] } {
  const lines = patch.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const header: string[] = [];
  const hunks: GitHunk[] = [];
  let current: { header: string; lines: string[] } | undefined;
  const close = () => current && hunks.push({ id: hunkId(current.header, current.lines), ...current });
  for (const line of lines) {
    if (line.startsWith("@@")) {
      close();
      current = { header: line, lines: [] };
    } else if (current) current.lines.push(line);
    else header.push(line);
  }
  close();
  return { header, hunks };
}

/** One file's changes, staged or not, as blocks that can be staged one by one. */
export async function gitFileDiff(dir: string, file: string, staged: boolean): Promise<GitFileDiff> {
  const root = await gitRoot(dir);
  return fileDiffAt(root, await statusAt(root), file, staged);
}

async function fileDiffAt(root: string, status: GitStatus, file: string, staged: boolean): Promise<GitFileDiff & { header: string[] }> {
  const { files } = knownPaths(status, [file]);
  const f = files[0];
  const base = { path: f.path, staged, untracked: f.untracked, binary: false, stageable: false, hunks: [] as GitHunk[], header: [] as string[], patch: "", truncated: false };
  if (f.untracked) {
    if (staged) return base;
    return { ...base, ...untrackedDiff(root, f.path) };
  }
  const paths = f.from && staged ? [f.from, f.path] : [f.path];
  const r = await git(root, ["diff", ...(staged ? ["--cached"] : []), "-M", "--no-ext-diff", "--", ...paths], { max: PATCH_MAX });
  if (r.code !== 0) throw failure(r, "Couldn't read the changes");
  const { header, hunks } = parseFileDiff(r.stdout);
  const binary = header.some((l) => l.startsWith("Binary files ") || l === "GIT binary patch");
  // Only a plain change can be split: new, deleted and renamed files, and mode changes, go whole.
  const plain = !header.some((l) => /^(new file|deleted file|rename |similarity |copy |old mode|new mode)/.test(l));
  return { ...base, binary, hunks, header, patch: r.stdout, truncated: r.truncated, stageable: plain && !binary && !r.truncated && hunks.length > 0 };
}

/** A new file git doesn't track yet, read from disk as all added lines. Only plain files inside the repository. */
function untrackedDiff(root: string, file: string): Partial<GitFileDiff> {
  const full = path.join(root, file);
  let real: string;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(full);
    real = fs.realpathSync(full);
  } catch {
    return {};
  }
  const top = fs.realpathSync(root);
  if (!stat.isFile() || !(real === top || real.startsWith(top + path.sep))) return {};
  const fd = fs.openSync(full, "r");
  const buf = Buffer.alloc(Math.min(stat.size, UNTRACKED_MAX));
  try {
    fs.readSync(fd, buf, 0, buf.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (buf.subarray(0, 8000).includes(0)) return { binary: true, patch: `Binary file ${file}` };
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const header = `@@ -0,0 +1,${lines.length} @@`;
  const body = lines.map((l) => `+${l}`);
  if (text && !text.endsWith("\n")) body.push("\\ No newline at end of file");
  const truncated = stat.size > UNTRACKED_MAX;
  const hunks = lines.length ? [{ id: hunkId(header, body), header, lines: body }] : [];
  return { hunks, truncated, patch: [`new file ${file}`, ...(hunks.length ? [header, ...body] : [])].join("\n") };
}

/**
 * Stages (or unstages) one block of a file. The page names the block by its id; the patch is
 * built from git's own diff of the file right now, never from the request, so only a change that
 * is really there can be applied. If the file changed since the page read it, the block is gone.
 */
export async function gitStageHunk(dir: string, file: string, id: string, staged: boolean): Promise<GitStatus> {
  const root = await gitRoot(dir);
  const d = await fileDiffAt(root, await statusAt(root), file, staged);
  if (!d.stageable) throw new GitError(`${file} can only be ${staged ? "unstaged" : "staged"} whole.`);
  const hunk = d.hunks.find((h) => h.id === id);
  if (!hunk) throw new GitError(`${file} changed since it was shown. Refresh and try again.`, 409);
  const patch = [...d.header, hunk.header, ...hunk.lines, ""].join("\n");
  const r = await git(root, ["apply", "--cached", ...(staged ? ["--reverse"] : []), "--whitespace=nowarn", "-"], { input: patch });
  if (r.code !== 0) throw failure(r, `Couldn't ${staged ? "unstage" : "stage"} that block`);
  return statusAt(root);
}

/** Commits what's staged, running the project's own hooks. git's own message is the error. */
export async function gitCommit(dir: string, message: string, options: { amend?: boolean } = {}): Promise<{ hash: string; short: string; subject: string }> {
  const root = await gitRoot(dir);
  const text = typeof message === "string" ? message.replace(/\r\n/g, "\n").trim() : "";
  if (!text && !options.amend) throw new GitError("Write a commit message first.");
  if (text.length > MESSAGE_MAX) throw new GitError(`A commit message can be at most ${MESSAGE_MAX} characters.`);
  const status = await statusAt(root);
  if (options.amend && !status.hasCommits) throw new GitError("There's no commit to amend yet.");
  if (!options.amend && !status.files.some((f) => f.staged) && status.operation !== "merge") throw new GitError("Nothing is staged. Stage some changes first.");
  if (status.files.some((f) => f.conflicted)) throw new GitError("Some files still have conflicts. Resolve and stage them first.");
  // Amending without a message keeps the last one.
  const args = options.amend ? ["commit", "-q", "--amend", ...(text ? ["-F", "-"] : ["--no-edit"])] : ["commit", "-q", "-F", "-"];
  const r = await git(root, args, { input: text ? `${text}\n` : "", timeoutMs: 120_000 });
  if (r.code !== 0) throw failure(r, "Couldn't commit");
  const head = await git(root, ["log", "-1", "--format=%H%x1f%s"]);
  const [hash, subject] = head.stdout.trim().split("\x1f");
  return { hash, short: hash.slice(0, 7), subject: subject ?? "" };
}
