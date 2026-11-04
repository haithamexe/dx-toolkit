import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkSummary } from "../tools/summary.js";
import { formatYearReview, reviewFrom } from "../tools/year.js";

const commit = (date: string, subject = "work") => ({ hash: date + subject, date, time: "10:00", subject });

const summary: WorkSummary = {
  from: "2026-01-01",
  to: "2026-12-31",
  days: 365,
  author: "Alex Rivera",
  projects: [
    { project: "shop-website", dir: "/p/shop", commits: [commit("2026-03-01"), commit("2026-03-02"), commit("2026-03-03"), commit("2026-03-03", "again"), commit("2026-07-10")] },
    { project: "todo-app", dir: "/p/todo", commits: [commit("2026-03-05"), commit("2026-11-20")] },
  ],
  journal: [
    { date: "2026-03-02", time: "09:00", text: "Shipped the new checkout" },
    { date: "2026-11-20", time: "17:00", text: "Due dates done" },
  ],
  skipped: [],
  time: [{ project: "shop-website", days: 5, commits: 5, opens: 3, devMs: 2 * 3600_000 }],
  uncommitted: [],
  github: { user: "octocat", authenticated: true, merged: [{ title: "Add checkout", repo: "octocat/shop-website", number: 12, url: "https://github.com/octocat/shop-website/pull/12", date: "2026-03-04" }], reviewed: [] },
};

test("counts the year: months, busiest day, longest run, projects", () => {
  const r = reviewFrom(2026, summary);
  assert.equal(r.commits, 7);
  assert.equal(r.activeDays, 6);
  assert.deepEqual(r.busiestDay, { date: "2026-03-03", commits: 2 });
  assert.deepEqual(r.longestStreak, { from: "2026-03-01", to: "2026-03-03", days: 3 });
  const march = r.months[2];
  assert.deepEqual(march, { month: "March", commits: 5, activeDays: 4, topProject: "shop-website", journal: 1 });
  assert.equal(r.months[0].commits, 0);
  assert.deepEqual(r.projects[0], { project: "shop-website", commits: 5, activeDays: 4, first: "2026-03-01", last: "2026-07-10" });
});

test("writes it as one document", () => {
  const md = formatYearReview(reviewFrom(2026, summary));
  assert.ok(md.startsWith("# 2026 in review\n"));
  assert.ok(md.includes("**7 commits in 2 projects · 6 days with commits · 1 pull request(s) merged · 0 reviewed · 2 journal entries**"), md);
  assert.ok(md.includes("- **Longest run**: 3 days in a row with commits, 1 March to 3 March"));
  assert.ok(md.includes("| March | 5 | 4 | shop-website | 1 |"));
  assert.ok(!md.includes("| January |"), "empty months are left out");
  assert.ok(md.includes("| shop-website | 5 | 4 | 1 March | 10 July | 2h |"), md);
  assert.ok(md.includes("- Add checkout ([octocat/shop-website#12]"));
  assert.ok(md.includes("**March**\n- Shipped the new checkout"));
});
