import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-home-"));
const { defaultConfig } = await import("../config.js");
const { addJournalEntry } = await import("../tools/journal.js");
const { buildSummary, dayLabel, formatDuration, formatSummary, parseGitLog, rangeLabel, saveSummary, timePerProject } = await import(
  "../tools/summary.js"
);

const US = "\x1f";

test("parseGitLog reads hash, local date and subject, and skips junk lines", () => {
  const at = new Date(2026, 10, 2, 14, 30);
  const out = [`abc123${US}${at.toISOString()}${US}Fix seat map overflow`, "", "garbage", `def${US}not-a-date${US}x`].join("\n");
  assert.deepEqual(parseGitLog(out), [{ hash: "abc123", date: "2026-11-02", time: "14:30", subject: "Fix seat map overflow" }]);
});

test("day and range labels", () => {
  assert.equal(dayLabel("2026-11-02"), "Mon 2 Nov");
  assert.equal(rangeLabel("2026-10-27", "2026-11-02"), "27 Oct – 2 Nov 2026");
  assert.equal(rangeLabel("2025-12-29", "2026-01-04"), "29 Dec 2025 – 4 Jan 2026");
  assert.equal(rangeLabel("2026-11-02", "2026-11-02"), "Mon 2 Nov 2026");
});

test("formatSummary groups the journal by day and commits by project, oldest first, without duplicates", () => {
  const md = formatSummary({
    from: "2026-10-27",
    to: "2026-11-02",
    days: 7,
    author: "me",
    projects: [
      {
        project: "shop",
        dir: "x",
        commits: [
          { hash: "3", date: "2026-10-29", time: "10:00", subject: "Add checkout" },
          { hash: "2", date: "2026-10-28", time: "10:00", subject: "Fix header" },
          { hash: "1", date: "2026-10-27", time: "10:00", subject: "fix header" },
        ],
      },
    ],
    journal: [
      { date: "2026-10-27", time: "09:00", text: "planning" },
      { date: "2026-10-27", time: "15:00", text: "pairing" },
      { date: "2026-10-28", time: "09:00", text: "demo" },
    ],
    skipped: [],
    time: [],
    uncommitted: [],
  });
  assert.equal(
    md,
    [
      "# Work summary · 27 Oct – 2 Nov 2026",
      "",
      "**3 commits in 1 project · 3 journal entries**",
      "",
      "## Journal",
      "",
      "**Tue 27 Oct**",
      "- planning",
      "- pairing",
      "",
      "**Wed 28 Oct**",
      "- demo",
      "",
      "## Commits",
      "",
      "### shop (3)",
      "",
      "- fix header ×2 · Tue",
      "- Add checkout · Thu",
      "",
    ].join("\n"),
  );
});

test("formatSummary says so when there is nothing to report", () => {
  const md = formatSummary({ from: "2026-11-02", to: "2026-11-02", days: 1, author: "me", projects: [], journal: [], skipped: [], time: [], uncommitted: [] });
  assert.match(md, /Nothing to report: no commits and no journal entries in the last 1 day\./);
});

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("buildSummary counts only your commits in the window, across repos", { skip: !hasGit() && "git not installed" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-summary-"));
  const now = new Date(2026, 10, 2, 18, 0);
  const daysAgo = (n: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, 12, 0).toISOString();

  const repo = (name: string) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    const git = (args: string[], env: Record<string, string> = {}) =>
      execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", env: { ...process.env, ...env } });
    git(["init", "-q"]);
    git(["config", "user.name", "Me Myself"]);
    git(["config", "user.email", "me@example.com"]);
    git(["config", "commit.gpgsign", "false"]);
    const commit = (subject: string, when: string, author = "Me Myself <me@example.com>") =>
      git(["commit", "-q", "--allow-empty", "-m", subject, `--author=${author}`], {
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_DATE: when,
      });
    return { dir, commit };
  };

  const a = repo("alpha");
  a.commit("too old", daysAgo(10));
  a.commit("start alpha", daysAgo(5));
  a.commit("someone else's work", daysAgo(4), "Other Person <other@example.com>");
  a.commit("finish alpha", daysAgo(1));
  const b = repo("beta");
  b.commit("beta fix", daysAgo(0));
  fs.writeFileSync(path.join(b.dir, "wip.txt"), "not committed yet");
  repo("empty"); // no commits at all: not an error, just nothing to report
  addJournalEntry("wrote the summary tool", new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2, 9, 0));

  const config = { ...defaultConfig(), projectsRoots: [root] };
  const summary = await buildSummary({ days: 7, now, config });
  assert.equal(summary.from, "2026-10-27");
  assert.equal(summary.to, "2026-11-02");
  assert.deepEqual(summary.skipped, []);
  assert.deepEqual(
    summary.projects.map((p) => [p.project, p.commits.map((c) => c.subject)]),
    [
      ["alpha", ["finish alpha", "start alpha"]],
      ["beta", ["beta fix"]],
    ],
  );
  assert.deepEqual(summary.journal.map((e) => e.text), ["wrote the summary tool"]);
  assert.deepEqual(summary.uncommitted, [{ project: "beta", files: 1 }]);
  assert.deepEqual(
    summary.time.map((t) => [t.project, t.days, t.commits]),
    [
      ["alpha", 2, 2],
      ["beta", 1, 1],
    ],
  );
  assert.equal(summary.github, undefined);

  const everyone = await buildSummary({ days: 7, now, config, allAuthors: true });
  assert.equal(everyone.projects.find((p) => p.project === "alpha")?.commits.length, 3);
  assert.equal(everyone.author, "everyone");

  const file = saveSummary(formatSummary(summary), summary);
  assert.equal(path.basename(file), "2026-11-02.md");
  assert.match(fs.readFileSync(file, "utf8"), /### alpha \(2\)/);
});

test("timePerProject joins commit days with dx go runs, old records included", () => {
  const start = new Date(2026, 9, 27);
  const at = (d: number, h = 10) => new Date(2026, 9, d, h).toISOString();
  const time = timePerProject(
    [{ project: "shop", dir: "x", commits: [{ hash: "1", date: "2026-10-28", time: "10:00", subject: "a" }] }],
    [
      { at: at(28), tool: "go", ok: true, project: "shop", ms: 2 * 3_600_000 },
      { at: at(29), tool: "go", ok: true, detail: "shop dev stopped with Ctrl+C" }, // old record: no project field
      { at: at(29), tool: "go", ok: true, detail: "todo-app (already running)" },
      { at: at(20), tool: "go", ok: true, project: "todo-app" }, // before the window
      { at: at(29), tool: "log", ok: true },
      { at: at(29), tool: "go", ok: true, detail: "shop-website" }, // longest name wins
    ],
    start,
    ["shop", "shop-website", "todo-app"],
  );
  assert.deepEqual(time, [
    { project: "shop", days: 2, commits: 1, opens: 2, devMs: 7_200_000 },
    { project: "shop-website", days: 1, commits: 0, opens: 1, devMs: 0 },
    { project: "todo-app", days: 1, commits: 0, opens: 1, devMs: 0 },
  ]);
});

test("formatSummary shows pull requests, time and uncommitted work", () => {
  const md = formatSummary({
    from: "2026-10-27",
    to: "2026-11-02",
    days: 7,
    author: "me",
    projects: [],
    journal: [],
    skipped: [],
    time: [{ project: "shop", days: 3, commits: 0, opens: 2, devMs: 4_500_000 }],
    uncommitted: [{ project: "todo-app", files: 4 }],
    github: {
      user: "me",
      authenticated: false,
      merged: [{ title: "Add checkout", repo: "me/shop", number: 12, url: "https://github.com/me/shop/pull/12", date: "2026-10-29" }],
      reviewed: [],
    },
  });
  const has = (part: string) => assert.ok(md.includes(part), `missing:\n${part}\n\nin:\n${md}`);
  has("**0 commits · 1 PR(s) merged · 0 reviewed · 0 journal entries**");
  has("## Pull requests\n\n**Merged**\n- Add checkout ([me/shop#12](https://github.com/me/shop/pull/12)) · Thu\n");
  has("## Where the time went\n\n- shop: 3 days · opened 2× · 1h 15m dev server\n");
  has("## Not committed yet\n\n- todo-app: 4 changed files\n");
  has("public repos only");
  assert.equal(formatDuration(45 * 60_000), "45m");
  assert.equal(formatDuration(2 * 3_600_000), "2h");
});
