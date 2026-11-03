import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, type DxConfig } from "../config.js";
import { commandExists } from "./doctor.js";
import { findProjects, scanProjects, type PackageManager, type Project } from "./projects.js";

/**
 * Dependency audit across all your Node projects: which packages are out of date (and which of
 * those are a major version behind) and how many known vulnerabilities `npm audit` reports.
 */
export interface OutdatedPackage {
  name: string;
  /** Installed version; undefined when node_modules isn't installed. */
  current?: string;
  /** Newest version the package.json range allows. */
  wanted?: string;
  latest: string;
  /** The latest version is a new major version, so updating may need code changes. */
  major: boolean;
}

export interface VulnerabilityCounts {
  critical: number;
  high: number;
  moderate: number;
  low: number;
  info: number;
  total: number;
}

export interface DepsReport {
  project: string;
  dir: string;
  packageManager: PackageManager;
  outdated: OutdatedPackage[];
  /** Undefined when the audit couldn't run (see `notes`). */
  vulnerabilities?: VulnerabilityCounts;
  /** Why something is missing, e.g. "no lockfile, so npm audit can't run". */
  notes: string[];
  /** Set when this package manager isn't supported or installed; nothing was checked. */
  skipped?: string;
}

export interface DepsOptions {
  /** Only projects matching this name. */
  query?: string;
  /** Only projects active in the last N days. */
  activeDays?: number;
  config?: DxConfig;
  now?: Date;
  onProgress?: (done: number, total: number, project: string) => void;
  /** Projects checked at the same time (default 4). */
  concurrency?: number;
}

const TIMEOUT_MS = 180_000;

export async function auditDependencies(options: DepsOptions = {}): Promise<DepsReport[]> {
  const config = options.config ?? loadConfig();
  let projects = scanProjects(config).filter((p) => p.kind === "node");
  if (options.query) projects = findProjects(options.query, projects).candidates;
  if (options.activeDays !== undefined) {
    const cutoff = (options.now ?? new Date()).getTime() - options.activeDays * 86_400_000;
    projects = projects.filter((p) => p.lastActive >= cutoff);
  }

  const reports: DepsReport[] = [];
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < projects.length) {
      const project = projects[next++];
      options.onProgress?.(done, projects.length, project.name);
      reports.push(await auditProject(project));
      done++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 4, projects.length) }, worker));
  options.onProgress?.(done, projects.length, "");
  return reports.sort((a, b) => severityRank(b) - severityRank(a) || b.outdated.length - a.outdated.length);
}

async function auditProject(project: Project): Promise<DepsReport> {
  const pm = project.packageManager ?? "npm";
  const report: DepsReport = { project: project.name, dir: project.dir, packageManager: pm, outdated: [], notes: [] };
  // yarn and bun don't print the same JSON as npm, so they're checked against the registry directly.
  if (pm === "yarn" || pm === "bun") return auditFromRegistry(project, report);
  if (pm === "pnpm" && !(await commandExists("pnpm"))) {
    report.skipped = "pnpm isn't installed";
    return report;
  }

  const has = (f: string) => fs.existsSync(path.join(project.dir, f));
  const [outdated, audit] = await Promise.all([
    runJson(project.dir, pm === "pnpm" ? "pnpm outdated --format json" : "npm outdated --json"),
    has(pm === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json")
      ? runJson(project.dir, `${pm} audit --json`)
      : Promise.resolve({ error: "no lockfile, so the audit can't run (run an install first)" }),
  ]);

  if ("json" in outdated) report.outdated = parseOutdated(outdated.json);
  else report.notes.push(`outdated check failed: ${outdated.error}`);
  if (!has("node_modules")) report.notes.push("not installed, so current versions are unknown");

  if ("json" in audit) {
    const counts = parseAuditCounts(audit.json);
    if (counts) report.vulnerabilities = counts;
    else report.notes.push(`audit failed: ${auditError(audit.json) ?? "unexpected output"}`);
  } else {
    report.notes.push(audit.error);
  }
  return report;
}

const REGISTRY = "https://registry.npmjs.org";

/**
 * Any package manager: the versions installed in node_modules, the latest on the npm registry,
 * and the registry's advisories for the installed versions (the same source npm audit uses).
 */
async function auditFromRegistry(project: Project, report: DepsReport, fetchImpl: typeof fetch = fetch): Promise<DepsReport> {
  const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(path.join(project.dir, "package.json")) ?? {};
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  // Only packages from the registry: not workspace:, file:, link:, git or URL dependencies.
  const names = Object.entries(declared)
    .filter(([, range]) => !/^(workspace:|file:|link:|portal:|git|https?:|github:)|\//.test(range))
    .map(([name]) => name);
  const nm = path.join(project.dir, "node_modules");
  if (!fs.existsSync(nm)) {
    report.notes.push(fs.existsSync(path.join(project.dir, ".pnp.cjs")) ? "uses Yarn Plug'n'Play, so installed versions can't be read" : "not installed, so current versions are unknown");
  }

  let failed = 0;
  const latest = new Map<string, string>();
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const name = names[next++];
      try {
        const res = await fetchImpl(`${REGISTRY}/${name.replace("/", "%2f")}/latest`, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(String(res.status));
        latest.set(name, ((await res.json()) as { version: string }).version);
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, names.length) }, worker));
  if (failed) report.notes.push(`${failed} package(s) couldn't be looked up on the npm registry`);

  for (const name of names) {
    const l = latest.get(name);
    if (!l) continue;
    const current = readJson<{ version?: string }>(path.join(nm, name, "package.json"))?.version;
    if (current === l) continue;
    if (!current && !sameMajorRange(declared[name], l)) {
      report.outdated.push({ name, current, wanted: undefined, latest: l, major: true });
    } else if (current) {
      report.outdated.push({ name, current, wanted: undefined, latest: l, major: isMajorBump(current, l) });
    }
  }
  report.outdated.sort((a, b) => Number(b.major) - Number(a.major) || a.name.localeCompare(b.name));

  const installed = installedVersions(nm);
  if (installed.size) {
    try {
      const body = Object.fromEntries([...installed].map(([n, v]) => [n, [...v]]));
      const res = await fetchImpl(`${REGISTRY}/-/npm/v1/security/advisories/bulk`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`the registry answered ${res.status}`);
      report.vulnerabilities = countAdvisories(await res.json());
    } catch (err) {
      report.notes.push(`audit failed: ${(err as Error).message}`);
    }
  }
  return report;
}

/** Counts the bulk advisory answer by severity: { name: [{ severity }] }. */
export function countAdvisories(json: unknown): VulnerabilityCounts {
  const counts: VulnerabilityCounts = { critical: 0, high: 0, moderate: 0, low: 0, info: 0, total: 0 };
  if (json && typeof json === "object") {
    for (const list of Object.values(json as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      for (const a of list as { severity?: string }[]) {
        const s = a.severity as keyof VulnerabilityCounts;
        if (s && s in counts && s !== "total") counts[s]++;
        counts.total++;
      }
    }
  }
  return counts;
}

/** Every package in node_modules (nested ones too), with its versions. */
function installedVersions(nm: string, out = new Map<string, Set<string>>(), depth = 0): Map<string, Set<string>> {
  if (depth > 6) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(nm, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const dirs = e.name.startsWith("@")
      ? safeList(path.join(nm, e.name)).map((s) => path.join(nm, e.name, s))
      : [path.join(nm, e.name)];
    for (const dir of dirs) {
      const p = readJson<{ name?: string; version?: string }>(path.join(dir, "package.json"));
      if (p?.name && p.version) {
        if (!out.has(p.name)) out.set(p.name, new Set());
        out.get(p.name)!.add(p.version);
      }
      installedVersions(path.join(dir, "node_modules"), out, depth + 1);
    }
  }
  return out;
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** "^1.2.0" and "1.9.0": the range already covers the latest major. */
function sameMajorRange(range: string | undefined, latest: string): boolean {
  const m = /(\d+)/.exec(range ?? "");
  const l = /(\d+)/.exec(latest);
  return !!m && !!l && m[1] === l[1];
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export interface FixResult {
  project: string;
  dir: string;
  ok: boolean;
  /** The commands run, each with whether it worked. */
  steps: { command: string; ok: boolean; output?: string }[];
  before: DepsReport;
  after?: DepsReport;
}

/**
 * Updates packages within the ranges package.json allows, then lets the package manager fix what
 * it can of the audit without breaking changes. Major versions are left alone: they may need code
 * changes, and dx lists them.
 */
export async function fixDependencies(project: Project): Promise<FixResult> {
  const pm = project.packageManager ?? "npm";
  const before = await auditProject(project);
  const commands: string[] = [];
  if (pm === "npm") commands.push("npm update", "npm audit fix");
  else if (pm === "pnpm") commands.push("pnpm update");
  else if (pm === "bun") commands.push("bun update");
  else if (pm === "yarn") commands.push((await yarnMajor(project.dir)) >= 2 ? "yarn up -R \"**\"" : "yarn upgrade");
  if (!(await commandExists(pm))) {
    return { project: project.name, dir: project.dir, ok: false, steps: [{ command: commands[0], ok: false, output: `${pm} isn't installed` }], before };
  }
  const steps: FixResult["steps"] = [];
  for (const command of commands) {
    // The commands are fixed words above; nothing from a request reaches the shell.
    const r = await new Promise<{ ok: boolean; output: string }>((resolve) =>
      exec(command, { cwd: project.dir, timeout: 600_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NO_UPDATE_NOTIFIER: "1" } }, (err, stdout, stderr) =>
        resolve({ ok: !err, output: `${stdout}\n${stderr}`.trim().split(/\r?\n/).slice(-5).join("\n") }),
      ),
    );
    // npm audit fix exits 1 when some problems need a major update; that isn't a failed fix.
    steps.push({ command, ok: r.ok || command === "npm audit fix", output: r.output });
  }
  const after = await auditProject(project);
  return { project: project.name, dir: project.dir, ok: steps.every((s) => s.ok), steps, before, after };
}

async function yarnMajor(dir: string): Promise<number> {
  return new Promise((resolve) => exec("yarn --version", { cwd: dir, windowsHide: true, timeout: 20_000 }, (err, out) => resolve(err ? 1 : Number(String(out).split(".")[0]) || 1)));
}

/** Exported for tests: the registry check with a stand-in fetch. */
export function _auditFromRegistry(project: Project, fetchImpl: typeof fetch): Promise<DepsReport> {
  return auditFromRegistry(project, { project: project.name, dir: project.dir, packageManager: project.packageManager ?? "yarn", outdated: [], notes: [] }, fetchImpl);
}

/**
 * Runs a package manager command that prints JSON. `npm outdated` and `npm audit` exit with 1
 * when they find something, so the exit code is ignored as long as the output is JSON.
 */
function runJson(cwd: string, command: string): Promise<{ json: unknown } | { error: string }> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NO_UPDATE_NOTIFIER: "1" } },
      (err, stdout, stderr) => {
        const text = String(stdout).trim();
        if (!text) {
          if (!err) return resolve({ json: {} });
          const killed = (err as { killed?: boolean }).killed;
          return resolve({ error: killed ? "timed out" : firstLine(String(stderr)) || err.message });
        }
        try {
          resolve({ json: JSON.parse(text) });
        } catch {
          resolve({ error: firstLine(String(stderr)) || "output wasn't JSON" });
        }
      },
    );
  });
}

/** Reads `npm outdated --json` or `pnpm outdated --format json`. */
export function parseOutdated(json: unknown): OutdatedPackage[] {
  if (!json || typeof json !== "object" || Array.isArray(json)) return [];
  const out: OutdatedPackage[] = [];
  for (const [name, raw] of Object.entries(json as Record<string, unknown>)) {
    // npm prints an array when the same package is outdated in several workspaces.
    const entry = (Array.isArray(raw) ? raw[0] : raw) as { current?: string; wanted?: string; latest?: string } | undefined;
    if (!entry?.latest) continue;
    const current = entry.current && entry.current !== "MISSING" ? entry.current : undefined;
    const base = current ?? entry.wanted;
    out.push({ name, current, wanted: entry.wanted, latest: entry.latest, major: isMajorBump(base, entry.latest) });
  }
  return out.sort((a, b) => Number(b.major) - Number(a.major) || a.name.localeCompare(b.name));
}

/** Reads the totals from `npm audit --json` (v2 and v1) or `pnpm audit --json`. */
export function parseAuditCounts(json: unknown): VulnerabilityCounts | undefined {
  const v = (json as { metadata?: { vulnerabilities?: Partial<VulnerabilityCounts> } })?.metadata?.vulnerabilities;
  if (!v || typeof v !== "object") return undefined;
  const n = (k: keyof VulnerabilityCounts) => (typeof v[k] === "number" ? (v[k] as number) : 0);
  const counts = { critical: n("critical"), high: n("high"), moderate: n("moderate"), low: n("low"), info: n("info"), total: 0 };
  counts.total = typeof v.total === "number" ? v.total : counts.critical + counts.high + counts.moderate + counts.low + counts.info;
  return counts;
}

function auditError(json: unknown): string | undefined {
  const e = (json as { error?: { summary?: string; code?: string } })?.error;
  return e?.summary ? firstLine(e.summary) : e?.code;
}

/** "2 critical, 1 high" (most severe first), or "none". */
export function describeVulnerabilities(v?: VulnerabilityCounts): string {
  if (!v) return "?";
  const parts = (["critical", "high", "moderate", "low"] as const).filter((k) => v[k] > 0).map((k) => `${v[k]} ${k}`);
  return parts.length ? parts.join(", ") : "none";
}

function severityRank(r: DepsReport): number {
  const v = r.vulnerabilities;
  if (!v) return -1;
  return v.critical * 1_000_000 + v.high * 10_000 + v.moderate * 100 + v.low;
}

/** 1.x → 2.x, and for 0.x versions 0.4 → 0.5 too, since those count as breaking in semver. */
export function isMajorBump(from: string | undefined, to: string): boolean {
  const parse = (v?: string) => {
    const m = /(\d+)(?:\.(\d+))?/.exec(v ?? "");
    return m ? [Number(m[1]), Number(m[2] ?? 0)] : undefined;
  };
  const a = parse(from);
  const b = parse(to);
  if (!a || !b) return false;
  if (b[0] !== a[0]) return b[0] > a[0];
  return a[0] === 0 && b[1] > a[1];
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.replace(/^npm (ERR!|error)\s*/i, "").trim()).find(Boolean) ?? "";
}
