import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-atomic-home-"));
const { writeFileAtomic, saveConfig, loadConfig } = await import("../index.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-atomic-"));

test("a file is replaced whole, with no temporary file left beside it", () => {
  const file = path.join(dir, "state.json");
  writeFileAtomic(file, '{"a":1}\n');
  writeFileAtomic(file, '{"a":2}\n');
  assert.equal(fs.readFileSync(file, "utf8"), '{"a":2}\n');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
  writeFileAtomic(file, Buffer.from([1, 2, 3]));
  assert.deepEqual([...fs.readFileSync(file)], [1, 2, 3], "bytes too");
});

test("the mode is kept for a file that holds secrets", { skip: process.platform === "win32" && "Windows has no file modes" }, () => {
  const file = path.join(dir, "secret.json");
  writeFileAtomic(file, "{}", { mode: 0o600 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("when it can't replace the file it says so (or writes in place), and cleans up after itself", () => {
  const blocked = path.join(dir, "a-folder");
  fs.mkdirSync(blocked);
  assert.throws(() => writeFileAtomic(blocked, "x", { direct: false }));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "no temporary file left");
  assert.ok(fs.statSync(blocked).isDirectory(), "the folder is untouched");
});

test("dx's config is written whole and reads back", () => {
  const config = loadConfig();
  saveConfig({ ...config, editor: "zed" });
  assert.equal(loadConfig().editor, "zed");
  assert.deepEqual(fs.readdirSync(process.env.DX_HOME!).filter((f) => f.endsWith(".tmp")), []);
});
