import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-shellenv-"));
const { mergePath, pathFromShellOutput, shellPathArgs, wellKnownBinDirs } = await import("../tools/shellenv.js");
const { terminalScript } = await import("../tools/terminals.js");

test("PATH lists merge in order, each folder once", () => {
  assert.equal(mergePath("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin:", undefined, "/bin:/usr/local/bin"), "/opt/homebrew/bin:/usr/bin:/bin:/usr/local/bin");
  assert.equal(mergePath(undefined, ""), "");
});

test("the shell's PATH is read between the marks, whatever the shell printed around it", () => {
  const out = "Welcome!\n__DX_PATH__/Users/octocat/.nvm/versions/node/v22.1.0/bin:/usr/bin\n__DX_PATH__\nbye";
  assert.equal(pathFromShellOutput(out), "/Users/octocat/.nvm/versions/node/v22.1.0/bin:/usr/bin");
  assert.equal(pathFromShellOutput("__DX_PATH__ unfinished"), undefined);
  assert.equal(pathFromShellOutput("__DX_PATH____DX_PATH__"), undefined, "an empty PATH isn't taken");
});

test("zsh and bash are asked interactively (nvm lives in their rc files), sh only as a login shell", () => {
  assert.equal(shellPathArgs("/bin/zsh")[0], "-ilc");
  assert.equal(shellPathArgs("/usr/bin/fish")[0], "-ilc");
  assert.equal(shellPathArgs("/bin/sh")[0], "-lc");
  assert.ok(shellPathArgs("/bin/bash")[1].includes("printenv PATH"));
});

test("only install folders that exist are added", () => {
  const home = "/home/octocat";
  const dirs = wellKnownBinDirs(home, "darwin", (d) => d === "/opt/homebrew/bin" || d === path.join(home, ".volta", "bin"));
  assert.deepEqual(dirs, ["/opt/homebrew/bin", path.join(home, ".volta", "bin")]);
  assert.ok(!wellKnownBinDirs(home, "linux", () => true).includes("/opt/homebrew/bin"));
});

test("Terminal.app gets a .command file that goes to the folder, runs the command and keeps the shell", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "dx-term-"));
  const file = terminalScript("/path/to/it's here", "npm run dev", folder);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(file.endsWith(".command"));
  assert.ok(text.startsWith("#!/bin/sh\n"));
  const quote = String.fromCharCode(39);
  const escaped = [quote, "\\", quote, quote].join("");
  assert.ok(text.includes(`cd ${quote}/path/to/it${escaped}s here${quote} || exit 1`), "the folder is quoted for sh");
  assert.ok(text.includes("\nnpm run dev\n"));
  assert.ok(text.includes('exec "${SHELL:-/bin/zsh}" -l'));
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o700);
});
