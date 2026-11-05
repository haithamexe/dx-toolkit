import assert from "node:assert/strict";
import { test } from "node:test";

const { slowerThan, heavierThan, newIssues, qrMatrix, qrPath } = await import("../index.js");

test("speed: only a clear slowdown or a heavier page counts; dev servers are noisy", () => {
  assert.equal(slowerThan({ lcpMs: 900 }, { lcpMs: 800 }), undefined, "100 ms isn't a change");
  assert.equal(slowerThan({ lcpMs: 1700 }, { lcpMs: 1200 }), "largest paint 1.2 s → 1.7 s");
  assert.equal(slowerThan({ loadMs: 800, tbtMs: 350 }, { loadMs: 790, tbtMs: 20 }), "main thread blocked 20 ms → 350 ms");
  assert.equal(slowerThan({ cls: 0.25 }, { cls: 0.02 }), "layout shift 0.02 → 0.25");
  assert.equal(slowerThan({ lcpMs: 2000 }, undefined), undefined, "nothing to compare with");
  assert.equal(heavierThan({ jsBytes: 512_000 }, { jsBytes: 420_000 }), "JavaScript 410 KB → 500 KB");
  assert.equal(heavierThan({ jsBytes: 425_000 }, { jsBytes: 420_000 }), undefined);
});

test("accessibility: new problems are the ones the commit before didn't have", () => {
  const before = [{ rule: "lang" as const, text: "The page has no language" }];
  const now = [...before, { rule: "alt" as const, text: "Image without alt text: logo.png" }];
  assert.deepEqual(newIssues(now, before), [now[1]]);
  assert.deepEqual(newIssues(before, now), []);
  assert.deepEqual(newIssues(now, undefined), [], "no earlier capture: nothing is new");
});

test("QR codes: the size of the version, finder patterns in three corners, a path to draw", () => {
  const m = qrMatrix("http://192.168.1.23:54321/__dx/phone?c=0123456789abcdef0123456789abcdef");
  assert.equal(m.length, 37, "version 5");
  const finder = (r: number, c: number) => [0, 6].every((d) => m[r + d][c] && m[r][c + d]) && m[r + 3][c + 3] && !m[r + 1][c + 1];
  assert.ok(finder(0, 0) && finder(0, m.length - 7) && finder(m.length - 7, 0));
  assert.equal(m[m.length - 8][8], true, "the dark module");
  assert.equal(qrMatrix("hi").length, 21);
  assert.equal(qrMatrix("y".repeat(210)).length, 57, "version 10");
  assert.throws(() => qrMatrix("z".repeat(300)), /Too long/);
  const p = qrPath(qrMatrix("hi"));
  assert.equal(p.size, 29);
  assert.match(p.d, /^M\d+ \d+h1v1h-1z/);
});
