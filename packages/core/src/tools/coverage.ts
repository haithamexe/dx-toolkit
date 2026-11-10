import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Test coverage, read from each framework's own report the way the test results are: vitest and
 * jest write an istanbul summary, pytest-cov a JSON file, `go test` a cover profile, and a node:test
 * run leaves V8's raw coverage (read here the way c8 does, per line). Percentages only, and the
 * files with the least coverage first: no source code is kept.
 */

export interface CoverageFile {
  /** Relative to the project, forward slashes. */
  file: string;
  /** Percent of lines (or statements) run, 0 to 100. */
  lines: number;
}

export interface Coverage {
  /** Percent of lines run by the tests. */
  lines: number;
  statements?: number;
  functions?: number;
  branches?: number;
  /** The files with the least coverage, lowest first (at most 15). */
  files: CoverageFile[];
  /** How many files are counted. */
  fileCount: number;
  /** What the numbers are of, when that isn't plain: "built files (dist), not TypeScript". */
  note?: string;
}

const round = (n: number) => Math.round(n * 10) / 10;
const pct = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 100 ? round(x) : undefined);
const slash = (s: string) => s.replace(/\\/g, "/");
const rel = (dir: string, file: string) => {
  const r = path.relative(dir, path.resolve(dir, file));
  return slash(r && !r.startsWith("..") && !path.isAbsolute(r) ? r : file);
};

function finish(lines: number, files: CoverageFile[], extra: Partial<Coverage> = {}): Coverage {
  const sorted = [...files].sort((a, b) => a.lines - b.lines || a.file.localeCompare(b.file));
  const built = files.length > 0 && files.every((f) => /(^|\/)(dist|build|out)\//.test(f.file));
  return { lines: round(lines), files: sorted.slice(0, 15), fileCount: files.length, ...(built ? { note: "Lines of the built files (dist), not of your TypeScript" } : {}), ...extra };
}

/** vitest and jest with the json-summary reporter (istanbul's shape). */
export function parseCoverageSummary(text: string, dir: string): Coverage | undefined {
  const j = JSON.parse(text) as Record<string, Record<string, { pct?: unknown }>>;
  const total = j.total;
  const lines = pct(total?.lines?.pct) ?? pct(total?.statements?.pct);
  if (lines === undefined) return undefined;
  const files: CoverageFile[] = [];
  for (const [file, v] of Object.entries(j)) {
    if (file === "total") continue;
    const p = pct(v.lines?.pct) ?? pct(v.statements?.pct);
    if (p !== undefined) files.push({ file: rel(dir, file), lines: p });
  }
  return finish(lines, files, { statements: pct(total.statements?.pct), functions: pct(total.functions?.pct), branches: pct(total.branches?.pct) });
}

/** pytest-cov's `--cov-report=json`. */
export function parsePytestCoverage(text: string, dir: string): Coverage | undefined {
  const j = JSON.parse(text) as { totals?: { percent_covered?: unknown }; files?: Record<string, { summary?: { percent_covered?: unknown } }> };
  const lines = pct(j.totals?.percent_covered);
  if (lines === undefined) return undefined;
  const files: CoverageFile[] = [];
  for (const [file, v] of Object.entries(j.files ?? {})) {
    const p = pct(v.summary?.percent_covered);
    if (p !== undefined) files.push({ file: rel(dir, file), lines: p });
  }
  return finish(lines, files);
}

/** `go test -coverprofile`: "file.go:10.2,12.3 2 1" is a block of 2 statements run once. */
export function parseGoCover(text: string): Coverage | undefined {
  const perFile = new Map<string, { total: number; covered: number }>();
  let total = 0;
  let covered = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = /^(.+?):\d+\.\d+,\d+\.\d+ (\d+) (\d+)$/.exec(line);
    if (!m) continue;
    const stmts = Number(m[2]);
    const hit = Number(m[3]) > 0;
    const f = perFile.get(m[1]) ?? { total: 0, covered: 0 };
    f.total += stmts;
    if (hit) f.covered += stmts;
    perFile.set(m[1], f);
    total += stmts;
    if (hit) covered += stmts;
  }
  if (!total) return undefined;
  const files = [...perFile].map(([file, f]) => ({ file: slash(file), lines: round((f.covered / f.total) * 100) }));
  return finish((covered / total) * 100, files, { statements: round((covered / total) * 100) });
}

interface V8Range {
  startOffset: number;
  endOffset: number;
  count: number;
}

const TEST_FILE = /(^|[\\/])(__tests__|tests?|spec|specs)[\\/]|\.(test|spec)\.[cm]?[jt]sx?$/i;

/**
 * Raw V8 coverage (NODE_V8_COVERAGE's files) as line coverage of the project's own files, the way
 * c8 reads it: each script's ranges, the outer ones first so an inner range overrides, and a line
 * counts when any code on it ran. Test files, node_modules and node's own modules are left out.
 */
export function parseV8Coverage(folder: string, dir: string): Coverage | undefined {
  let names: string[] = [];
  try {
    names = fs.readdirSync(folder).filter((f) => /^coverage-.*\.json$/.test(f));
  } catch {
    return undefined;
  }
  // V8 reports real paths: a project reached through a link (macOS /var, a junction) is compared by where it really is.
  const root = (() => {
    try {
      return fs.realpathSync(dir);
    } catch {
      return path.resolve(dir);
    }
  })();
  const ran = new Map<string, Uint8Array>();
  const sources = new Map<string, string>();
  for (const name of names) {
    let result: { url?: string; functions?: { ranges?: V8Range[] }[] }[] = [];
    try {
      result = (JSON.parse(fs.readFileSync(path.join(folder, name), "utf8")) as { result?: typeof result }).result ?? [];
    } catch {
      continue;
    }
    for (const script of result) {
      if (!script.url?.startsWith("file://")) continue;
      let file: string;
      try {
        // The script's real place, to compare with the project's real place (a link, macOS' /var, a junction).
        file = fs.realpathSync(fileURLToPath(script.url));
      } catch {
        continue;
      }
      const inside = path.relative(root, file);
      if (!inside || inside === ".." || inside.startsWith(".." + path.sep) || path.isAbsolute(inside) || /(^|[\\/])node_modules[\\/]/.test(inside) || TEST_FILE.test(inside)) continue;
      let source = sources.get(file);
      if (source === undefined) {
        try {
          source = fs.readFileSync(file, "utf8");
        } catch {
          continue;
        }
        sources.set(file, source);
      }
      const counts = new Int32Array(source.length).fill(-1);
      const ranges = (script.functions ?? []).flatMap((f) => f.ranges ?? []).sort((a, b) => b.endOffset - b.startOffset - (a.endOffset - a.startOffset));
      for (const r of ranges) counts.fill(r.count, Math.max(0, r.startOffset), Math.min(source.length, r.endOffset));
      const seen = ran.get(file) ?? new Uint8Array(source.length);
      for (let i = 0; i < counts.length; i++) if (counts[i] > 0) seen[i] = 1;
      ran.set(file, seen);
    }
  }
  const files: CoverageFile[] = [];
  let total = 0;
  let covered = 0;
  for (const [file, seen] of ran) {
    const source = sources.get(file) ?? "";
    let t = 0;
    let c = 0;
    let offset = 0;
    for (const line of source.split("\n")) {
      const start = offset;
      offset += line.length + 1;
      if (!line.trim() || /^\s*(\/\/|\/\*|\*)/.test(line) || /^\s*[{}()[\];,]*\s*$/.test(line)) continue;
      t++;
      for (let i = start; i < start + line.length; i++) {
        if (seen[i] && !/\s/.test(source[i])) {
          c++;
          break;
        }
      }
    }
    if (!t) continue;
    total += t;
    covered += c;
    files.push({ file: rel(root, file), lines: round((c / t) * 100) });
  }
  if (!total) return undefined;
  return finish((covered / total) * 100, files);
}
