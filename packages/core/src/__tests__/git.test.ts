import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-git-test-"));
const { gitCommit, gitCommitDetail, gitFileDiff, gitGraph, gitStage, gitStageHunk, gitStatus, gitUnstage, layoutGraph, GitError } = await import("../index.js");

function repo(): { dir: string; git: (...args: string[]) => string; write: (name: string, content: string) => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "octocat@example.com");
  git("config", "user.name", "octocat");
  git("config", "core.autocrlf", "false");
  git("config", "commit.gpgsign", "false");
  const write = (name: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  };
  return { dir, git, write };
}

test("lays out a straight line, a branch and its merge without lanes jumping", () => {
  // Newest first: M merges B into A's line; A and B both come from R.
  const rows = layoutGraph([
    { hash: "M", parents: ["A", "B"] },
    { hash: "B", parents: ["R"] },
    { hash: "A", parents: ["R"] },
    { hash: "R", parents: [] },
  ]);
  assert.deepEqual(rows[0], { lane: 0, up: [], down: [0, 1], through: [], moves: [], width: 2 }, "the merge opens a second lane");
  assert.deepEqual(rows[1], { lane: 1, up: [1], down: [1], through: [0], moves: [], width: 2 }, "B goes on down its own lane, past A's");
  assert.deepEqual(rows[2], { lane: 0, up: [0], down: [0], through: [], moves: [[1, 0]], width: 2 }, "B's lane, waiting for R too, joins A's on the left");
  assert.deepEqual(rows[3], { lane: 0, up: [0], down: [], through: [], moves: [], width: 1 }, "the root stays on the left");

  const line = layoutGraph([{ hash: "C", parents: ["B"] }, { hash: "B", parents: ["A"] }, { hash: "A", parents: [] }]);
  assert.ok(line.every((r) => r.lane === 0 && r.width === 1), "a straight history stays in one lane");

  // Two branch tips side by side, then a lane freed and reused.
  const tips = layoutGraph([
    { hash: "X", parents: ["P"] },
    { hash: "Y", parents: ["Q"] },
    { hash: "Q", parents: ["P"] },
    { hash: "P", parents: [] },
    { hash: "Z", parents: [] },
  ]);
  assert.equal(tips[1].lane, 1, "a second tip gets the next lane");
  assert.deepEqual(tips[2].down, [0], "Q joins the lane already waiting for P");
  assert.equal(tips[4].lane, 0, "an unrelated root reuses the first free lane");
});

test("reads the graph with branches, tags and the merge, and leaves stashes out", async () => {
  const { dir, git, write } = repo();
  write("a.txt", "one\n");
  git("add", ".");
  git("commit", "-q", "-m", "First commit");
  git("tag", "v1");
  git("checkout", "-q", "-b", "feature");
  write("b.txt", "feature\n");
  git("add", ".");
  git("commit", "-q", "-m", "Add the feature");
  git("checkout", "-q", "main");
  write("a.txt", "one\ntwo\n");
  git("commit", "-q", "-am", "Second line");
  git("merge", "-q", "--no-ff", "-m", "Merge feature", "feature");
  write("a.txt", "stashed\n");
  git("stash", "-q");

  const graph = await gitGraph(dir);
  assert.equal(graph.commits.length, 4, "four commits; the stash isn't one of them");
  assert.equal(graph.more, false);
  const [merge] = graph.commits;
  assert.equal(merge.subject, "Merge feature");
  assert.equal(merge.parents.length, 2);
  assert.deepEqual(merge.refs, [{ name: "main", kind: "branch", current: true }]);
  assert.equal(graph.width, 2);
  const first = graph.commits.find((c) => c.subject === "First commit")!;
  assert.deepEqual(first.refs, [{ name: "v1", kind: "tag" }]);
  assert.ok(graph.commits.find((c) => c.subject === "Add the feature")!.refs.some((r) => r.name === "feature" && r.kind === "branch"));
  assert.equal(merge.author, "octocat");
  assert.ok(Math.abs(merge.at - Date.now()) < 120_000);

  const limited = await gitGraph(dir, { limit: 2 });
  assert.equal(limited.commits.length, 2);
  assert.equal(limited.more, true);

  const detail = await gitCommitDetail(dir, first.short);
  assert.equal(detail.hash, first.hash);
  assert.equal(detail.message, "First commit");
  assert.deepEqual(detail.files, [{ path: "a.txt", additions: 1, deletions: 0, binary: undefined }]);
  assert.ok(detail.patch.includes("+one"));
  const mergeDetail = await gitCommitDetail(dir, merge.hash);
  assert.deepEqual(mergeDetail.files.map((f) => f.path), ["b.txt"], "a merge shows what it brought in");

  await assert.rejects(gitCommitDetail(dir, "--all"), GitError, "options can't pass as a hash");
  await assert.rejects(gitCommitDetail(dir, "deadbeef"), /isn't in this repository/);
});

test("an empty repository has an empty graph, and its files can be staged and unstaged", async () => {
  const { dir, write } = repo();
  assert.deepEqual(await gitGraph(dir), { commits: [], width: 0, more: false });
  write("new.txt", "hello\n");
  let status = await gitStatus(dir);
  assert.equal(status.hasCommits, false);
  assert.equal(status.branch, "main");
  assert.deepEqual(status.files.map((f) => [f.path, f.untracked, f.staged]), [["new.txt", true, false]]);
  status = await gitStage(dir, ["new.txt"]);
  assert.equal(status.files[0].staged, true);
  status = await gitUnstage(dir, ["new.txt"]);
  assert.equal(status.files[0].untracked, true, "back to untracked, without a HEAD to restore from");
});

test("lists changed, staged, renamed, deleted and untracked files, odd names included", async () => {
  const { dir, git, write } = repo();
  write("keep.txt", "1\n2\n3\n");
  write("old name.txt", "moving\n");
  write("gone.txt", "bye\n");
  // A name that is also a pattern (it would match k.txt), and a file it would match.
  write("[ak].txt", "a name that looks like a pattern\n");
  write("k.txt", "k\n");
  git("add", ".");
  git("commit", "-q", "-m", "Start");
  write("keep.txt", "1\n2\n3\n4\n");
  git("mv", "old name.txt", "new name.txt");
  fs.rmSync(path.join(dir, "gone.txt"));
  write("src/fresh file.ts", "export {};\n");

  const status = await gitStatus(dir);
  const byPath = Object.fromEntries(status.files.map((f) => [f.path, f]));
  assert.equal(byPath["keep.txt"].unstaged, true);
  assert.equal(byPath["keep.txt"].staged, false);
  assert.equal(byPath["new name.txt"].from, "old name.txt");
  assert.equal(byPath["new name.txt"].staged, true);
  assert.equal(byPath["gone.txt"].worktree, "D");
  assert.equal(byPath["src/fresh file.ts"].untracked, true);
  assert.equal(byPath["[ak].txt"], undefined, "unchanged");

  // Stage the deletion and the edit, then the file named like a pattern: k.txt must stay unstaged.
  write("[ak].txt", "changed\n");
  write("k.txt", "changed k\n");
  await gitStage(dir, ["gone.txt", "keep.txt"]);
  const after = await gitStatus(dir);
  const a = Object.fromEntries(after.files.map((f) => [f.path, f]));
  assert.equal(a["gone.txt"].staged, true);
  assert.equal(a["keep.txt"].staged, true);
  await gitStage(dir, ["[ak].txt"]);
  const lit = Object.fromEntries((await gitStatus(dir)).files.map((f) => [f.path, f]));
  assert.equal(lit["[ak].txt"].staged, true);
  assert.equal(lit["k.txt"].staged, false, "paths are literal: [ak].txt isn't a pattern for k.txt");

  // Unstaging a rename takes both of its names out.
  await gitUnstage(dir, ["new name.txt"]);
  const un = await gitStatus(dir);
  assert.ok(un.files.some((f) => f.path === "new name.txt" && f.untracked));
  assert.ok(un.files.some((f) => f.path === "old name.txt" && f.worktree === "D"));

  await assert.rejects(gitStage(dir, ["../outside.txt"]), /isn't among the changed files/);
  await assert.rejects(gitStage(dir, ["README.md"]), (err: any) => err.status === 409);
  await assert.rejects(gitStage(dir, []), /Which files/);
});

test("stages and unstages one block of a file, from git's own diff", async () => {
  const { dir, git, write } = repo();
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  write("long.txt", `${lines.join("\n")}\n`);
  git("add", ".");
  git("commit", "-q", "-m", "Start");
  const changed = lines.slice();
  changed[1] = "line 2 changed";
  changed[27] = "line 28 changed";
  write("long.txt", `${changed.join("\n")}\n`);

  const diff = await gitFileDiff(dir, "long.txt", false);
  assert.equal(diff.stageable, true);
  assert.equal(diff.hunks.length, 2, "two separate blocks");
  await gitStageHunk(dir, "long.txt", diff.hunks[1].id, false);
  const cached = git("diff", "--cached");
  assert.ok(cached.includes("+line 28 changed") && !cached.includes("+line 2 changed"), "only the second block is staged");
  const status = await gitStatus(dir);
  assert.equal(status.files[0].staged && status.files[0].unstaged, true, "the file is partly staged");

  const stagedDiff = await gitFileDiff(dir, "long.txt", true);
  assert.equal(stagedDiff.hunks.length, 1);
  await gitStageHunk(dir, "long.txt", stagedDiff.hunks[0].id, true);
  assert.equal(git("diff", "--cached"), "", "unstaged again");

  await assert.rejects(gitStageHunk(dir, "long.txt", "000000000000", false), (err: any) => err.status === 409 && /changed since/.test(err.message));

  write("brand-new.txt", "a\nb\n");
  const untracked = await gitFileDiff(dir, "brand-new.txt", false);
  assert.equal(untracked.untracked, true);
  assert.equal(untracked.stageable, false, "a new file goes whole");
  assert.deepEqual(untracked.hunks[0].lines, ["+a", "+b"]);
});

test("commits what's staged, and says why when it can't", async () => {
  const { dir, git, write } = repo();
  write("a.txt", "a\n");
  await assert.rejects(gitCommit(dir, "Nothing yet"), /Nothing is staged/);
  await gitStage(dir, ["a.txt"]);
  await assert.rejects(gitCommit(dir, "   "), /Write a commit message/);
  const c = await gitCommit(dir, "Add a\n\nWith a body; quotes \" and $HOME stay as they are.");
  assert.equal(c.subject, "Add a");
  assert.match(c.hash, /^[0-9a-f]{40}$/);
  assert.equal(git("log", "-1", "--format=%B").trim(), "Add a\n\nWith a body; quotes \" and $HOME stay as they are.");
  assert.equal((await gitStatus(dir)).files.length, 0);

  // A failing pre-commit hook: its own words come back.
  write(".git/hooks/pre-commit", "#!/bin/sh\necho 'lint failed: fix src/app.ts' >&2\nexit 1\n");
  fs.chmodSync(path.join(dir, ".git/hooks/pre-commit"), 0o755);
  write("b.txt", "b\n");
  await gitStage(dir, ["b.txt"]);
  await assert.rejects(gitCommit(dir, "Add b"), /lint failed: fix src\/app\.ts/);
});
