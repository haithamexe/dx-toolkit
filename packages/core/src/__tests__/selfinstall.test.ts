import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-selfinstall-test-"));
const { findDxInstalls, shimTarget } = await import("../index.js");

/** A pretend npm global folder: never the real one. */
function npmFolder() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dx-npm-global-"));
  const root = path.join(base, "node_modules");
  const binDir = path.join(base, "bin");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  return { root, binDir };
}

// The shims npm writes on Windows (dx.cmd) and elsewhere (a link to the package's bin).
const cmdShim = (pkg: string) => `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\${pkg}\\dist\\index.js" %*\r\n`;

test("shims are told apart by the install they start, and other programs' shims are left alone", () => {
  const { binDir } = npmFolder();
  fs.writeFileSync(path.join(binDir, "a.cmd"), cmdShim("dx-devkit"));
  fs.writeFileSync(path.join(binDir, "b.cmd"), cmdShim("@dx\\cli"));
  fs.writeFileSync(path.join(binDir, "c"), '#!/bin/sh\nexec node "$basedir/node_modules/@dx/cli/dist/index.js" "$@"\n');
  fs.writeFileSync(path.join(binDir, "d.cmd"), cmdShim("typescript"));
  assert.equal(shimTarget(path.join(binDir, "a.cmd")), "npm");
  assert.equal(shimTarget(path.join(binDir, "b.cmd")), "local");
  assert.equal(shimTarget(path.join(binDir, "c")), "local");
  assert.equal(shimTarget(path.join(binDir, "d.cmd")), undefined);
  assert.equal(shimTarget(path.join(binDir, "missing")), undefined);
});

test("finds the npm install, and shims whose install is gone (what makes npm say EEXIST)", () => {
  const dirs = npmFolder();
  assert.deepEqual(findDxInstalls(dirs), { ...dirs, strayShims: [] }, "nothing installed");

  // Shims left by a linked build that was removed by hand: stray.
  fs.writeFileSync(path.join(dirs.binDir, "dx.cmd"), cmdShim("@dx\\cli"));
  fs.writeFileSync(path.join(dirs.binDir, "dx"), '#!/bin/sh\nexec node "$basedir/node_modules/@dx/cli/dist/index.js" "$@"\n');
  let found = findDxInstalls(dirs);
  assert.deepEqual(found.strayShims.map((f) => path.basename(f)).sort(), ["dx", "dx.cmd"]);

  // dx-devkit installed, but the shims still start the link: still stray.
  const pkg = path.join(dirs.root, "dx-devkit");
  fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "dx-devkit", version: "1.4.0" }));
  found = findDxInstalls(dirs);
  assert.equal(found.npm, pkg);
  assert.equal(found.local, undefined);
  assert.equal(found.strayShims.length, 2);

  // Shims that start the package that's there are its own.
  fs.writeFileSync(path.join(dirs.binDir, "dx.cmd"), cmdShim("dx-devkit"));
  fs.writeFileSync(path.join(dirs.binDir, "dx"), '#!/bin/sh\nexec node "$basedir/node_modules/dx-devkit/dist/index.js" "$@"\n');
  assert.deepEqual(findDxInstalls(dirs).strayShims, []);
});

test("a linked build is found by where its link points", () => {
  const dirs = npmFolder();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dx-repo-"));
  const cli = path.join(repo, "packages", "cli");
  fs.mkdirSync(cli, { recursive: true });
  fs.writeFileSync(path.join(cli, "package.json"), JSON.stringify({ name: "@dx/cli" }));
  fs.mkdirSync(path.join(dirs.root, "@dx"));
  fs.symlinkSync(cli, path.join(dirs.root, "@dx", "cli"), "junction");
  const found = findDxInstalls(dirs);
  assert.equal(found.local, fs.realpathSync(cli));
  assert.equal(found.npm, undefined);
});
