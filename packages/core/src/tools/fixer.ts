import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeCli, claudeFailure, runClaude } from "./claude.js";
import { GitError, gitFailure, gitRoot, gitRun } from "./git.js";
import { backupFiles, recordUndo } from "./gitops.js";

/**
 * Ask Claude to fix: an error from a dev server dx runs (or from the activity history) goes to
 * Claude Code with the code around it, and what comes back is a patch for the user to review.
 *
 * - The error comes from dx's own records (the caller looks it up), and the prompt is built here:
 *   fixed instructions, the error and its stack, the source around it, the files its stack names,
 *   and the project's uncommitted changes. Files are read only inside the project, as plain files,
 *   never under node_modules or .git, never .env files or keys, and each is capped.
 * - Claude's answer is never trusted as it is: its diff is rebuilt here with headers dx writes,
 *   every path must be inside the project, and it's tried on a throwaway git index holding the
 *   files as they are now. The patch kept is git's own diff of that, so it's exact.
 * - Nothing changes on disk until applyFix, which checks the files are still as Claude saw them,
 *   keeps a copy of each in git's store and writes an undo-journal entry, so the Git page's Undo
 *   brings them back.
 */

export interface FixTarget {
  /** What kind of error: "runtime", "typescript", "error", "server-error"… */
  kind: string;
  message: string;
  /** Where it happened, as the error tracker or the page reported it (absolute, relative, or a dev server URL). */
  file?: string;
  line?: number;
  column?: number;
  /** The error's own lines: stack frames, code frame, the rest of the output. */
  stack?: string;
  /** The page it happened on, for a browser error. */
  page?: string;
}

export interface FixProposal {
  ok: true;
  /** git's own diff of the change, paths relative to the repository's top folder. */
  patch: string;
  /** The files it touches, relative to the repository's top folder. */
  files: string[];
  /** Each file as Claude saw it (git's blob id), or null for one the patch creates: applyFix checks they haven't changed. */
  before: { path: string; blob: string | null }[];
  explanation: string;
  /** Claude's whole answer, as it said it. */
  answer: string;
}

export interface FixRejected {
  ok: false;
  /** Why there's nothing to apply: no diff, a path outside the project, a patch that doesn't fit. */
  reason: string;
  explanation: string;
  answer: string;
}

const TIMEOUT_MS = 90_000;
const AROUND = 60;
const WHOLE_FILE_LINES = 300;
const FRAME_AROUND = 30;
const FRAME_FILES = 3;
const FILE_MAX = 512 * 1024;
const EXCERPT_MAX = 24 * 1024;
const FRAME_EXCERPT_MAX = 8 * 1024;
const STACK_MAX = 8 * 1024;
const DIFF_MAX = 40 * 1024;
const PATCH_MAX = 256 * 1024;

/** Folders never read from or patched: installed packages, git's own, virtualenvs, build caches. */
const BLOCKED_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", ".venv", "venv", "__pycache__", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", "vendor", "bower_components"]);
/** Files that hold secrets or are written by tools: never sent, never patched. */
const BLOCKED_FILE = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx|jks|keystore)|id_rsa.*|id_ed25519.*|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|uv\.lock|Cargo\.lock|go\.sum)$/i;

/** Left out of the `git diff HEAD` Claude is shown. */
const SECRET_PATHSPECS = [".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"].map((p) => `:(exclude,glob)**/${p}`);

const INSTRUCTIONS =`You are fixing an error in a developer's project. The error, its stack, the code around it and the project's uncommitted changes are below.

Rules:
- Find the cause of the error from what's shown.
- Reply with ONLY a unified diff (the format of git diff) against the files as they are now, then a line starting with "EXPLANATION:" and 1 to 3 sentences saying what was wrong and what the change does.
- Paths in the diff are relative to the project's root folder: "--- a/src/cart.js" and "+++ b/src/cart.js" (--- /dev/null for a new file).
- Make the smallest change that fixes the error. No unrelated edits, no reformatting, no renamed files, no new dependencies.
- Copy each block's unchanged lines exactly as they are in the file, indentation included, so the diff applies.
- Never change anything under node_modules or .git, lock files, or .env files.
- If what's shown isn't enough to fix it safely, reply with no diff, just "EXPLANATION:" and what you'd need to see.
- No preamble and no other text.`;

// ------------------------------------------------------------------ files inside the project

const norm = (p: string) => (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p);

function realDir(dir: string): string {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** `child` is `parent` or inside it. */
function within(parent: string, child: string): boolean {
  const rel = path.relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** A project-relative path (forward slashes) that may be read or patched, or why not. */
function allowedPath(rel: string): string | undefined {
  const parts = rel.split("/");
  if (!rel || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || parts.some((p) => p === "" || p === "." || p === "..")) return "isn't a path inside the project";
  if (parts.slice(0, -1).some((p) => BLOCKED_DIRS.has(p))) return `is under ${parts.find((p) => BLOCKED_DIRS.has(p))}, which dx never changes`;
  if (BLOCKED_FILE.test(parts[parts.length - 1])) return "is a secrets, key or lock file, which dx never sends or changes";
  return undefined;
}

/** A file inside the project that can be read: a plain file (not a link), not too big, not in a blocked folder. */
function readableFile(dir: string, full: string): { rel: string; full: string; text: string } | undefined {
  const root = realDir(dir);
  const stat = fs.lstatSync(full, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > FILE_MAX) return undefined;
  const real = realDir(full);
  if (!within(root, real)) return undefined;
  const rel = path.relative(root, real).split(path.sep).join("/");
  if (allowedPath(rel)) return undefined;
  const buf = fs.readFileSync(full);
  if (buf.subarray(0, 8000).includes(0)) return undefined;
  return { rel, full, text: buf.toString("utf8").replace(/\r\n/g, "\n") };
}

/** A location as a dev server or a page printed it: absolute, relative, "/src/App.tsx", a dev server URL or file:///. */
export function projectFile(dir: string, raw: string | undefined): { rel: string; full: string; text: string } | undefined {
  if (!raw) return undefined;
  let p = raw.trim().replace(/^\(|\)$/g, "");
  try {
    if (/^file:\/\//i.test(p)) p = fileURLToPath(p.replace(/[?#].*$/, ""));
    else if (/^https?:\/\//i.test(p)) p = decodeURIComponent(new URL(p).pathname);
  } catch {
    return undefined;
  }
  p = p.replace(/[?#].*$/, "").replace(/^\/@fs\//, "/");
  if (process.platform === "win32") p = p.replace(/^\/([A-Za-z]:)/, "$1");
  const candidates = path.isAbsolute(p) ? [p, path.join(dir, p.replace(/^[\\/]+/, ""))] : [path.resolve(dir, p)];
  for (const c of candidates) {
    const f = readableFile(dir, c);
    if (f) return f;
  }
  return undefined;
}

/** "http://localhost:5173/src/App.tsx:12:5" → the file, 12, 5. */
export function splitLocation(location: string): { file: string; line?: number; column?: number } {
  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(location.trim());
  return m ? { file: m[1], line: Number(m[2]), column: m[3] ? Number(m[3]) : undefined } : { file: location.trim() };
}

/** The file:line places a stack names, in order: V8, Firefox, Python, Go, TypeScript and plain "file.ext:12:5". */
export function stackLocations(stack: string): { file: string; line: number }[] {
  const out: { file: string; line: number }[] = [];
  for (const line of stack.split(/\r?\n/)) {
    const m =
      /\bat (?:.*? \()?((?:file|https?):\/\/\S+?|[^\s()]+?):(\d+)(?::\d+)?\)?\s*$/.exec(line) ??
      /@((?:file|https?):\/\/\S+?|\S+?):(\d+):\d+\s*$/.exec(line) ??
      /File "(.+?)", line (\d+)/.exec(line) ??
      /^\s*(\S+\.go):(\d+)/.exec(line) ??
      /(\S+\.\w+)\((\d+),\d+\)/.exec(line) ??
      /((?:[A-Za-z]:)?[\w./\\@~-]+\.\w+):(\d+)(?::\d+)?/.exec(line);
    if (m && !/^node:/.test(m[1])) out.push({ file: m[1], line: Number(m[2]) });
  }
  return out;
}

/** Text in a code fence longer than any run of backticks inside it. */
function fenced(text: string, lang = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text.replace(/\n+$/, "")}\n${fence}`;
}

function excerpt(text: string, line: number | undefined, around: number, max: number): { body: string; from: number; to: number; total: number } {
  const lines = text.replace(/\n$/, "").split("\n");
  const total = lines.length;
  let from = 1;
  let to = total;
  if (total > WHOLE_FILE_LINES || text.length > max) {
    const at = Math.min(Math.max(line ?? 1, 1), total);
    from = Math.max(1, at - around);
    to = Math.min(total, at + around);
  }
  let body = lines.slice(from - 1, to).join("\n");
  if (body.length > max) body = body.slice(0, max);
  return { body, from, to, total };
}

const langOf = (rel: string) => path.extname(rel).slice(1).toLowerCase();

/** What Claude reads on stdin: the instructions, the error, the code around it, the stack's files, and the uncommitted changes. */
export async function fixPrompt(dir: string, error: FixTarget): Promise<string> {
  const stack = (error.stack ?? "").slice(0, STACK_MAX);
  const frames = stackLocations(stack);
  // The file the error names, or else the first of the project's own files in its stack.
  let main = projectFile(dir, error.file);
  let mainLine = error.line;
  for (const f of main ? [] : frames) {
    main = projectFile(dir, f.file);
    mainLine = f.line;
    if (main) break;
  }

  const parts = [INSTRUCTIONS, "", `The error (${error.kind}):`, fenced(error.message.slice(0, 4000))];
  if (error.file) parts.push(`Reported at: ${main ? main.rel : error.file}${error.line ? `:${error.line}` : ""}${error.column ? `:${error.column}` : ""}`);
  if (error.page) parts.push(`On the page: ${error.page}`);
  if (stack.trim()) parts.push("", "Its stack and output:", fenced(stack));
  if (main) {
    const e = excerpt(main.text, mainLine, AROUND, EXCERPT_MAX);
    parts.push("", e.from === 1 && e.to === e.total ? `The file ${main.rel} (all ${e.total} lines):` : `The file ${main.rel}, lines ${e.from} to ${e.to} of ${e.total}:`, fenced(e.body, langOf(main.rel)));
  } else parts.push("", "(The file the error names isn't one of the project's own files, or couldn't be read.)");

  const seen = new Set(main ? [main.rel] : []);
  const others: string[] = [];
  for (const f of frames) {
    if (others.length >= FRAME_FILES) break;
    const file = projectFile(dir, f.file);
    if (!file || seen.has(file.rel)) continue;
    seen.add(file.rel);
    const e = excerpt(file.text, f.line, FRAME_AROUND, FRAME_EXCERPT_MAX);
    others.push(e.from === 1 && e.to === e.total ? `${file.rel} (all ${e.total} lines):` : `${file.rel}, lines ${e.from} to ${e.to} of ${e.total}:`, fenced(e.body, langOf(file.rel)), "");
  }
  if (others.length) parts.push("", "Other project files in the stack:", "", ...others);

  // What changed since the last commit is the likeliest cause. Secrets files are left out.
  const diff = await gitRun(
    dir,
    ["diff", "HEAD", "--no-color", "--no-ext-diff", "--relative", "--", ".", ...SECRET_PATHSPECS],
    { max: DIFF_MAX, literal: false },
  );
  if (diff.code === 0 && diff.stdout.trim()) {
    parts.push("", diff.truncated ? `Uncommitted changes in the project (git diff HEAD, cut at ${DIFF_MAX / 1024} KB):` : "Uncommitted changes in the project (git diff HEAD):", fenced(diff.stdout, "diff"));
  } else if (diff.code === 0) parts.push("", "There are no uncommitted changes.");
  return parts.join("\n");
}

// ------------------------------------------------------------------ Claude's answer

/** The diff and the explanation in what Claude said: a fenced diff or a bare one, then "EXPLANATION:". */
export function parseFixAnswer(text: string): { diff: string; explanation: string } {
  const t = text.replace(/\r\n/g, "\n");
  const lines = t.split("\n");
  let cut = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*[*_#>\s]*explanation\s*[*_]*\s*:/i.test(lines[i])) {
      cut = i;
      break;
    }
  }
  const before = cut >= 0 ? lines.slice(0, cut).join("\n") : t;
  const after = cut >= 0 ? [lines[cut].replace(/^\s*[*_#>\s]*explanation\s*[*_]*\s*:\s*[*_]*\s*/i, ""), ...lines.slice(cut + 1)].join("\n") : "";
  // The diff is expected before the explanation; if it came after, the explanation ends where it starts.
  const diff = diffIn(before) || diffIn(after);
  const explanation = (diffIn(before) ? after : after.split(/^(?:`{3,}|diff --git |--- )/m)[0]).replace(/```[\s\S]*$/, "").trim().slice(0, 1500);
  return { diff, explanation };
}

function diffIn(text: string): string {
  const looksLikeDiff = (s: string) => /^(diff --git |--- |\+\+\+ |@@ )/m.test(s);
  const blocks = [...text.matchAll(/^(`{3,})[^\n]*\n([\s\S]*?)\n\1[ \t]*$/gm)].map((m) => m[2]).filter(looksLikeDiff);
  if (blocks.length) return blocks.join("\n");
  const start = text.search(/^(diff --git |--- )/m);
  return start >= 0 ? text.slice(start) : "";
}

interface PatchFile {
  from: string | null;
  to: string | null;
  hunks: string[][];
}

/** A path from a diff header: no timestamp, no quotes, /dev/null as null. */
function headerPath(raw: string): string | null {
  let p = raw.replace(/\t.*$/, "").trim();
  if (/^".*"$/.test(p)) p = p.slice(1, -1);
  return p === "/dev/null" ? null : p.replace(/\\/g, "/");
}

/** The files and blocks of a diff, however loosely it was written. */
export function parseDiff(diff: string): PatchFile[] {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const files: PatchFile[] = [];
  let file: PatchFile | undefined;
  let hunk: string[] | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      file = undefined;
      hunk = undefined;
      continue;
    }
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      file = { from: headerPath(line.slice(4)), to: headerPath(lines[i + 1].slice(4)), hunks: [] };
      files.push(file);
      hunk = undefined;
      i++;
      continue;
    }
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
      if (!file) throw new GitError("Claude's diff has a block without the file it belongs to.");
      hunk = [line];
      file.hunks.push(hunk);
      continue;
    }
    if (hunk && (line === "" || /^[ +\-\\]/.test(line))) {
      hunk.push(line);
      continue;
    }
    hunk = undefined;
  }
  // The usual a/ and b/ prefixes come off.
  for (const f of files) {
    const prefixed = (f.from === null || f.from.startsWith("a/")) && (f.to === null || f.to.startsWith("b/"));
    if (prefixed) {
      if (f.from) f.from = f.from.slice(2);
      if (f.to) f.to = f.to.slice(2);
    }
  }
  return files;
}

/** One block with its counts worked out again (Claude's are often wrong) and blank lines as blank context. */
function rebuildHunk(hunk: string[]): string[] | undefined {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(hunk[0])!;
  const body = hunk.slice(1);
  while (body.length && body[body.length - 1] === "") body.pop();
  const lines = body.map((l) => (l === "" ? " " : l));
  if (!lines.some((l) => l[0] === "+" || l[0] === "-")) return undefined;
  const oldCount = lines.filter((l) => l[0] === " " || l[0] === "-").length;
  const newCount = lines.filter((l) => l[0] === " " || l[0] === "+").length;
  const oldStart = oldCount === 0 ? Math.max(0, Number(m[1])) : Math.max(1, Number(m[1]));
  const newStart = newCount === 0 ? Math.max(0, Number(m[2])) : Math.max(1, Number(m[2]));
  return [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...lines];
}

// ------------------------------------------------------------------ checking the patch

async function git(root: string, args: string[], what: string, options: { input?: string; env?: Record<string, string> } = {}): Promise<string> {
  const r = await gitRun(root, args, options);
  if (r.code !== 0) throw gitFailure(r, what);
  return r.stdout;
}

/** The project's place in its repository: "" at the top, "packages/web" in a monorepo. */
function prefixOf(root: string, dir: string): string {
  const rel = path.relative(realDir(root), realDir(dir));
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new GitError("The project isn't inside its git repository's folder.");
  return rel.split(path.sep).join("/");
}

/**
 * Turns Claude's diff into git's own: headers rewritten by dx, each path checked, then applied to a
 * throwaway index holding the touched files as they are now (`git apply --cached --recount`), and
 * the result diffed by git. Nothing in the project changes. Throws a GitError saying what's wrong.
 */
export async function checkFixPatch(dir: string, diff: string): Promise<Omit<FixProposal, "ok" | "explanation" | "answer">> {
  const root = await gitRoot(dir);
  const prefix = prefixOf(root, dir);
  const project = realDir(dir);
  const parsed = parseDiff(diff);
  if (!parsed.length) throw new GitError("Claude's answer has no diff in it.");

  // One entry per file, its blocks in order.
  const byPath = new Map<string, { rel: string; create: boolean; remove: boolean; hunks: string[][] }>();
  for (const f of parsed) {
    if (f.from && f.to && f.from !== f.to) throw new GitError(`Claude's patch renames ${f.from} to ${f.to}; dx only applies changes inside files.`);
    const rel = (f.to ?? f.from ?? "").replace(/^\.\//, "");
    const why = allowedPath(rel);
    if (why) throw new GitError(`Claude's patch touches ${rel || "a file with no name"}, which ${why}.`);
    const full = path.resolve(project, ...rel.split("/"));
    if (!within(project, full)) throw new GitError(`Claude's patch touches ${rel}, which isn't inside the project.`);
    // Links could point anywhere: every folder on the way, and the file, must really be inside.
    let up = path.dirname(full);
    while (!fs.existsSync(up)) up = path.dirname(up);
    if (!within(project, realDir(up))) throw new GitError(`Claude's patch touches ${rel}, which isn't inside the project.`);
    const stat = fs.lstatSync(full, { throwIfNoEntry: false });
    if (f.from === null && stat) throw new GitError(`Claude's patch creates ${rel}, which exists already. Ask again.`);
    if (f.from !== null && !stat) throw new GitError(`Claude's patch changes ${rel}, which doesn't exist.`);
    if (stat && !stat.isFile()) throw new GitError(`Claude's patch changes ${rel}, which isn't a plain file.`);
    const hunks = f.hunks.map(rebuildHunk).filter((x): x is string[] => !!x);
    const entry = byPath.get(rel) ?? byPath.set(rel, { rel, create: f.from === null, remove: f.to === null, hunks: [] }).get(rel)!;
    entry.hunks.push(...hunks);
  }
  const entries = [...byPath.values()].filter((e) => e.hunks.length);
  if (!entries.length) throw new GitError("Claude's diff changes nothing.");

  const repoPath = (rel: string) => (prefix ? `${prefix}/${rel}` : rel);
  const text = entries
    .map((e) => {
      const p = repoPath(e.rel);
      const startOf = (h: string[]) => Number(/^@@ -(\d+)/.exec(h[0])![1]);
      const hunks = [...e.hunks].sort((a, b) => startOf(a) - startOf(b));
      return [
        `diff --git a/${p} b/${p}`,
        ...(e.create ? ["new file mode 100644"] : e.remove ? ["deleted file mode 100644"] : []),
        e.create ? "--- /dev/null" : `--- a/${p}`,
        e.remove ? "+++ /dev/null" : `+++ b/${p}`,
        ...hunks.flat(),
      ].join("\n");
    })
    .join("\n");
  if (text.length > PATCH_MAX) throw new GitError("Claude's patch is too big to be a small fix.");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dx-fix-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
    // The touched files as they are now, the way git sees them (line endings converted as for a commit).
    const before: { path: string; blob: string | null }[] = [];
    const info: string[] = [];
    for (const e of entries) {
      const p = repoPath(e.rel);
      if (e.create) {
        before.push({ path: p, blob: null });
        continue;
      }
      const blob = (await git(root, ["hash-object", "-w", "--stdin-paths"], `Couldn't read ${e.rel}`, { input: `${p}\n` })).trim();
      const exec = process.platform !== "win32" && (fs.statSync(path.join(root, ...p.split("/"))).mode & 0o111) !== 0;
      before.push({ path: p, blob });
      info.push(`${exec ? "100755" : "100644"} ${blob}\t${p}`);
    }
    if (info.length) await git(root, ["update-index", "--add", "--index-info"], "Couldn't prepare the check", { input: `${info.join("\n")}\n`, env });
    const treeA = (await git(root, ["write-tree"], "Couldn't prepare the check", { env })).trim();
    // A block without unchanged lines around it ("@@ -1 +1 @@" and one line swapped) makes git
    // insist it sits at the very start or end of the file; --unidiff-zero lets its line number
    // place it instead. The patch kept is git's own diff afterwards, with full context.
    const bare = entries.some((e) => e.hunks.some((h) => h[1][0] !== " " || h[h.length - 1][0] !== " "));
    const applied = await gitRun(root, ["apply", "--cached", "--recount", "--whitespace=nowarn", ...(bare ? ["--unidiff-zero"] : [])], { input: `${text}\n`, env });
    if (applied.code !== 0) {
      const said = (applied.stderr || applied.stdout).trim().split(/\r?\n/).slice(-6).join("\n");
      throw new GitError(`Claude's patch doesn't fit the files as they are now${said ? `: ${said}` : ""}`);
    }
    const treeB = (await git(root, ["write-tree"], "Couldn't check the patch", { env })).trim();
    const patch = await git(root, ["diff-tree", "-p", "--no-color", "--no-ext-diff", "--no-renames", treeA, treeB], "Couldn't read the patch back");
    if (!patch.trim()) throw new GitError("Claude's patch leaves the files as they are.");
    return { patch, files: before.map((b) => b.path), before };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ propose and apply

/**
 * Sends the error and the code around it to Claude Code and returns its patch, checked, without
 * changing anything. A patch that can't be used comes back as `ok: false` with why and Claude's
 * own answer; Claude not being there, failing or taking too long are errors.
 */
export async function proposeFix(dir: string, error: FixTarget, options: { claude?: string; timeoutMs?: number } = {}): Promise<FixProposal | FixRejected> {
  try {
    await gitRoot(dir);
  } catch {
    throw new GitError("Ask Claude to fix works in git projects: dx checks Claude's patch with git, and Undo brings your files back from it. Run git init in the project first.");
  }
  const cli = options.claude ?? (await claudeCli());
  if (!cli) throw new GitError("Claude Code isn't installed here (no claude command), so it can't propose a fix.");
  const prompt = await fixPrompt(dir, error);
  const r = await runClaude(cli, prompt, { timeoutMs: options.timeoutMs ?? TIMEOUT_MS });
  if (r.timedOut) throw new GitError(`Claude Code took longer than ${Math.round((options.timeoutMs ?? TIMEOUT_MS) / 1000)} seconds, so it was stopped. Try again.`, 504);
  if (r.code !== 0) throw new GitError(claudeFailure(r, "Claude Code couldn't look at it"), 502);
  const answer = r.stdout.replace(/\r\n/g, "\n").trim();
  if (!answer) throw new GitError("Claude Code answered with nothing. Try again.", 502);
  const { diff, explanation } = parseFixAnswer(answer);
  if (!diff.trim()) return { ok: false, reason: "Claude didn't propose a change.", explanation, answer };
  try {
    return { ok: true, ...(await checkFixPatch(dir, diff)), explanation, answer };
  } catch (err) {
    if (err instanceof GitError) return { ok: false, reason: err.message, explanation, answer };
    throw err;
  }
}

/**
 * Applies a proposal made by proposeFix: only if every file is still as Claude saw it. A copy of
 * each goes into git's store first and the undo journal gets an entry, so Undo on the Git page
 * puts them back. The change lands in the working tree, unstaged.
 */
export async function applyFix(dir: string, fix: Pick<FixProposal, "patch" | "before">, options: { label?: string } = {}): Promise<{ ok: true; files: string[]; undoId: string; message: string }> {
  const root = await gitRoot(dir);
  const paths = fix.before.map((b) => b.path);
  for (const b of fix.before) {
    const full = path.resolve(root, ...b.path.split("/"));
    if (!within(root, full)) throw new GitError(`${b.path} isn't inside the repository.`);
    const stat = fs.lstatSync(full, { throwIfNoEntry: false });
    if (b.blob === null) {
      if (stat) throw new GitError(`${b.path} exists now, and the fix would create it. Ask again.`, 409);
      continue;
    }
    if (!stat?.isFile()) throw new GitError(`${b.path} is gone or isn't a plain file any more. Ask again.`, 409);
    const now = (await git(root, ["hash-object", "--stdin-paths"], `Couldn't read ${b.path}`, { input: `${b.path}\n` })).trim();
    if (now !== b.blob) throw new GitError(`${b.path} changed since Claude looked at it. Ask again.`, 409);
  }
  const backup = await backupFiles(root, paths, "so the fix wasn't applied");
  const r = await gitRun(root, ["apply", "--whitespace=nowarn"], { input: fix.patch });
  if (r.code !== 0) throw gitFailure(r, "The fix didn't apply");
  const what = paths.length === 1 ? paths[0] : `${paths.length} files`;
  const entry = recordUndo(root, "fix", options.label ?? `Applied Claude's fix to ${what}`, { kind: "files", files: backup });
  return { ok: true, files: paths, undoId: entry.id, message: `The fix is in ${what}. Undo puts ${paths.length === 1 ? "it" : "them"} back.` };
}
