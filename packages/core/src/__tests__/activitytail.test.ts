import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// "What's new since id N" reads the end of the day's file, not all of it. It must give exactly what
// reading everything would: across chunk edges, with lines longer than a chunk, with multi-byte
// text cut by a chunk edge, and with an event a little out of order.
process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-activitytail-"));
const { appendActivity, readActivity, readTailEvents, nextActivityId } = await import("../index.js");
type Ev = import("../index.js").ActivityEvent;

const dir = path.join(os.tmpdir(), "dx-activitytail-shop");
const now = Date.now();
const event = (i: number, extra: Partial<Ev> = {}): Ev => ({ id: nextActivityId(now - 3_600_000 + i * 100), at: new Date(now - 3_600_000 + i * 100).toISOString(), dir, project: "shop", type: "request", text: `GET /api/item/${i}`, from: "proxy", ...extra });

test("after an id, the events written since, the same as reading the whole file", () => {
  // 6000 events, some with big bodies, so the file is several chunks long, with text that needs more than one byte per character.
  const all: Ev[] = [];
  for (let i = 0; i < 6000; i++) all.push(event(i, { text: `GET /api/item/${i} café ünï ✓`, ...(i % 500 === 0 ? { responseBody: "x".repeat(300 * 1024) } : {}) }));
  appendActivity(all, Infinity);
  const everything = readActivity({ dir, limit: 100_000 });
  assert.equal(everything.length, 6000);
  for (const from of [0, 1, 5990, 5999, 3000, 5500, 100]) {
    const after = all[from].id;
    const want = all.slice(from + 1).map((e) => e.id);
    const got = readActivity({ dir, after, limit: 100_000 }).map((e) => e.id);
    assert.deepEqual(got, want, `after event ${from}`);
  }
  assert.deepEqual(readActivity({ dir, after: all[5999].id, limit: 10 }), [], "nothing new");
  assert.equal(readActivity({ dir, after: all[2999].id, limit: 5 }).length, 5, "the newest five of what's new");
  assert.equal(readActivity({ dir, after: all[2999].id, limit: 5 }).at(-1)?.id, all[5999].id);
  assert.ok(readActivity({ dir, after: all[10].id, limit: 3 }).every((e) => e.text.endsWith("café ünï ✓")), "text cut at a chunk edge reads whole");
});

test("a line longer than a chunk and an event a little out of order are both found", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dx-tail-file-")), "day.jsonl");
  const t = 1_800_000_000_000_000;
  const line = (id: number, text: string) => JSON.stringify({ id, at: "2026-11-10T10:00:00.000Z", dir, project: "shop", type: "request", text, from: "proxy" }) + "\n";
  // ids t+1 .. t+5, the fourth written after the fifth (a page sent its click late), and a huge one in the middle.
  fs.writeFileSync(file, line(t + 1, "a") + line(t + 2, "b".repeat(700 * 1024)) + line(t + 3, "c") + line(t + 5, "e") + line(t + 4, "d"));
  assert.deepEqual(readTailEvents(file, t + 2).map((e) => e.id), [t + 3, t + 5, t + 4], "oldest first, in file order, with the huge line not in the way");
  assert.deepEqual(readTailEvents(file, 0).map((e) => e.id), [t + 1, t + 2, t + 3, t + 5, t + 4], "everything for a small boundary");
  assert.equal(readTailEvents(file, t + 2).length, 3);
  assert.deepEqual(readTailEvents(path.join(os.tmpdir(), "dx-no-such-file.jsonl"), 0), []);
  // A line cut short by a stopped dashboard, and an empty file.
  fs.writeFileSync(file, line(t + 1, "a") + '{"id":' + (t + 2));
  assert.deepEqual(readTailEvents(file, 0).map((e) => e.id), [t + 1]);
  fs.writeFileSync(file, "");
  assert.deepEqual(readTailEvents(file, 0), []);
});
