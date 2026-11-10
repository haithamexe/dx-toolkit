import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-webautosetup-test-"));
const { saveWeeklySummary, weekKey } = await import("../autosetup.js");

test("weeks are ISO weeks: a year's first days can belong to the week before", () => {
  assert.equal(weekKey(new Date(2026, 10, 10)), "2026-W46");
  assert.equal(weekKey(new Date(2026, 0, 1)), "2026-W01");
  assert.equal(weekKey(new Date(2027, 0, 1)), "2026-W53", "1 January 2027 is a Friday: still the last week of 2026");
  assert.equal(weekKey(new Date(2026, 11, 28)), "2026-W53");
});

test("a summary saves itself once a week, from Monday on, never on a Sunday, without GitHub", async () => {
  const calls: unknown[] = [];
  const build = (async (options: unknown) => (calls.push(options), { projects: [] })) as never;
  const save = ((_text: string) => path.join(process.env.DX_HOME!, "summaries", "week.md")) as never;
  const format = (() => "# week") as never;

  const sunday = new Date(2026, 10, 8, 10);
  assert.equal(await saveWeeklySummary(sunday, build, save, format), undefined, "a week isn't whole yet");
  assert.equal(calls.length, 0);

  const monday = new Date(2026, 10, 9, 10);
  const notice = await saveWeeklySummary(monday, build, save, format);
  assert.match(notice?.text ?? "", /Saved your last 7 days' summary/);
  assert.deepEqual(calls, [{ days: 7, allAuthors: false, github: false }]);

  // The same week: nothing more. The next one: again.
  assert.equal(await saveWeeklySummary(new Date(2026, 10, 12, 10), build, save, format), undefined);
  assert.equal(calls.length, 1);
  assert.ok(await saveWeeklySummary(new Date(2026, 10, 16, 10), build, save, format));
  assert.equal(calls.length, 2);
});
