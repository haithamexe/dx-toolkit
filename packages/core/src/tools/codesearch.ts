import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mapLimit } from "../concurrency.js";

/**
 * Search a project's code: file names (fuzzy, like a quick-open) and what is inside the files (a word, a
 * phrase or a regular expression), ranked so the file you meant is first, with the lines around each match,
 * where the match is in its line, and facets by folder and kind of file.
 *
 * Reads only the files git would list (tracked, or new and not ignored; a plain walk that skips the usual
 * build folders for a folder that isn't a repository), never follows a link, skips binary and very large
 * files, and never reads a secrets file: `.env` files (not their examples), keys and certificates are
 * findable by name and never searched inside, so a value can't turn up in a result.
 * Pure Node, no dependencies; a few seconds' budget; a regex that takes too long stops with what it has.
 */

export type SearchMode = "all" | "files" | "content";

export interface SearchOptions {
  query: string;
  mode?: SearchMode;
  /** Undefined: smart case (case-sensitive only when the query has a capital letter). */
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  /** Only files with one of these extensions (no dot), and only under these folders (the first path segments). */
  ext?: string[];
  folders?: string[];
  /** How many files come back (the totals still count them all). */
  maxFiles?: number;
  /** Matching lines kept per file. */
  perFile?: number;
  /** Lines of context around each kept match. */
  context?: number;
  /** Stop after this long, with what was found. */
  budgetMs?: number;
}

export interface ContextLine {
  line: number;
  text: string;
}

export type HitKind = "definition" | "import" | "comment";

export interface Hit {
  line: number;
  text: string;
  /** Where the matches are in `text` ([start, end), after any clipping). */
  ranges: [number, number][];
  kind?: HitKind;
  before: ContextLine[];
  after: ContextLine[];
}

export interface FileResult {
  /** Relative to the project, with forward slashes. */
  path: string;
  ext: string;
  /** The folders it is in, for facets: the first two segments. */
  folder: string;
  score: number;
  /** Characters of the path the name query matched (indexes), for highlighting. */
  nameRanges: [number, number][];
  nameMatch: boolean;
  /** Matching lines, and how many matches in all (counted up to 500). */
  lines: number;
  matches: number;
  hits: Hit[];
  bytes: number;
}

export interface SearchFacet {
  value: string;
  count: number;
}

export interface SearchResult {
  query: string;
  mode: SearchMode;
  files: FileResult[];
  totals: { files: number; matches: number; scanned: number; skipped: number; ms: number };
  facets: { ext: SearchFacet[]; folder: SearchFacet[] };
  /** More files matched than came back. */
  truncated: boolean;
  /** The budget ran out: what is here is part of the answer. */
  partial: boolean;
  /** The pattern a regex search was given isn't one. */
  patternError?: string;
}

const MAX_BYTES = 1024 * 1024;
const MAX_LINE = 400;
const SCAN_LINE = 2000;
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt", ".svelte-kit", "target", ".venv", "venv", "__pycache__", ".cache", ".turbo", "coverage", ".gradle", ".idea", "vendor", "Pods", "out"]);
const BINARY_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tiff", "psd", "pdf", "zip", "gz", "tgz", "tar", "7z", "rar", "jar", "war", "exe", "dll", "so", "dylib", "bin", "class", "o", "a", "wasm", "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "mov", "avi", "webm", "ogg", "wav", "flac", "sqlite", "db", "lock", "map", "pyc", "icns"]);
const LOCK_NAMES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "composer.lock", "Gemfile.lock", "poetry.lock", "Cargo.lock", "go.sum"]);
const SECRET_NAME = /^(\.env(\..+)?|.+\.(pem|key|p12|pfx|jks|keystore)|id_(rsa|ed25519|ecdsa|dsa)(\..*)?)$/i;
const SECRET_OK = /\.(example|sample|template|dist)$/i;

/** A file whose contents are never searched or shown: a secrets file. Its name can still be found. */
export function isSecretFile(rel: string): boolean {
  const name = rel.split("/").pop() ?? rel;
  return SECRET_NAME.test(name) && !SECRET_OK.test(name);
}

const extOf = (rel: string) => {
  const name = rel.split("/").pop() ?? rel;
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

// ------------------------------------------------------------------ the files

const listCache = new Map<string, { at: number; files: string[] }>();
const LIST_TTL = 5000;

function run(file: string, args: string[], cwd: string): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, maxBuffer: 256 * 1024 * 1024, encoding: "buffer", windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } }, (err, stdout) => resolve(err ? undefined : stdout));
  });
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [""];
  while (stack.length && out.length < 200_000) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name) && !e.name.startsWith(".git")) stack.push(child);
      } else if (e.isFile()) out.push(child);
    }
  }
  return out;
}

/** The project's files, relative with forward slashes: what git lists, else a walk. Kept for a few seconds. */
export async function listProjectFiles(root: string): Promise<string[]> {
  const key = path.resolve(root).toLowerCase();
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < LIST_TTL) return hit.files;
  let files: string[] | undefined;
  const git = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--full-name", "."], root);
  if (git && git.length) {
    // From a subfolder of a repository, git lists the repository's paths: keep this folder's, relative to it.
    const top = await run("git", ["rev-parse", "--show-prefix"], root);
    const prefix = top ? top.toString("utf8").trim() : "";
    files = git
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((f) => f.replace(/\\/g, "/"))
      .filter((f) => !prefix || f.startsWith(prefix))
      .map((f) => (prefix ? f.slice(prefix.length) : f));
    // A tracked file that was deleted in the working copy is listed too: it isn't there to read.
  }
  files ??= await walk(root);
  files = [...new Set(files)].filter((f) => f && !f.split("/").some((seg) => seg === ".git"));
  listCache.set(key, { at: Date.now(), files });
  return files;
}

export function forgetProjectFiles(root?: string): void {
  if (root) listCache.delete(path.resolve(root).toLowerCase());
  else listCache.clear();
}

// ------------------------------------------------------------------ reading, kept for a moment so typing is instant

const textCache = new Map<string, { at: number; text: string | null; bytes: number }>();
let cacheBytes = 0;
const CACHE_TTL = 15_000;
const CACHE_MAX = 64 * 1024 * 1024;

async function readText(root: string, rel: string): Promise<{ text: string | null; bytes: number }> {
  const full = path.join(root, rel);
  const cached = textCache.get(full);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached;
  let text: string | null = null;
  let bytes = 0;
  try {
    const st = await fs.promises.lstat(full);
    bytes = st.size;
    if (st.isFile() && !st.isSymbolicLink() && st.size <= MAX_BYTES) {
      const buf = await fs.promises.readFile(full);
      // A NUL in the first 8 KB: not text.
      if (!buf.subarray(0, 8192).includes(0)) text = buf.toString("utf8");
    }
  } catch {
    text = null;
  }
  const entry = { at: Date.now(), text, bytes };
  if (text && text.length < 2 * 1024 * 1024) {
    textCache.set(full, entry);
    cacheBytes += text.length * 2;
    if (cacheBytes > CACHE_MAX) {
      for (const [k, v] of textCache) {
        textCache.delete(k);
        cacheBytes -= (v.text?.length ?? 0) * 2;
        if (cacheBytes < CACHE_MAX * 0.7) break;
      }
    }
  }
  return entry;
}

// ------------------------------------------------------------------ fuzzy names

/**
 * Subsequence match of `query` in `text`, scored like a quick-open: consecutive letters, a letter at the start
 * of a word (after / . - _ or a capital) and in the file's own name count more; a shorter path wins ties.
 * Returns the matched positions, or undefined.
 */
export function fuzzyMatch(text: string, query: string): { score: number; positions: number[] } | undefined {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return { score: 0, positions: [] };
  // A quick check first: is it a subsequence at all?
  let at = 0;
  for (const ch of q) {
    at = t.indexOf(ch, at);
    if (at < 0) return undefined;
    at++;
  }
  const nameStart = text.lastIndexOf("/") + 1;
  const boundary = (i: number) => i === 0 || "/._- ".includes(text[i - 1]) || (text[i - 1] === text[i - 1].toLowerCase() && text[i] !== text[i].toLowerCase());
  const n = t.length;
  const m = q.length;
  // best[i][j]: the best score matching q[0..j] with q[j] at text position i.
  const NEG = -1e9;
  const best: number[][] = Array.from({ length: m }, () => new Array<number>(n).fill(NEG));
  const from: number[][] = Array.from({ length: m }, () => new Array<number>(n).fill(-1));
  for (let j = 0; j < m; j++) {
    for (let i = j; i < n; i++) {
      if (t[i] !== q[j]) continue;
      let gain = 1;
      if (boundary(i)) gain += 8;
      if (i >= nameStart) gain += 4;
      if (j === 0) {
        best[j][i] = gain - Math.min(i, 30) * 0.05;
        continue;
      }
      let top = NEG;
      let src = -1;
      for (let k = j - 1; k < i; k++) {
        const prev = best[j - 1][k];
        if (prev === NEG) continue;
        const v = prev + (k === i - 1 ? 10 : -Math.min(i - k - 1, 10) * 0.5);
        if (v > top) {
          top = v;
          src = k;
        }
      }
      if (src >= 0) {
        best[j][i] = top + gain;
        from[j][i] = src;
      }
    }
  }
  let end = -1;
  let score = NEG;
  for (let i = m - 1; i < n; i++)
    if (best[m - 1][i] > score) {
      score = best[m - 1][i];
      end = i;
    }
  if (end < 0) return undefined;
  const positions: number[] = [];
  for (let j = m - 1, i = end; j >= 0; j--) {
    positions.unshift(i);
    i = from[j][i];
  }
  // A name that is the query (or starts with it) is the file meant.
  const name = t.slice(nameStart);
  if (name === q) score += 30;
  else if (name.startsWith(q)) score += 15;
  else if (name.includes(q)) score += 8;
  return { score: score - text.length * 0.02, positions };
}

function rangesOf(positions: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const p of positions) {
    const last = out[out.length - 1];
    if (last && last[1] === p) last[1] = p + 1;
    else out.push([p, p + 1]);
  }
  return out;
}

// ------------------------------------------------------------------ lines

const DEFINITION = /^\s*(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(pub(\([a-z]+\))?\s+)?(function\*?|class|interface|type|enum|namespace|module|const|let|var|def|fn|func|struct|trait|impl|record|object|data class|sealed class)\s/;
const IMPORT = /^\s*(import\s|from\s.+\simport\s|(const|let|var)\s.+=\s*require\(|use\s|#include\s|using\s|require\s)/;
const COMMENT = /^\s*(\/\/|#|\*|\/\*|--|<!--|;)/;

/** What a matching line is: a comment, an import, or the definition of what matched (the match is on the name being defined). */
function kindOfLine(line: string, ranges: [number, number][]): HitKind | undefined {
  if (COMMENT.test(line)) return "comment";
  if (IMPORT.test(line)) return "import";
  const d = DEFINITION.exec(line);
  if (d) {
    const start = d[0].length;
    const name = /^[\w$]+/.exec(line.slice(start));
    const end = start + (name?.[0].length ?? 0);
    if (ranges.some(([a, b]) => a < end && b > start)) return "definition";
  }
  return undefined;
}

/** A line cut to a readable length around its first match, with the matches' positions in the cut text. */
function clip(line: string, ranges: [number, number][]): { text: string; ranges: [number, number][] } {
  if (line.length <= MAX_LINE) return { text: line, ranges };
  const first = ranges[0]?.[0] ?? 0;
  const start = Math.max(0, Math.min(first - 80, line.length - MAX_LINE));
  const end = Math.min(line.length, start + MAX_LINE);
  const shift = start > 0 ? 1 : 0;
  const text = (start > 0 ? "…" : "") + line.slice(start, end) + (end < line.length ? "…" : "");
  const out: [number, number][] = [];
  for (const [a, b] of ranges) {
    if (b <= start || a >= end) continue;
    out.push([Math.max(a, start) - start + shift, Math.min(b, end) - start + shift]);
  }
  return { text, ranges: out };
}

const clipPlain = (line: string) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The pattern a search runs, or why it can't. */
export function buildPattern(o: Pick<SearchOptions, "query" | "caseSensitive" | "wholeWord" | "regex">): { re?: RegExp; error?: string } {
  const q = o.query;
  if (!q) return { error: "Type something to search for." };
  const smartCase = o.caseSensitive === undefined ? /[A-Z]/.test(q.replace(/\\[A-Za-z]/g, "")) : o.caseSensitive;
  let source = o.regex ? q : escapeRegex(q);
  if (o.wholeWord) source = `(?<![\\w$])(?:${source})(?![\\w$])`;
  try {
    const re = new RegExp(source, smartCase ? "gu" : "giu");
    // A pattern that matches nothing at all (an empty match) would flag every line.
    if (re.test("")) return { error: "That pattern matches an empty string, so it would match every line." };
    re.lastIndex = 0;
    return { re };
  } catch (err) {
    try {
      // Without the unicode flag some patterns (\- in a class) are valid.
      const re = new RegExp(source, smartCase ? "g" : "gi");
      if (re.test("")) return { error: "That pattern matches an empty string, so it would match every line." };
      re.lastIndex = 0;
      return { re };
    } catch {
      return { error: (err as Error).message.replace(/^Invalid regular expression: /, "") };
    }
  }
}

// ------------------------------------------------------------------ the search

const TEST_PATH = /(^|\/)(__tests__|tests?|spec|fixtures?|__mocks__|e2e|snapshots?)(\/|$)|\.(test|spec)\.[a-z]+$/i;
const DOC_PATH = /(^|\/)(docs?|examples?|samples?)(\/|$)|\.(md|mdx|txt|rst)$/i;

function folderOf(rel: string): string {
  const segs = rel.split("/");
  segs.pop();
  return segs.slice(0, 2).join("/");
}

function facetsOf<T extends FileResult>(files: T[], get: (f: T) => string, limit: number): SearchFacet[] {
  const counts = new Map<string, number>();
  for (const f of files) counts.set(get(f), (counts.get(get(f)) ?? 0) + 1);
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, limit);
}

/** Searches one project folder. */
export async function searchProject(root: string, options: SearchOptions): Promise<SearchResult> {
  const started = Date.now();
  const mode: SearchMode = options.mode ?? "all";
  const query = options.query.slice(0, 200);
  const budget = Math.max(500, options.budgetMs ?? 5000);
  const perFile = Math.max(1, Math.min(options.perFile ?? 8, 50));
  const context = Math.max(0, Math.min(options.context ?? 2, 5));
  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? 100, 500));
  const empty = (extra: Partial<SearchResult> = {}): SearchResult => ({ query, mode, files: [], totals: { files: 0, matches: 0, scanned: 0, skipped: 0, ms: Date.now() - started }, facets: { ext: [], folder: [] }, truncated: false, partial: false, ...extra });
  if (!query.trim()) return empty();

  const all = await listProjectFiles(root);
  const extWanted = options.ext?.length ? new Set(options.ext.map((e) => e.toLowerCase().replace(/^\./, ""))) : undefined;
  const folderWanted = options.folders?.length ? options.folders.map((f) => f.replace(/\\/g, "/").replace(/\/+$/, "")) : undefined;

  const found = new Map<string, FileResult>();
  const make = (rel: string): FileResult => {
    let f = found.get(rel);
    if (!f) {
      f = { path: rel, ext: extOf(rel), folder: folderOf(rel), score: 0, nameRanges: [], nameMatch: false, lines: 0, matches: 0, hits: [], bytes: 0 };
      found.set(rel, f);
    }
    return f;
  };

  // Names: every word of the query must match somewhere in the path.
  if (mode !== "content") {
    const words = query.trim().split(/\s+/).slice(0, 4);
    for (const rel of all) {
      let score = 0;
      const positions: number[] = [];
      let ok = true;
      for (const w of words) {
        const m = fuzzyMatch(rel, w);
        if (!m) {
          ok = false;
          break;
        }
        score += m.score;
        positions.push(...m.positions);
      }
      if (!ok) continue;
      const f = make(rel);
      f.nameMatch = true;
      f.score += score / words.length + 20;
      f.nameRanges = rangesOf([...new Set(positions)].sort((a, b) => a - b));
    }
    // A name query that matched nearly everything says nothing: keep the best few hundred.
    if (found.size > 2000) {
      const keep = [...found.values()].sort((a, b) => b.score - a.score).slice(0, 500);
      found.clear();
      for (const f of keep) found.set(f.path, f);
    }
  }

  let scanned = 0;
  let skipped = 0;
  let partial = false;
  let patternError: string | undefined;

  if (mode !== "files") {
    const pattern = buildPattern({ query, caseSensitive: options.caseSensitive, wholeWord: options.wholeWord, regex: options.regex });
    if (!pattern.re) {
      if (mode === "content") return empty({ patternError: pattern.error });
      patternError = options.regex ? pattern.error : undefined;
    } else {
      const re = pattern.re;
      const candidates = all.filter((rel) => {
        const ext = extOf(rel);
        const name = rel.split("/").pop() ?? rel;
        if (BINARY_EXT.has(ext) || LOCK_NAMES.has(name) || isSecretFile(rel) || /\.min\.(js|css)$/.test(name)) {
          skipped++;
          return false;
        }
        return true;
      });
      const deadline = started + budget;
      await mapLimit(
        candidates,
        24,
        async (rel) => {
          if (Date.now() > deadline) {
            partial = true;
            return;
          }
          const { text, bytes } = await readText(root, rel);
          if (text === null) {
            skipped++;
            return;
          }
          scanned++;
          // A quick look before splitting the file into lines.
          re.lastIndex = 0;
          if (!re.test(text.length > 4_000_000 ? text.slice(0, 4_000_000) : text)) return;
          const lines = text.split(/\r?\n/);
          let matches = 0;
          let lineCount = 0;
          const hits: Hit[] = [];
          for (let i = 0; i < lines.length; i++) {
            const raw = lines[i].length > SCAN_LINE ? lines[i].slice(0, SCAN_LINE) : lines[i];
            re.lastIndex = 0;
            const ranges: [number, number][] = [];
            let m: RegExpExecArray | null;
            while ((m = re.exec(raw)) && ranges.length < 50) {
              if (m[0].length === 0) {
                re.lastIndex++;
                continue;
              }
              ranges.push([m.index, m.index + m[0].length]);
            }
            if (!ranges.length) continue;
            lineCount++;
            matches += ranges.length;
            if (hits.length < perFile) {
              const c = clip(raw, ranges);
              const before: ContextLine[] = [];
              const after: ContextLine[] = [];
              for (let k = Math.max(0, i - context); k < i; k++) before.push({ line: k + 1, text: clipPlain(lines[k]) });
              for (let k = i + 1; k <= Math.min(lines.length - 1, i + context); k++) after.push({ line: k + 1, text: clipPlain(lines[k]) });
              hits.push({ line: i + 1, text: c.text, ranges: c.ranges, kind: kindOfLine(raw, ranges), before, after });
            }
            if (matches >= 500) break;
          }
          if (!matches) return;
          const f = make(rel);
          f.lines = lineCount;
          f.matches = matches;
          f.hits = hits;
          f.bytes = bytes;
          // More matching lines and a definition among them count; a test or a document counts for less.
          let s = Math.log2(1 + lineCount) * 6 + (hits.some((h) => h.kind === "definition") ? 14 : 0);
          if (TEST_PATH.test(rel)) s -= 6;
          if (DOC_PATH.test(rel)) s -= 3;
          s -= Math.min(rel.split("/").length, 8) * 0.4;
          f.score += s + 10;
        },
        () => undefined,
      );
    }
  }

  let results = [...found.values()];
  // A word that is also a file's name makes that file the likelier answer.
  const lower = query.trim().toLowerCase();
  for (const f of results) if (f.matches && (f.path.split("/").pop() ?? "").toLowerCase().includes(lower)) f.score += 8;

  // Facets count with the other facet applied, as the project list does.
  const byExt = (f: FileResult) => !extWanted || extWanted.has(f.ext);
  const byFolder = (f: FileResult) => !folderWanted || folderWanted.some((d) => f.path === d || f.path.startsWith(`${d}/`) || f.folder === d);
  const facets = {
    ext: facetsOf(results.filter(byFolder), (f) => f.ext || "(none)", 12),
    folder: facetsOf(results.filter(byExt), (f) => f.folder || "(root)", 12),
  };
  results = results.filter((f) => byExt(f) && byFolder(f)).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const totals = { files: results.length, matches: results.reduce((n, f) => n + f.matches, 0), scanned, skipped, ms: Date.now() - started };
  return { query, mode, files: results.slice(0, maxFiles), totals, facets, truncated: results.length > maxFiles, partial, patternError };
}

/** Several projects at once: each searched, the files put together by score, each carrying its project. */
export interface ProjectSearch {
  name: string;
  dir: string;
}

export type ProjectFileResult = FileResult & { project: string; dir: string };

export async function searchProjects(projects: ProjectSearch[], options: SearchOptions): Promise<Omit<SearchResult, "files"> & { projects: { name: string; dir: string; files: number }[]; files: ProjectFileResult[] }> {
  const started = Date.now();
  const per = await mapLimit(projects, 3, (p) => searchProject(p.dir, { ...options, maxFiles: 500, budgetMs: options.budgetMs ?? 6000 }), () => undefined);
  const files: ProjectFileResult[] = [];
  const summary: { name: string; dir: string; files: number }[] = [];
  let matches = 0;
  let scanned = 0;
  let skipped = 0;
  let partial = false;
  let patternError: string | undefined;
  per.forEach((r, i) => {
    if (!r) return;
    const p = projects[i];
    summary.push({ name: p.name, dir: p.dir, files: r.totals.files });
    matches += r.totals.matches;
    scanned += r.totals.scanned;
    skipped += r.totals.skipped;
    partial ||= r.partial;
    patternError ??= r.patternError;
    for (const f of r.files) files.push({ ...f, project: p.name, dir: p.dir });
  });
  files.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? 100, 500));
  return {
    query: options.query.slice(0, 200),
    mode: options.mode ?? "all",
    files: files.slice(0, maxFiles),
    totals: { files: files.length, matches, scanned, skipped, ms: Date.now() - started },
    facets: { ext: facetsOf(files, (f) => f.ext || "(none)", 12), folder: facetsOf(files, (f) => f.project, 12) },
    truncated: files.length > maxFiles,
    partial,
    patternError,
    projects: summary.sort((a, b) => b.files - a.files),
  };
}

/**
 * A window of a file for a preview: only a file the project lists, never a secrets file, a link, or a
 * binary or very large one. Lines are numbered from 1 and cut to a readable length.
 */
export async function readFileWindow(root: string, rel: string, from: number, to: number): Promise<{ path: string; total: number; from: number; lines: ContextLine[]; ext: string } | undefined> {
  const clean = rel.replace(/\\/g, "/");
  if (!clean || clean.startsWith("/") || clean.split("/").includes("..") || isSecretFile(clean)) return undefined;
  const files = await listProjectFiles(root);
  if (!files.includes(clean)) return undefined;
  const { text } = await readText(root, clean);
  if (text === null) return undefined;
  const lines = text.split(/\r?\n/);
  // The newline that ends the file isn't a line of its own.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const start = Math.max(1, Math.min(from, lines.length));
  const end = Math.min(lines.length, Math.max(start, Math.min(to, start + 400)));
  const out: ContextLine[] = [];
  for (let i = start; i <= end; i++) out.push({ line: i, text: clipPlain(lines[i - 1]) });
  return { path: clean, total: lines.length, from: start, lines: out, ext: extOf(clean) };
}
