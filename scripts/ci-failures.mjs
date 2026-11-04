#!/usr/bin/env node
// Turns failed tests in `npm test` output into GitHub Actions annotations (::error), one per test
// with its error, so a failed run says which test failed and why on its summary page, and through
// the public check-runs API, without opening a 100 KB log. Reads TAP (Windows, macOS in CI) and the
// spec reporter's "failing tests" list (Linux). Usage: node scripts/ci-failures.mjs test-output.txt

import fs from "node:fs";

const text = fs.readFileSync(process.argv[2] ?? "test-output.txt", "utf8").replace(/^\S+Z /gm, "");
const lines = text.split(/\r?\n/);
const failures = [];

// TAP: "not ok 12 - name" followed by an indented YAML block up to "...".
for (let i = 0; i < lines.length; i++) {
  const m = /^\s*not ok \d+ - (.*)$/.exec(lines[i]);
  if (!m || /# SKIP|# TODO/.test(m[1])) continue;
  const detail = [];
  for (let j = i + 1; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j]) && detail.length < 40; j++) detail.push(lines[j].trim());
  failures.push({ name: m[1], detail: pick(detail) });
}

// The spec reporter: "✖ failing tests:" then "✖ name" with the error below it.
const start = lines.findIndex((l) => /✖ failing tests:/.test(l));
if (start >= 0) {
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^\s*✖ (.*?)(?: \([\d.]+ms\))?$/.exec(lines[i]);
    if (!m) continue;
    const detail = [];
    for (let j = i + 1; j < lines.length && !/^\s*(✖ |test at )/.test(lines[j]) && detail.length < 30; j++) detail.push(lines[j].trim());
    if (!failures.some((f) => f.name === m[1])) failures.push({ name: m[1], detail: pick(detail) });
  }
}

/** The lines that say what went wrong: the error, expected and actual, and the first frames. */
function pick(detail) {
  const useful = detail.filter((l) => l && !/^(---|duration_ms|type: 'test'|failureType|code: |name: 'AssertionError'|operator|generatedMessage|diff: )/.test(l));
  return useful.slice(0, 14).join("\n");
}

const escape = (s) => s.replace(/%/g, "%25").replace(/\r/g, "").replace(/\n/g, "%0A");
for (const f of failures.slice(0, 10)) console.log(`::error title=${escape(f.name).replace(/[:,]/g, " ")}::${escape(f.detail || "failed")}`);
if (!failures.length) console.log("::error title=npm test failed::No failed test was found in the output; the build or a test file may have crashed. See the log.");
