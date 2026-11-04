import fs from "node:fs";
import path from "node:path";
import { buildSummary, formatDuration, summariesDir, type SummaryOptions, type WorkSummary } from "./summary.js";

/** Saves it as ~/.dx/summaries/<year>-in-review.md. */
export function saveYearReview(markdown: string, year: number): string {
  const dir = summariesDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${year}-in-review.md`);
  fs.writeFileSync(file, markdown, "utf8");
  return file;
}

/**
 * A year of work as one document: commits, pull requests, journal and time per project, month by
 * month, with the busiest day and the longest run of days with commits. For a review, a CV or
 * just looking back.
 */

export interface YearReview {
  year: number;
  /** The summary the review is made from, covering 1 January to the end of the year (or today). */
  summary: WorkSummary;
  commits: number;
  /** Distinct days with at least one commit. */
  activeDays: number;
  months: { month: string; commits: number; activeDays: number; topProject?: string; journal: number }[];
  busiestDay?: { date: string; commits: number };
  /** The longest run of consecutive days with commits. */
  longestStreak?: { from: string; to: string; days: number };
  projects: { project: string; commits: number; activeDays: number; first: string; last: string }[];
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export async function buildYearReview(year: number, options: Omit<SummaryOptions, "days" | "now"> & { now?: Date } = {}): Promise<YearReview> {
  const today = options.now ?? new Date();
  if (year > today.getFullYear()) throw new Error(`${year} hasn't started yet.`);
  const end = year === today.getFullYear() ? today : new Date(year, 11, 31, 23, 59);
  const start = new Date(year, 0, 1);
  const days = Math.round((new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime() - start.getTime()) / 86_400_000) + 1;
  const summary = await buildSummary({ ...options, days, now: end });
  return reviewFrom(year, summary);
}

/** The numbers, from a summary that covers the year. Exported for tests. */
export function reviewFrom(year: number, summary: WorkSummary): YearReview {
  const perDay = new Map<string, number>();
  const projects: YearReview["projects"] = [];
  for (const p of summary.projects) {
    const dates = p.commits.map((c) => c.date).sort();
    for (const d of dates) perDay.set(d, (perDay.get(d) ?? 0) + 1);
    projects.push({ project: p.project, commits: p.commits.length, activeDays: new Set(dates).size, first: dates[0], last: dates[dates.length - 1] });
  }
  projects.sort((a, b) => b.commits - a.commits || a.project.localeCompare(b.project));

  const months = MONTHS.map((month, i) => {
    const key = `${year}-${String(i + 1).padStart(2, "0")}`;
    const byProject = new Map<string, number>();
    for (const p of summary.projects) {
      const n = p.commits.filter((c) => c.date.startsWith(key)).length;
      if (n) byProject.set(p.project, n);
    }
    const top = [...byProject.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      month,
      commits: [...byProject.values()].reduce((a, b) => a + b, 0),
      activeDays: [...perDay.keys()].filter((d) => d.startsWith(key)).length,
      topProject: top?.[0],
      journal: summary.journal.filter((e) => e.date.startsWith(key)).length,
    };
  });

  const busiest = [...perDay.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  let longest: YearReview["longestStreak"];
  let run: { from: string; to: string; days: number } | undefined;
  for (const d of [...perDay.keys()].sort()) {
    if (run && dayAfter(run.to) === d) run = { ...run, to: d, days: run.days + 1 };
    else run = { from: d, to: d, days: 1 };
    if (!longest || run.days > longest.days) longest = run;
  }

  return {
    year,
    summary,
    commits: projects.reduce((n, p) => n + p.commits, 0),
    activeDays: perDay.size,
    months,
    busiestDay: busiest ? { date: busiest[0], commits: busiest[1] } : undefined,
    longestStreak: longest,
    projects,
  };
}

function dayAfter(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(y, m - 1, d + 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
}

function nice(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "long" });
}

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export function formatYearReview(r: YearReview): string {
  const s = r.summary;
  const gh = s.github && "user" in s.github ? s.github : undefined;
  const out: string[] = [`# ${r.year} in review`, ""];
  const totals = [
    `${n(r.commits, "commit")} in ${n(r.projects.length, "project")}`,
    `${n(r.activeDays, "day")} with commits`,
    ...(gh ? [`${gh.merged.length} pull request(s) merged`, `${gh.reviewed.length} reviewed`] : []),
    n(s.journal.length, "journal entry", "journal entries"),
  ];
  out.push(`**${totals.join(" · ")}**`, "");
  if (!r.commits && !s.journal.length && !(gh && gh.merged.length + gh.reviewed.length)) {
    out.push(`Nothing recorded for ${r.year}.`);
    return out.join("\n") + "\n";
  }
  const facts: string[] = [];
  if (r.busiestDay) facts.push(`- **Busiest day**: ${nice(r.busiestDay.date)}, ${n(r.busiestDay.commits, "commit")}`);
  if (r.longestStreak && r.longestStreak.days > 1) facts.push(`- **Longest run**: ${r.longestStreak.days} days in a row with commits, ${nice(r.longestStreak.from)} to ${nice(r.longestStreak.to)}`);
  const topMonth = [...r.months].sort((a, b) => b.commits - a.commits)[0];
  if (topMonth?.commits) facts.push(`- **Busiest month**: ${topMonth.month}, ${n(topMonth.commits, "commit")}`);
  if (r.projects[0]) facts.push(`- **Most worked on**: ${r.projects[0].project}, ${n(r.projects[0].commits, "commit")} over ${n(r.projects[0].activeDays, "day")}`);
  if (facts.length) out.push(...facts, "");

  out.push("## Month by month", "", "| Month | Commits | Days | Mostly on | Journal |", "|---|---:|---:|---|---:|");
  for (const m of r.months) {
    if (!m.commits && !m.journal) continue;
    out.push(`| ${m.month} | ${m.commits} | ${m.activeDays} | ${m.topProject ?? ""} | ${m.journal} |`);
  }
  out.push("");

  if (r.projects.length) {
    out.push("## Projects", "", "| Project | Commits | Days | From | To | Dev server |", "|---|---:|---:|---|---|---:|");
    const time = new Map(s.time.map((t) => [t.project, t]));
    for (const p of r.projects.slice(0, 25)) {
      const ms = time.get(p.project)?.devMs ?? 0;
      out.push(`| ${p.project} | ${p.commits} | ${p.activeDays} | ${nice(p.first)} | ${nice(p.last)} | ${ms ? formatDuration(ms) : ""} |`);
    }
    if (r.projects.length > 25) out.push("", `…and ${r.projects.length - 25} more.`);
    out.push("");
  }

  if (gh?.merged.length) {
    out.push("## Pull requests merged", "");
    for (const pr of gh.merged.slice(0, 50)) out.push(`- ${pr.title} ([${pr.repo}#${pr.number}](${pr.url})) · ${nice(pr.date)}`);
    if (gh.merged.length > 50) out.push(`- …and ${gh.merged.length - 50} more`);
    out.push("");
  }

  if (s.journal.length) {
    out.push("## From your journal", "");
    for (const [i, month] of MONTHS.entries()) {
      const key = `${r.year}-${String(i + 1).padStart(2, "0")}`;
      const entries = s.journal.filter((e) => e.date.startsWith(key));
      if (!entries.length) continue;
      out.push(`**${month}**`);
      for (const e of entries.slice(0, 12)) out.push(`- ${e.text}`);
      if (entries.length > 12) out.push(`- …and ${entries.length - 12} more`);
      out.push("");
    }
  }
  if (s.skipped.length) out.push(`_Couldn't read: ${s.skipped.map((x) => x.project).join(", ")}._`);
  return out.join("\n").trimEnd() + "\n";
}
