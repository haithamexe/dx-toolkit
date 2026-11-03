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
  if (pm === "yarn" || pm === "bun") {
    report.skipped = `${pm} projects aren't supported yet`;
    return report;
  }
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
