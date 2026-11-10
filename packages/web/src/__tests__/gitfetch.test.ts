import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-gitfetch-test-"));
const { fetchDue, fetchProject } = await import("../gitfetch.js");

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString();
const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `dx-gitfetch-${name}-`));

function repoWithRemote() {
  const bare = tmp("bare");
  git(bare, "init", "-q", "--bare", "--initial-branch=main");
  const mine = tmp("mine");
  git(mine, "init", "-q", "--initial-branch=main");
  for (const c of [mine]) {
    git(c, "config", "user.email", "octocat@example.com");
    git(c, "config", "user.name", "octocat");
  }
  fs.writeFileSync(path.join(mine, "a.txt"), "one\n");
  git(mine, "add", ".");
  git(mine, "commit", "-q", "-m", "first");
  git(mine, "remote", "add", "origin", bare);
  git(mine, "push", "-q", "-u", "origin", "main");
  // Someone else pushes.
  const other = tmp("other");
  git(other, "clone", "-q", bare, ".");
  git(other, "config", "user.email", "octocat@example.com");
  git(other, "config", "user.name", "octocat");
  return { mine, other };
}

test("a project's remote branches are fetched on their own, never merged: behind becomes true, the files stay", async () => {
  const { mine, other } = repoWithRemote();
  fs.writeFileSync(path.join(other, "b.txt"), "two\n");
  git(other, "add", ".");
  git(other, "commit", "-q", "-m", "second");
  git(other, "push", "-q", "origin", "main");

  assert.equal(git(mine, "rev-list", "--count", "HEAD..origin/main").trim(), "0", "not known to be behind yet");
  assert.equal(await fetchProject(mine, "todo-app"), "moved");
  assert.equal(git(mine, "rev-list", "--count", "HEAD..origin/main").trim(), "1", "now it says one behind");
  assert.equal(fs.existsSync(path.join(mine, "b.txt")), false, "nothing was merged into the working copy");
  assert.equal(await fetchProject(mine, "todo-app"), "same");
});

test("a project without a remote is skipped, and a project is fetched at most every few minutes", async () => {
  const lonely = tmp("lonely");
  git(lonely, "init", "-q");
  assert.equal(await fetchProject(lonely, "scratch"), "skipped");

  const { mine } = repoWithRemote();
  const now = Date.now();
  assert.deepEqual(await fetchDue([{ dir: mine, name: "shop-website" }], now), ["shop-website"]);
  assert.deepEqual(await fetchDue([{ dir: mine, name: "shop-website" }], now + 60_000), [], "too soon");
  assert.deepEqual(await fetchDue([{ dir: mine, name: "shop-website" }], now + 6 * 60_000), ["shop-website"]);
});
