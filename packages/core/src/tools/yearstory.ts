import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readRuns, type RunRecord } from "../runs.js";
import { readSessions, type ProjectSession } from "./sessions.js";
import { gitIdentity, type SummaryOptions } from "./summary.js";
import { buildYearReview, type YearReview } from "./year.js";

const run = promisify(execFile);

/**
 * Your dev year as a story: the year in review's numbers plus when you code, what you touched
 * most, the languages, the fixes, the biggest day, time with dev servers running, first and last
 * commit, and the words your journal uses most. Everything comes from this computer: git history
 * (your own commits, told apart by each repo's user.name and user.email, as in the summary), the
 * journal, ~/.dx/runs.jsonl and ~/.dx/sessions.json. Nothing is sent anywhere.
 */

export interface StoryCommit {
  date: string;
  time: string;
  project: string;
  subject: string;
}

export interface YearStory {
  year: number;
  /** First and last day counted. */
  from: string;
  to: string;
  author: string;
  commits: number;
  activeDays: number;
  projects: number;
  longestStreak?: { from: string; to: string; days: number };
  /** The Monday-to-Sunday week with the most commits. */
  busiestWeek?: { from: string; to: string; commits: number };
  /** Commits by weekday (0 = Monday … 6 = Sunday) and hour (0–23), local time. */
  heat: number[][];
  /** The weekday and hour with the most commits. */
  peak?: { weekday: number; hour: number; commits: number };
  /** Share of commits made 18:00–05:59 and on Saturdays and Sundays, 0–1. */
  evenings: number;
  weekends: number;
  /** The project with the most commits in each month (months with none are left out). */
  months: { month: string; index: number; commits: number; project?: string; projectCommits?: number }[];
  /** The files changed in the most commits. */
  files: { project: string; path: string; commits: number }[];
  /** Commits whose subject reads like a fix. */
  fixes: { count: number; examples: StoryCommit[] };
  biggestDay?: { date: string; commits: number; projects: string[] };
  /** Files changed, by language (from extensions), most first. */
  languages: { language: string; files: number }[];
  /** How long dev servers dx ran were up this year, in ms, in all and for the top projects. */
  devMs: number;
  devProjects: { project: string; ms: number }[];
  first?: StoryCommit;
  last?: StoryCommit;
  journal: { entries: number; words: { word: string; count: number }[] };
  /** Calls your AI agents made through dx (the MCP server), and notes left on projects. */
  ai: { calls: number; projects: number };
  notes: { you: number; ai: number };
  /** Repos git couldn't read. */
  skipped: string[];
}

export interface YearStoryOptions extends Omit<SummaryOptions, "days" | "now"> {
  now?: Date;
  /** For tests: the run log and sessions instead of ~/.dx's. */
  runs?: RunRecord[];
  sessions?: ProjectSession[];
}

export async function buildYearStory(year: number, options: YearStoryOptions = {}): Promise<{ review: YearReview; story: YearStory }> {
  const review = await buildYearReview(year, options);
  const files = new Map<string, Map<string, string[]>>(); // project -> hash -> files
  await Promise.all(
    review.summary.projects.map(async (p) => {
      try {
        files.set(p.project, await filesPerCommit(p.dir, year, options.allAuthors ? [] : await gitIdentity(p.dir)));
      } catch {
        // the commits are still counted; only their files are missing
      }
    }),
  );
  return { review, story: storyFrom(review, files, options.runs ?? readRuns(0), options.sessions ?? readSessions()) };
}

const FS = "\x1e";

/** `git log --name-only` for the year: the files each of your commits changed. */
async function filesPerCommit(dir: string, year: number, authors: string[]): Promise<Map<string, string[]>> {
  const args = ["-C", dir, "log", "--all", "--no-merges", `--since=${new Date(year, 0, 1).toISOString()}`, `--until=${new Date(year, 11, 31, 23, 59, 59, 999).toISOString()}`, `--format=${FS}%H`, "--name-only"];
  if (authors.length) args.push("--fixed-strings", ...authors.map((a) => `--author=${a}`));
  const { stdout } = await run("git", args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return parseNameOnly(stdout);
}

/** Parses `git log --format=<RS>%H --name-only`. Exported for tests. */
export function parseNameOnly(stdout: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const chunk of stdout.split(FS)) {
    const lines = chunk.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    out.set(lines[0], lines.slice(1));
  }
  return out;
}

const LOCK_FILES = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|composer\.lock|Gemfile\.lock|Pipfile\.lock)$/;

const LANGUAGES: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", go: "Go", rs: "Rust", rb: "Ruby", java: "Java", kt: "Kotlin", kts: "Kotlin", swift: "Swift",
  c: "C", h: "C", cpp: "C++", cc: "C++", cxx: "C++", hpp: "C++", cs: "C#", fs: "F#", php: "PHP", dart: "Dart",
  ex: "Elixir", exs: "Elixir", erl: "Erlang", scala: "Scala", clj: "Clojure", lua: "Lua", r: "R", jl: "Julia", zig: "Zig",
  css: "CSS", scss: "CSS", sass: "CSS", less: "CSS", html: "HTML", htm: "HTML",
  vue: "Vue", svelte: "Svelte", astro: "Astro",
  md: "Markdown", mdx: "Markdown", json: "JSON", yml: "YAML", yaml: "YAML", toml: "TOML", sql: "SQL",
  sh: "Shell", bash: "Shell", zsh: "Shell", ps1: "PowerShell",
};

export function languageOf(file: string): string | undefined {
  if (LOCK_FILES.test(file)) return undefined;
  const base = file.split("/").pop() ?? file;
  if (base === "Dockerfile") return "Docker";
  const ext = /\.([A-Za-z0-9]+)$/.exec(base)?.[1]?.toLowerCase();
  return ext ? LANGUAGES[ext] : undefined;
}

/** A subject that reads like a fix: "fix: …", "Fixed the cart", "hotfix", "bug in …". */
export function isFix(subject: string): boolean {
  return /\b(fix(e[sd]|ing)?|bug(fix(es)?|s)?|hotfix(es)?|crash(es|ing)?)\b/i.test(subject);
}

const STOP_WORDS = new Set(
  "the and for with that this from into onto then than have has had was were are been being but not you your our out off its it's about after before over under more less some all any can will just also very what when where which who why how there their them they one two get got did does done doing make made new now still yet again today yesterday tomorrow week day work worked working".split(" "),
);

/** The words a journal uses most, without the small ones. */
export function topWords(texts: string[], limit = 12): { word: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const t of texts) {
    for (const raw of t.toLowerCase().match(/[\p{L}][\p{L}'-]{2,}/gu) ?? []) {
      const word = raw.replace(/['-]+$/, "");
      if (word.length < 3 || STOP_WORDS.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return (new Date(y, m - 1, d).getDay() + 6) % 7; // Monday first
}

function shift(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const at = new Date(y, m - 1, d + days);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

/** The numbers, from the review and each commit's files. Exported for tests. */
export function storyFrom(review: YearReview, filesByProject: Map<string, Map<string, string[]>>, runs: RunRecord[], sessions: ProjectSession[]): YearStory {
  const s = review.summary;
  const prefix = String(review.year);
  const all: (StoryCommit & { hash: string })[] = [];
  for (const p of s.projects) for (const c of p.commits) if (c.date.startsWith(prefix)) all.push({ ...c, project: p.project });
  all.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));

  const heat = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  const weeks = new Map<string, number>();
  const days = new Map<string, { commits: number; projects: Map<string, number> }>();
  let evenings = 0;
  let weekends = 0;
  for (const c of all) {
    const wd = weekdayOf(c.date);
    const hour = Math.min(23, Math.max(0, Number(c.time.slice(0, 2)) || 0));
    heat[wd][hour]++;
    if (hour >= 18 || hour < 6) evenings++;
    if (wd >= 5) weekends++;
    const monday = shift(c.date, -wd);
    weeks.set(monday, (weeks.get(monday) ?? 0) + 1);
    const day = days.get(c.date) ?? { commits: 0, projects: new Map() };
    day.commits++;
    day.projects.set(c.project, (day.projects.get(c.project) ?? 0) + 1);
    days.set(c.date, day);
  }

  let peak: YearStory["peak"];
  heat.forEach((row, weekday) => row.forEach((commits, hour) => {
    if (commits && (!peak || commits > peak.commits)) peak = { weekday, hour, commits };
  }));
  const week = [...weeks.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const day = [...days.entries()].sort((a, b) => b[1].commits - a[1].commits || a[0].localeCompare(b[0]))[0];

  const months = MONTHS.map((month, index) => {
    const key = `${prefix}-${String(index + 1).padStart(2, "0")}`;
    const byProject = new Map<string, number>();
    for (const c of all) if (c.date.startsWith(key)) byProject.set(c.project, (byProject.get(c.project) ?? 0) + 1);
    const top = [...byProject.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return { month, index, commits: [...byProject.values()].reduce((a, b) => a + b, 0), project: top?.[0], projectCommits: top?.[1] };
  }).filter((m) => m.commits > 0);

  // Files and languages, from the commits counted above only.
  const touched = new Map<string, { project: string; path: string; commits: number }>();
  const langs = new Map<string, number>();
  const counted = new Set(all.map((c) => `${c.project}\n${c.hash}`));
  for (const [project, perCommit] of filesByProject) {
    for (const [hash, list] of perCommit) {
      if (!counted.has(`${project}\n${hash}`)) continue;
      for (const file of list) {
        const lang = languageOf(file);
        if (lang) langs.set(lang, (langs.get(lang) ?? 0) + 1);
        if (LOCK_FILES.test(file)) continue;
        const k = `${project}\n${file}`;
        const t = touched.get(k) ?? { project, path: file, commits: 0 };
        t.commits++;
        touched.set(k, t);
      }
    }
  }

  const fixes = all.filter((c) => isFix(c.subject));
  const start = new Date(review.year, 0, 1).getTime();
  const end = new Date(review.year + 1, 0, 1).getTime();
  const inYear = (at: string) => {
    const t = Date.parse(at);
    return t >= start && t < end;
  };
  const dev = new Map<string, number>();
  for (const r of runs) {
    if (r.tool !== "go" || !r.ms || !r.project || !inYear(r.at)) continue;
    dev.set(r.project, (dev.get(r.project) ?? 0) + r.ms);
  }
  const aiRuns = runs.filter((r) => r.source === "mcp" && r.tool.startsWith("mcp.") && inYear(r.at));
  const journal = s.journal.filter((e) => e.date.startsWith(prefix));
  const strip = ({ hash: _hash, ...c }: StoryCommit & { hash: string }): StoryCommit => c;

  return {
    year: review.year,
    from: s.from,
    to: s.to,
    author: s.author,
    commits: all.length,
    activeDays: days.size,
    projects: new Set(all.map((c) => c.project)).size,
    longestStreak: review.longestStreak,
    busiestWeek: week ? { from: week[0], to: shift(week[0], 6), commits: week[1] } : undefined,
    heat,
    peak,
    evenings: all.length ? evenings / all.length : 0,
    weekends: all.length ? weekends / all.length : 0,
    months,
    files: [...touched.values()].sort((a, b) => b.commits - a.commits || a.path.localeCompare(b.path)).slice(0, 10),
    fixes: { count: fixes.length, examples: fixes.slice(-5).reverse().map(strip) },
    biggestDay: day ? { date: day[0], commits: day[1].commits, projects: [...day[1].projects.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p) } : undefined,
    languages: [...langs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([language, files]) => ({ language, files })),
    devMs: [...dev.values()].reduce((a, b) => a + b, 0),
    devProjects: [...dev.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([project, ms]) => ({ project, ms })),
    first: all[0] ? strip(all[0]) : undefined,
    last: all.length ? strip(all[all.length - 1]) : undefined,
    journal: { entries: journal.length, words: topWords(journal.map((e) => e.text)) },
    ai: { calls: aiRuns.length, projects: new Set(aiRuns.map((r) => r.project).filter(Boolean)).size },
    notes: {
      you: sessions.filter((x) => x.note && x.noteAt && inYear(x.noteAt) && x.noteBy !== "ai").length,
      ai: sessions.filter((x) => x.note && x.noteAt && inYear(x.noteAt) && x.noteBy === "ai").length,
    },
    skipped: s.skipped.map((x) => x.project),
  };
}

const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function weekdayName(i: number): string {
  return WEEKDAY_NAMES[i] ?? "";
}

/** "14:00–15:00" */
export function hourRange(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00–${String((hour + 1) % 24).padStart(2, "0")}:00`;
}
