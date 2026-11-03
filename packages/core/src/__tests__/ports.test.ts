import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeEntries, parseLsof, parseWindowsJson, windowsPortScript } from "../tools/ports.js";

test("parses PowerShell JSON array", () => {
  const out =
    '[{"port":3000,"address":"::","pid":1234,"name":"node.exe","cmd":"\\"C:\\\\Program Files\\\\nodejs\\\\node.exe\\" next dev"},' +
    '{"port":3000,"address":"0.0.0.0","pid":1234,"name":"node.exe","cmd":"node next dev"},' +
    '{"port":445,"address":"0.0.0.0","pid":4,"name":"System","cmd":null}]';
  const rows = parseWindowsJson(out);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].cmd, '"C:\\Program Files\\nodejs\\node.exe" next dev');
  const merged = mergeEntries(rows);
  assert.equal(merged.length, 2, "same port + pid on two addresses is one entry");
  assert.deepEqual(merged[1].addresses, ["::", "0.0.0.0"]);
  assert.equal(merged[0].port, 445);
});

test("parses a single PowerShell object (not wrapped in an array) and BOM", () => {
  const rows = parseWindowsJson('\uFEFF{"port":5173,"address":"::1","pid":99,"name":"node.exe","cmd":"vite"}\r\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].port, 5173);
});

test("empty PowerShell output", () => {
  assert.deepEqual(parseWindowsJson("[]"), []);
  assert.deepEqual(parseWindowsJson("  \r\n"), []);
});

test("PowerShell script filters by port only when asked", () => {
  assert.match(windowsPortScript(3000), /-State Listen -LocalPort 3000/);
  assert.doesNotMatch(windowsPortScript(), /-LocalPort/);
});

test("parses lsof -F output", () => {
  const out = ["p501", "cnode", "f22", "n*:3000", "f23", "n[::1]:3000", "p77", "cpostgres", "f5", "n127.0.0.1:5432", ""].join("\n");
  const rows = parseLsof(out);
  assert.deepEqual(
    rows.map((r) => [r.pid, r.name, r.address, r.port]),
    [
      [501, "node", "*", 3000],
      [501, "node", "::1", 3000],
      [77, "postgres", "127.0.0.1", 5432],
    ],
  );
});
