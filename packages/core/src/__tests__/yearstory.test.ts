import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-home-"));
const { defaultConfig } = await import("../config.js");
const { addJournalEntry } = await import("../tools/journal.js");
const { buildYearStory, isFix, languageOf, parseNameOnly, topWords } = await import("../tools/yearstory.js");
const { formatYearReview } = await import("../tools/year.js");

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("fixes, languages, journal words and git's --name-only output", () => {
  assert.ok(isFix("fix: empty cart crashes checkout"));
  assert.ok(isFix("Fixed the seat map"));
  assert.ok(isFix("hotfix for login"));
  assert.ok(!isFix("Add a prefix to order ids"));
  assert.ok(!isFix("Test fixtures for the cart"));
  assert.equal(languageOf("src/cart.ts"), "TypeScript");
  assert.equal(languageOf("web/App.TSX"), "TypeScript");
  assert.equal(languageOf("styles/site.scss"), "CSS");
  assert.equal(languageOf("package-lock.json"), undefined, "lock files aren't a language you wrote");
  assert.equal(languageOf("LICENSE"), undefined);
  assert.deepEqual(topWords(["Shipped the checkout", "checkout tests", "Paired on checkout and tests", "once"]), [
    { word: "checkout", count: 3 },
    { word: "tests", count: 2 },
  ]);
  const parsed = parseNameOnly("\x1eaaa\n\nsrc/a.ts\nsrc/b.ts\n\x1ebbb\n\n\x1eccc\nREADME.md\n");
  assert.deepEqual([...parsed.entries()], [
    ["aaa", ["src/a.ts", "src/b.ts"]],
    ["bbb", []],
    ["ccc", ["README.md"]],
  ]);
});

test("the year story counts only your commits in that year, across repos", { skip: !hasGit() && "git not installed" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-story-"));
  const repo = (name: string) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    const git = (args: string[], env: Record<string, string> = {}) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", env: { ...process.env, ...env } });
    git(["init", "-q"]);
    git(["config", "user.name", "Alex Rivera"]);
    git(["config", "user.email", "alex@example.com"]);
    git(["config", "commit.gpgsign", "false"]);
    // Local time, as git reads a date without an offset: the hours below are the hours counted.
    const commit = (subject: string, when: string, files: string[], author = "Alex Rivera <alex@example.com>") => {
      for (const f of files) {
        fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        fs.appendFileSync(path.join(dir, f), `${subject}\n`);
      }
      git(["add", "-A"]);
      git(["commit", "-q", "--allow-empty", "-m", subject, `--author=${author}`], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
    };
    return { dir, commit };
  };

  const shop = repo("shop-website");
  shop.commit("Start the shop", "2025-12-30T10:00:00", ["README.md"]); // the year before: not counted
  shop.commit("Add the cart", "2026-03-02T09:15:00", ["src/cart.ts", "src/cart.css"]); // a Monday
  shop.commit("fix: cart total rounding", "2026-03-02T21:40:00", ["src/cart.ts"]);
  shop.commit("Checkout page", "2026-03-03T09:30:00", ["src/checkout.ts", "package-lock.json"]);
  shop.commit("Someone else's work", "2026-03-04T11:00:00", ["src/other.ts"], "Sam Other <sam@example.com>"); // not yours
  shop.commit("Fix checkout crash", "2026-03-04T09:05:00", ["src/checkout.ts", "src/cart.ts"]);
  shop.commit("Saturday polish", "2026-07-11T15:00:00", ["src/cart.css"]); // a Saturday
  const todo = repo("todo-app");
  todo.commit("Due dates", "2026-11-20T09:45:00", ["app.py"]);
  todo.commit("Next year already", "2027-01-02T10:00:00", ["app.py"]); // after the year: not counted

  addJournalEntry("Shipped the checkout", new Date(2026, 2, 3, 17, 0));
  addJournalEntry("Checkout bugs, again", new Date(2026, 2, 4, 17, 0));
  addJournalEntry("Planning 2027", new Date(2027, 0, 5, 9, 0)); // not this year

  const config = { ...defaultConfig(), projectsRoots: [root] };
  const runs = [
    { at: new Date(2026, 2, 2, 12).toISOString(), tool: "go", ok: true, source: "web", project: "shop-website", ms: 2 * 3600_000 },
    { at: new Date(2026, 2, 3, 12).toISOString(), tool: "go", ok: true, source: "web", project: "shop-website", ms: 3600_000 },
    { at: new Date(2025, 5, 1).toISOString(), tool: "go", ok: true, source: "web", project: "shop-website", ms: 9 * 3600_000 },
    { at: new Date(2026, 2, 3, 12).toISOString(), tool: "mcp.check_url", ok: true, source: "mcp", project: "shop-website", ms: 900 },
    { at: new Date(2026, 2, 3, 12).toISOString(), tool: "mcp.list_projects", ok: true, source: "mcp", ms: 20 },
  ];
  const sessions = [
    { name: "shop-website", at: "2026-03-04T10:00:00Z", note: "Checkout half-done", noteBy: "ai" as const, noteAt: "2026-03-04T10:00:00Z" },
    { name: "todo-app", at: "2026-11-20T10:00:00Z", note: "Next: reminders", noteBy: "you" as const, noteAt: "2026-11-20T10:00:00Z" },
  ];
  const { review, story } = await buildYearStory(2026, { config, now: new Date(2026, 11, 31, 23, 0), github: false, runs, sessions });

  assert.equal(story.commits, 6, "five of yours in shop-website and one in todo-app; not 2025's, 2027's or Sam's");
  assert.equal(review.commits, 6);
  assert.equal(story.activeDays, 5);
  assert.equal(story.projects, 2);
  assert.deepEqual(story.longestStreak, { from: "2026-03-02", to: "2026-03-04", days: 3 });
  assert.deepEqual(story.busiestWeek, { from: "2026-03-02", to: "2026-03-08", commits: 4 });
  assert.deepEqual(story.biggestDay, { date: "2026-03-02", commits: 2, projects: ["shop-website"] });
  assert.deepEqual(story.peak, { weekday: 0, hour: 9, commits: 1 }, "Monday 09:00 is the first of the busiest hours");
  assert.equal(story.heat[0][9], 1);
  assert.equal(story.heat[0][21], 1);
  assert.equal(story.heat[5][15], 1, "Saturday 15:00");
  assert.equal(story.heat.flat().reduce((a, b) => a + b, 0), 6);
  assert.equal(story.evenings, 1 / 6);
  assert.equal(story.weekends, 1 / 6);
  assert.deepEqual(
    story.months.map((m) => [m.month, m.commits, m.project]),
    [
      ["March", 4, "shop-website"],
      ["July", 1, "shop-website"],
      ["November", 1, "todo-app"],
    ],
  );
  assert.deepEqual(story.files[0], { project: "shop-website", path: "src/cart.ts", commits: 3 });
  assert.ok(!story.files.some((f) => f.path === "package-lock.json"), "lock files aren't listed");
  assert.ok(!story.files.some((f) => f.path === "src/other.ts"), "Sam's file isn't yours");
  assert.deepEqual(story.languages, [
    { language: "TypeScript", files: 5 },
    { language: "CSS", files: 2 },
    { language: "Python", files: 1 },
  ]);
  assert.equal(story.fixes.count, 2);
  assert.deepEqual(story.fixes.examples.map((c) => c.subject), ["Fix checkout crash", "fix: cart total rounding"]);
  assert.deepEqual(story.first, { date: "2026-03-02", time: "09:15", project: "shop-website", subject: "Add the cart" });
  assert.deepEqual(story.last, { date: "2026-11-20", time: "09:45", project: "todo-app", subject: "Due dates" });
  assert.equal(story.devMs, 3 * 3600_000, "only this year's dev server time");
  assert.deepEqual(story.devProjects, [{ project: "shop-website", ms: 3 * 3600_000 }]);
  assert.equal(story.journal.entries, 2);
  assert.deepEqual(story.journal.words, [{ word: "checkout", count: 2 }]);
  assert.deepEqual(story.ai, { calls: 2, projects: 1 });
  assert.deepEqual(story.notes, { you: 1, ai: 1 });

  const md = formatYearReview(review, story);
  assert.ok(md.includes("## The year in numbers"), md);
  assert.ok(md.includes("- **When you code**: most often on Mondays, 09:00–10:00; 17% of commits in the evening or at night, 17% at weekends"), md);
  assert.ok(md.includes("- **Busiest week**: 2 March to 8 March, 4 commits"), md);
  assert.ok(md.includes("- **Bugs squashed**: 2 commits that fix something"), md);
  assert.ok(md.includes("- **Most-touched file**: shop-website/src/cart.ts, changed in 3 commits"), md);
  assert.ok(md.includes("- **Languages**: TypeScript (5 files), CSS (2 files), Python (1 file)"), md);
  assert.ok(md.includes("- **Dev servers ran**: 3h in all, most for shop-website (3h)"), md);
  assert.ok(md.includes("- **First commit**: 2 March at 09:15, shop-website: Add the cart"), md);
  assert.ok(!md.includes("Sam"), "nobody else's commits");

  // A past year stops at its own end: 2026's commits and journal aren't 2025's.
  const past = await buildYearStory(2025, { config, now: new Date(2026, 11, 31, 23, 0), github: false, runs, sessions });
  assert.equal(past.story.commits, 1);
  assert.equal(past.review.commits, 1);
  assert.equal(past.review.summary.journal.length, 0);
  assert.equal(past.story.first?.subject, "Start the shop");
});
