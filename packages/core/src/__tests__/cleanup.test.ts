import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultConfig } from "../config.js";
import { deleteCleanup, findCleanup, folderSize, formatBytes } from "../tools/cleanup.js";

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Makes every file and folder in `dir` look untouched for `days` days. */
function age(dir: string, days: number): void {
  const when = new Date(Date.now() - days * 86_400_000);
  const walk = (p: string) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) if (e.isDirectory()) walk(path.join(p, e.name));
    fs.utimesSync(p, when, when);
  };
  walk(dir);
  for (const f of ["package.json", ".git/index", ".git/HEAD"]) {
    const file = path.join(dir, f);
    if (fs.existsSync(file)) fs.utimesSync(file, when, when);
  }
}

const write = (file: string, bytes: number) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
};

test("formatBytes", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(5 * 1024 ** 3), "5.0 GB");
  assert.equal(formatBytes(300 * 1024 ** 2), "300 MB");
});

test("folderSize adds up nested files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-size-"));
  write(path.join(dir, "a.bin"), 100);
  write(path.join(dir, "x/y/b.bin"), 50);
  assert.deepEqual(await folderSize(dir), { bytes: 150, files: 2 });
});

test("findCleanup only offers ignored or always-rebuildable folders in idle projects, and deletes them", { skip: !hasGit() && "git not installed" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-clean-"));

  // Idle git repo: node_modules and dist are ignored; build/ is committed, so it must stay.
  const old = path.join(root, "old-app");
  write(path.join(old, "package.json"), 10);
  write(path.join(old, "node_modules/dep/index.js"), 4000);
  write(path.join(old, "dist/app.js"), 1000);
  write(path.join(old, "build/keep.txt"), 500);
  write(path.join(old, "packages/web/.next/cache.bin"), 2000);
  fs.writeFileSync(path.join(old, ".gitignore"), "node_modules/\ndist/\n.next/\n");
  execFileSync("git", ["init", "-q"], { cwd: old });

  // Idle non-git project: node_modules counts, dist doesn't (could be the only copy).
  const plain = path.join(root, "plain-app");
  write(path.join(plain, "package.json"), 10);
  write(path.join(plain, "node_modules/x.js"), 300);
  write(path.join(plain, "dist/only-copy.js"), 300);

  // Active project: never offered.
  const fresh = path.join(root, "fresh-app");
  write(path.join(fresh, "package.json"), 10);
  write(path.join(fresh, "node_modules/x.js"), 9999);

  age(old, 60);
  age(plain, 60);

  const config = { ...defaultConfig(), projectsRoots: [root] };
  const scan = await findCleanup({ days: 30, config });
  assert.equal(scan.projectsScanned, 2);
  assert.deepEqual(
    scan.items.map((i) => [i.project, i.relative, i.bytes]),
    [
      ["old-app", "node_modules", 4000],
      ["old-app", "packages/web/.next", 2000],
      ["old-app", "dist", 1000],
      ["plain-app", "node_modules", 300],
    ],
  );
  assert.equal(scan.totalBytes, 7300);

  const results = await deleteCleanup(scan.items);
  assert.ok(results.every((r) => r.ok));
  assert.ok(!fs.existsSync(path.join(old, "node_modules")));
  assert.ok(!fs.existsSync(path.join(old, "dist")));
  assert.ok(fs.existsSync(path.join(old, "build/keep.txt")), "committed build folder kept");
  assert.ok(fs.existsSync(path.join(old, "package.json")));
  assert.ok(fs.existsSync(path.join(plain, "dist/only-copy.js")), "dist outside git kept");
  assert.ok(fs.existsSync(path.join(fresh, "node_modules/x.js")), "active project untouched");
});

test("deleteCleanup refuses anything that isn't a build folder inside its project", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-guard-"));
  write(path.join(dir, "src/index.js"), 10);
  const results = await deleteCleanup([
    { project: "x", projectDir: dir, dir: path.join(dir, "src"), relative: "src", bytes: 10, files: 1, lastActive: 0 },
    { project: "x", projectDir: dir, dir, relative: "", bytes: 10, files: 1, lastActive: 0 },
    { project: "x", projectDir: path.join(dir, "src"), dir: path.join(dir, "node_modules"), relative: "../node_modules", bytes: 0, files: 0, lastActive: 0 },
  ]);
  assert.ok(results.every((r) => !r.ok));
  assert.ok(fs.existsSync(path.join(dir, "src/index.js")));
});
