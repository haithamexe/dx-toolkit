import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("journal appends under one heading per day and reads back", async () => {
  process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-home-"));
  const { addJournalEntry, readJournal, journalPath } = await import("../tools/journal.js");

  addJournalEntry("first thing", new Date(2026, 10, 2, 9, 5));
  addJournalEntry("second   thing\n", new Date(2026, 10, 2, 17, 30));
  addJournalEntry("next day", new Date(2026, 10, 3, 8, 0));

  const text = fs.readFileSync(journalPath(), "utf8");
  assert.equal(
    text,
    "# Work journal\n\n## 2026-11-02\n- 09:05 first thing\n- 17:30 second thing\n\n## 2026-11-03\n- 08:00 next day\n",
  );

  const all = readJournal();
  assert.equal(all.length, 3);
  const lastDay = readJournal({ sinceDays: 1, now: new Date(2026, 10, 3, 12, 0) });
  assert.deepEqual(lastDay, [{ date: "2026-11-03", time: "08:00", text: "next day" }]);

  assert.throws(() => addJournalEntry("   "), /empty/);
});
