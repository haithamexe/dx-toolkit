import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { dxPath, ensureDxHome, loadConfig, type DxConfig } from "../config.js";
import { readRuns, type RunRecord } from "../runs.js";
import { fetchGithubActivity, githubToken, mostCommonOwner, type GithubActivity, type PullRequest } from "./github.js";
import { localDate, localTime, readJournal, type JournalEntry } from "./journal.js";
import { scanProjects, type Project } from "./projects.js";

const run = promisify(execFile);

/**
 * The weekly summary: your git commits across every project plus your work journal, for the last
 * few days, as markdown you can paste into a standup or a weekly update.
 */
export interface Commit {
  hash: string;
  date: string; // YYYY-MM-DD, local time
  time: string; // HH:MM, local time
  subject: string;
}

export interface ProjectActivity {
  project: string;
  dir: string;
  commits: Commit[];
}

export interface WorkSummary {
  /** First day included, YYYY-MM-DD. */
  from: string;
  /** Last day included (today), YYYY-MM-DD. */
  to: string;
  days: number;
  /** Whose commits were counted, e.g. "octocat <me@example.com>", or "everyone". */
  author: string;
  /** Only projects with at least one commit, most commits first. */
  projects: ProjectActivity[];
  journal: JournalEntry[];
  /** Repos git couldn't read; they're left out of the summary rather than failing it. */
  skipped: Array<{ project: string; reason: string }>;
  /** Where the days went: per project, the days with commits or a `dx go`, most days first. */
  time: ProjectTime[];
  /** Repos active in the window that have changes not committed yet. */
  uncommitted: Array<{ project: string; files: number }>;
  /** Pull requests from GitHub, when asked for. `error` says why they're missing. */
  github?: GithubActivity | { error: string };
}

export interface ProjectTime {
  project: string;
  /** Distinct days with a commit or a `dx go` for this project. */
  days: number;
  commits: number;
  /** How many times it was opened with `dx go` (CLI, Raycast or Claude). */
  opens: number;
  /** How long its dev server ran under `dx go`, in ms. Only counted when dx ran it in the same terminal. */
  devMs: number;
}

export interface SummaryOptions {
  /** How many days back, today included (default 7). */
  days?: number;
  now?: Date;
  config?: DxConfig;
  /** Count everyone's commits, not only yours. */
  allAuthors?: boolean;
  /** Also fetch merged and reviewed pull requests from GitHub (needs the internet). */
  github?: boolean;
}

const FIELD = "\x1f";
const MAX_PARALLEL = 6;

export async function buildSummary(options: SummaryOptions = {}): Promise<WorkSummary> {
  const days = Math.max(1, Math.floor(options.days ?? 7));
  const now = options.now ?? new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const config = options.config ?? loadConfig();
  const all = scanProjects(config);
  const repos = all.filter((p) => p.hasGit);

  const projects: ProjectActivity[] = [];
  const skipped: WorkSummary["skipped"] = [];
  const uncommitted: WorkSummary["uncommitted"] = [];
  const remotes: string[] = [];
  let gitMissing = false;
  const authors = new Set<string>();

  await inBatches(repos, MAX_PARALLEL, async (project) => {
    try {
      const who = options.allAuthors ? [] : await gitIdentity(project.dir);
      who.forEach((w) => authors.add(w));
      const commits = await commitsSince(project, start, who);
      if (commits.length) projects.push({ project: project.name, dir: project.dir, commits });
      if (commits.length || project.lastActive >= start.getTime()) {
        const files = await changedFiles(project.dir);
        if (files) uncommitted.push({ project: project.name, files });
      }
      if (options.github && !config.githubUser) {
        const url = await gitOutput(project.dir, ["remote", "get-url", "origin"]);
        if (url) remotes.push(url);
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      if (e.code === "ENOENT") gitMissing = true;
      skipped.push({ project: project.name, reason: firstLine(e.stderr) || e.message });
    }
  });

  if (gitMissing && projects.length === 0) {
    throw new Error("Git isn't installed or isn't on your PATH, so there are no commits to summarize.");
  }

  projects.sort((a, b) => b.commits.length - a.commits.length || a.project.localeCompare(b.project));
  skipped.sort((a, b) => a.project.localeCompare(b.project));
  uncommitted.sort((a, b) => b.files - a.files || a.project.localeCompare(b.project));

  let github: WorkSummary["github"];
  if (options.github) {
    const user = config.githubUser || mostCommonOwner(remotes);
    if (!user) {
      github = { error: "no GitHub username: set it with dx config github <username>" };
    } else {
      try {
        github = await fetchGithubActivity(user, localDate(start), await githubToken());
      } catch (err) {
        github = { error: (err as Error).message };
      }
    }
  }

  return {
    from: localDate(start),
    to: localDate(now),
    days,
    author: options.allAuthors ? "everyone" : [...authors].join(", ") || "you",
    projects,
    journal: readJournal({ sinceDays: days, now }),
    skipped,
    time: timePerProject(projects, readRuns(0), start, all.map((p) => p.name)),
    uncommitted,
    github,
  };
}

/**
 * Combines commit days with `dx go` runs from the run log. Old run records have no project field,
 * so for those the project is read from the start of the detail text.
 */
export function timePerProject(projects: ProjectActivity[], runs: RunRecord[], start: Date, knownNames: string[]): ProjectTime[] {
  const byName = new Map<string, ProjectTime & { dayset: Set<string> }>();
  const get = (name: string) => {
    let t = byName.get(name);
    if (!t) byName.set(name, (t = { project: name, days: 0, commits: 0, opens: 0, devMs: 0, dayset: new Set() }));
    return t;
  };
  for (const p of projects) {
    const t = get(p.project);
    t.commits += p.commits.length;
    p.commits.forEach((c) => t.dayset.add(c.date));
  }
  const names = [...knownNames].sort((a, b) => b.length - a.length);
  for (const r of runs) {
    if (r.tool !== "go") continue;
    const at = new Date(r.at);
    if (Number.isNaN(at.getTime()) || at < start) continue;
    const name = r.project ?? names.find((n) => r.detail === n || r.detail?.startsWith(`${n} `) || r.detail?.startsWith(`${n}:`));
    if (!name) continue;
    const t = get(name);
    // Each dx go writes one record (a foreground run writes it when the server stops), so one record is one open.
    t.opens++;
    t.devMs += r.ms ?? 0;
    t.dayset.add(localDate(at));
  }
  return [...byName.values()]
    .map(({ dayset, ...t }) => ({ ...t, days: dayset.size }))
    .sort((a, b) => b.days - a.days || b.commits - a.commits || a.project.localeCompare(b.project));
}

async function changedFiles(dir: string): Promise<number> {
  const out = await gitOutput(dir, ["status", "--porcelain"]);
  return out ? out.split(/\r?\n/).filter(Boolean).length : 0;
}

async function gitOutput(dir: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", ["-C", dir, ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return "";
  }
}

/** Your name and email as git knows them for this repo (a repo can override the global ones). */
async function gitIdentity(dir: string): Promise<string[]> {
  const read = async (key: string) => {
    try {
      const { stdout } = await run("git", ["-C", dir, "config", key], { windowsHide: true });
      return stdout.trim();
    } catch {
      return "";
    }
  };
  const [name, email] = await Promise.all([read("user.name"), read("user.email")]);
  const who = [name, email].filter(Boolean);
  if (who.length === 0) throw new Error("git has no user.name or user.email set, so your commits can't be told apart");
  return who;
}

async function commitsSince(project: Project, start: Date, authors: string[]): Promise<Commit[]> {
  const args = [
    "-C",
    project.dir,
    "log",
    "--all",
    "--no-merges",
    `--since=${start.toISOString()}`,
    `--format=%H${FIELD}%aI${FIELD}%s`,
  ];
  // Several --author patterns match any of them: commits made under your name or your email.
  if (authors.length) args.push("--fixed-strings", ...authors.map((a) => `--author=${a}`));
  try {
    const { stdout } = await run("git", args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return parseGitLog(stdout);
  } catch (err) {
    // A repo with no commits yet isn't an error, it just has nothing to report.
    if (/does not have any commits|unknown revision/i.test(String((err as { stderr?: string }).stderr))) return [];
    throw err;
  }
}

/** Parses `git log --format=%H<US>%aI<US>%s` output. Newest first, like git prints it. */
export function parseGitLog(stdout: string): Commit[] {
  const commits: Commit[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [hash, iso, ...rest] = line.split(FIELD);
    if (!hash || !iso) continue;
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) continue;
    commits.push({ hash, date: localDate(at), time: localTime(at), subject: rest.join(FIELD).trim() });
  }
  return commits;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const COMMITS_PER_PROJECT = 12;

/** "2026-11-02" → "Mon 2 Nov" */
export function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const at = new Date(y, m - 1, d);
  return `${WEEKDAYS[at.getDay()]} ${d} ${MONTHS[m - 1]}`;
}

/** "27 Oct – 2 Nov 2026", or "Mon 2 Nov 2026" for one day. */
export function rangeLabel(from: string, to: string): string {
  const year = to.slice(0, 4);
  if (from === to) return `${dayLabel(to)} ${year}`;
  const short = (date: string) => dayLabel(date).split(" ").slice(1).join(" ");
  const fromLabel = from.slice(0, 4) === year ? short(from) : `${short(from)} ${from.slice(0, 4)}`;
  return `${fromLabel} – ${short(to)} ${year}`;
}

/** The summary as markdown, ready to paste. */
export function formatSummary(s: WorkSummary): string {
  const commitCount = s.projects.reduce((n, p) => n + p.commits.length, 0);
  const out: string[] = [`# Work summary · ${rangeLabel(s.from, s.to)}`, ""];

  const gh = s.github && "user" in s.github ? s.github : undefined;
  const prCount = gh ? gh.merged.length + gh.reviewed.length : 0;
  const totals = [
    plural(commitCount, "commit") + (s.projects.length ? ` in ${plural(s.projects.length, "project")}` : ""),
    ...(gh ? [`${gh.merged.length} PR(s) merged`, `${gh.reviewed.length} reviewed`] : []),
    plural(s.journal.length, "journal entry", "journal entries"),
  ];
  out.push(`**${totals.join(" · ")}**`, "");

  if (commitCount === 0 && s.journal.length === 0 && prCount === 0) {
    out.push(`Nothing to report: no commits and no journal entries in the last ${plural(s.days, "day")}.`, "");
    out.push(...uncommittedSection(s), ...skippedNote(s));
    return out.join("\n").trimEnd() + "\n";
  }

  if (s.journal.length) {
    out.push("## Journal", "");
    let day = "";
    for (const e of s.journal) {
      if (e.date !== day) {
        if (day) out.push("");
        out.push(`**${dayLabel(e.date)}**`);
        day = e.date;
      }
      out.push(`- ${e.text}`);
    }
    out.push("");
  }

  if (gh && prCount) {
    out.push("## Pull requests", "");
    const line = (pr: PullRequest) => `- ${pr.title} ([${pr.repo}#${pr.number}](${pr.url}))${pr.date ? ` · ${dayLabel(pr.date).split(" ")[0]}` : ""}`;
    if (gh.merged.length) out.push("**Merged**", ...gh.merged.map(line), "");
    if (gh.reviewed.length) out.push("**Reviewed**", ...gh.reviewed.map(line), "");
  }

  if (s.projects.length) {
    out.push("## Commits", "");
    for (const p of s.projects) {
      out.push(`### ${p.project} (${p.commits.length})`, "");
      // Oldest first reads like a story of the week; identical subjects (amends, retries) once, with a count.
      const counts = new Map<string, number>();
      const unique = [...p.commits].reverse().filter((c) => {
        const key = c.subject.toLowerCase();
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return counts.get(key) === 1;
      });
      for (const c of unique.slice(0, COMMITS_PER_PROJECT)) {
        const times = counts.get(c.subject.toLowerCase()) ?? 1;
        out.push(`- ${c.subject || "(no message)"}${times > 1 ? ` ×${times}` : ""} · ${dayLabel(c.date).split(" ")[0]}`);
      }
      if (unique.length > COMMITS_PER_PROJECT) out.push(`- …and ${unique.length - COMMITS_PER_PROJECT} more`);
      out.push("");
    }
  }

  if (s.time.length) {
    out.push("## Where the time went", "");
    for (const t of s.time) {
      const parts = [plural(t.days, "day")];
      if (t.commits) parts.push(plural(t.commits, "commit"));
      if (t.opens) parts.push(`opened ${t.opens}×`);
      if (t.devMs >= 60_000) parts.push(`${formatDuration(t.devMs)} dev server`);
      out.push(`- ${t.project}: ${parts.join(" · ")}`);
    }
    out.push("");
  }

  out.push(...uncommittedSection(s), ...skippedNote(s));
  return out.join("\n").trimEnd() + "\n";
}

function uncommittedSection(s: WorkSummary): string[] {
  if (!s.uncommitted.length) return [];
  return ["## Not committed yet", "", ...s.uncommitted.map((u) => `- ${u.project}: ${plural(u.files, "changed file")}`), ""];
}

function skippedNote(s: WorkSummary): string[] {
  const notes: string[] = [];
  if (s.skipped.length) notes.push(`_Couldn't read ${s.skipped.map((x) => x.project).join(", ")}; run \`dx summary\` in a terminal for details._`);
  if (s.github && "error" in s.github) notes.push(`_No pull requests: ${s.github.error}._`);
  else if (s.github && !s.github.authenticated) notes.push("_Pull requests from public repos only; set GITHUB_TOKEN to include private ones._");
  return notes.length ? [...notes, ""] : [];
}

/** 4_500_000 → "1h 15m" */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/** Saves the markdown to ~/.dx/summaries/<last day>.md and returns the path. */
export function saveSummary(markdown: string, summary: WorkSummary): string {
  ensureDxHome();
  const dir = dxPath("summaries");
  fs.mkdirSync(dir, { recursive: true });
  const file = dxPath("summaries", `${summary.to}.md`);
  fs.writeFileSync(file, markdown, "utf8");
  return file;
}

export function summariesDir(): string {
  return dxPath("summaries");
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function firstLine(text?: string): string {
  return (text ?? "").split(/\r?\n/).map((l) => l.replace(/^(fatal|error):\s*/i, "").trim()).find(Boolean) ?? "";
}

async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}
