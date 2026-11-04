import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-gitops-test-"));
const core = await import("../index.js");
const {
  gitAbort,
  gitCherryPick,
  gitCommitChanges,
  gitConflict,
  gitContinue,
  gitCreateBranch,
  gitCreateTag,
  gitDeleteBranch,
  gitDeleteTag,
  gitDiscard,
  gitFetch,
  gitMerge,
  gitMergePreview,
  gitPull,
  gitPush,
  gitPushTags,
  gitRebase,
  gitRebasePlan,
  gitRebaseRun,
  gitRefs,
  gitRenameBranch,
  gitResetTo,
  gitResolve,
  gitRevert,
  gitStage,
  gitStashApply,
  gitStashDrop,
  gitStashPush,
  gitStatus,
  gitSwitch,
  gitUndo,
  gitUndoList,
} = core;

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-gitops-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "octocat@example.com");
  git("config", "user.name", "octocat");
  git("config", "core.autocrlf", "false");
  git("config", "commit.gpgsign", "false");
  const write = (name: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  };
  const read = (name: string) => fs.readFileSync(path.join(dir, name), "utf8");
  const commit = (name: string, content: string, message: string) => {
    write(name, content);
    git("add", "--", name);
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD").trim();
  };
  const head = () => git("rev-parse", "HEAD").trim();
  const subjects = () => git("log", "--format=%s").trim().split("\n");
  return { dir, git, write, read, commit, head, subjects };
}

async function undoLatest(dir: string) {
  const { entries } = await gitUndoList(dir);
  const latest = entries.find((e) => !e.undone)!;
  return gitUndo(dir, latest.id);
}

test("branches: create, switch, rename, delete, and undo each", async () => {
  const r = repo();
  r.commit("a.txt", "a\n", "Start");
  await gitCreateBranch(r.dir, "feature/login");
  let refs = await gitRefs(r.dir);
  assert.deepEqual(refs.branches.map((b) => b.name).sort(), ["feature/login", "main"]);
  assert.equal(refs.current, "main");

  await gitSwitch(r.dir, "feature/login");
  assert.equal((await gitRefs(r.dir)).current, "feature/login");
  await undoLatest(r.dir);
  assert.equal((await gitRefs(r.dir)).current, "main", "undo switches back");

  await gitRenameBranch(r.dir, "feature/login", "feature/sign-in");
  assert.ok((await gitRefs(r.dir)).branches.some((b) => b.name === "feature/sign-in"));
  await undoLatest(r.dir);
  assert.ok((await gitRefs(r.dir)).branches.some((b) => b.name === "feature/login"), "undo renames back");

  r.git("switch", "-q", "feature/login");
  r.commit("b.txt", "b\n", "Work on login");
  r.git("switch", "-q", "main");
  refs = await gitRefs(r.dir);
  assert.equal(refs.branches.find((b) => b.name === "feature/login")!.merged, false);
  await gitDeleteBranch(r.dir, "feature/login");
  assert.ok(!(await gitRefs(r.dir)).branches.some((b) => b.name === "feature/login"));
  await undoLatest(r.dir);
  const back = (await gitRefs(r.dir)).branches.find((b) => b.name === "feature/login");
  assert.ok(back, "undo brings a deleted branch back, at its commit");
  assert.equal(back.subject, "Work on login");

  await assert.rejects(gitCreateBranch(r.dir, "bad name"), /can't be a branch name/);
  await assert.rejects(gitCreateBranch(r.dir, "--force"), /Give the branch a name|can't be/);
  await assert.rejects(gitCreateBranch(r.dir, "main"), /already a branch/);
  await assert.rejects(gitDeleteBranch(r.dir, "main"), /You're on main/);
  await assert.rejects(gitSwitch(r.dir, "nope"), (e: any) => e.status === 409);
  await assert.rejects(gitUndo(r.dir, "not-the-latest"), (e: any) => e.status === 409);
});

test("switching with changes in the way, and Switch and shelve", async () => {
  const r = repo();
  r.commit("a.txt", "one\n", "Start");
  r.git("switch", "-q", "-c", "other");
  r.commit("a.txt", "other\n", "Other a");
  r.git("switch", "-q", "main");
  r.write("a.txt", "mine\n");
  await assert.rejects(gitSwitch(r.dir, "other"), /would be overwritten.*shelf/);
  await gitSwitch(r.dir, "other", { shelve: true });
  assert.equal((await gitRefs(r.dir)).current, "other");
  assert.equal(r.read("a.txt"), "other\n");
  const shelf = (await gitRefs(r.dir)).stashes;
  assert.equal(shelf.length, 1);
  assert.match(shelf[0].message, /before switching to other/);
});

test("tags: create (plain and annotated) and delete, with undo", async () => {
  const r = repo();
  const first = r.commit("a.txt", "a\n", "Start");
  r.commit("a.txt", "b\n", "Second");
  await gitCreateTag(r.dir, "v1.0.0", { at: first, message: "The first release" });
  await gitCreateTag(r.dir, "nightly");
  let tags = (await gitRefs(r.dir)).tags;
  assert.equal(tags.find((t) => t.name === "v1.0.0")!.commit, first);
  assert.equal(tags.find((t) => t.name === "v1.0.0")!.annotated, true);
  assert.equal(tags.find((t) => t.name === "nightly")!.commit, r.head());
  await gitDeleteTag(r.dir, "v1.0.0");
  assert.ok(!(await gitRefs(r.dir)).tags.some((t) => t.name === "v1.0.0"));
  await undoLatest(r.dir);
  tags = (await gitRefs(r.dir)).tags;
  assert.equal(tags.find((t) => t.name === "v1.0.0")?.annotated, true, "the annotated tag comes back as it was");
  assert.equal(r.git("tag", "-l", "--format=%(contents:subject)", "v1.0.0").trim(), "The first release");
  await assert.rejects(gitCreateTag(r.dir, "has space"), /can't be a tag name/);
});

test("revert and cherry-pick, each undone", async () => {
  const r = repo();
  r.commit("a.txt", "1\n", "Start");
  const bug = r.commit("a.txt", "1\nbug\n", "Add a bug");
  const res = await gitRevert(r.dir, bug.slice(0, 7));
  assert.equal(res.ok, true);
  assert.equal(r.read("a.txt"), "1\n");
  assert.match(r.subjects()[0], /^Revert "Add a bug"/);
  await undoLatest(r.dir);
  assert.equal(r.head(), bug, "undo takes the revert commit away");
  assert.equal(r.read("a.txt"), "1\nbug\n");

  r.git("switch", "-q", "-c", "fix");
  const fix = r.commit("b.txt", "fixed\n", "Fix it");
  r.git("switch", "-q", "main");
  await gitCherryPick(r.dir, fix);
  assert.equal(r.subjects()[0], "Fix it");
  assert.equal(r.read("b.txt"), "fixed\n");
  await assert.rejects(gitCherryPick(r.dir, fix), /already on this branch/);
  await assert.rejects(gitRevert(r.dir, "HEAD~1"), /Give its hash/, "only hashes, not revisions");
});

test("merge preview, merge, squash, fast-forward and rebase, each undone", async () => {
  const r = repo();
  r.commit("a.txt", "a\n", "Start");
  r.git("switch", "-q", "-c", "feature");
  r.commit("f.txt", "f\n", "Feature one");
  r.commit("f.txt", "f\nf2\n", "Feature two");
  r.git("switch", "-q", "main");

  let p = await gitMergePreview(r.dir, "feature");
  assert.equal(p.incomingCount, 2);
  assert.equal(p.outgoingCount, 0);
  assert.equal(p.fastForward, true);
  assert.deepEqual(p.conflicts, []);
  const start = r.head();
  await gitMerge(r.dir, "feature", "fast-forward");
  assert.equal(r.subjects()[0], "Feature two");
  await undoLatest(r.dir);
  assert.equal(r.head(), start);

  r.commit("a.txt", "a\nmain\n", "Main moves on");
  const mainTip = r.head();
  p = await gitMergePreview(r.dir, "feature");
  assert.equal(p.fastForward, false);
  assert.equal(p.outgoingCount, 1);
  await assert.rejects(gitMerge(r.dir, "feature", "fast-forward"), /both have new commits/);
  await gitMerge(r.dir, "feature", "merge");
  assert.equal(r.git("log", "-1", "--format=%P").trim().split(" ").length, 2, "a merge commit");
  await undoLatest(r.dir);
  assert.equal(r.head(), mainTip);

  await gitMerge(r.dir, "feature", "squash");
  assert.equal(r.git("log", "-1", "--format=%P").trim().split(" ").length, 1, "one ordinary commit");
  assert.equal(r.read("f.txt"), "f\nf2\n");
  await undoLatest(r.dir);
  assert.equal(r.head(), mainTip);

  r.git("switch", "-q", "feature");
  await gitRebase(r.dir, "main");
  assert.deepEqual(r.subjects().slice(0, 3), ["Feature two", "Feature one", "Main moves on"]);
  await undoLatest(r.dir);
  assert.deepEqual(r.subjects().slice(0, 3), ["Feature two", "Feature one", "Start"]);
  await assert.rejects(gitMerge(r.dir, "feature"), /the branch you're on/);
  await assert.rejects(gitMergePreview(r.dir, "nope"), (e: any) => e.status === 409);
});

test("a merge conflict: preview names the file, then Mine/Theirs/Both per block, Continue, or Abort", async () => {
  const r = repo();
  r.commit("menu.txt", "soup\nbread\ncake\n", "Menu");
  r.git("switch", "-q", "-c", "theirs");
  r.commit("menu.txt", "soup\nrye bread\ncake\n", "Rye");
  r.git("switch", "-q", "main");
  r.commit("menu.txt", "soup\ngarlic bread\ncake\n", "Garlic");

  const p = await gitMergePreview(r.dir, "theirs");
  assert.deepEqual(p.conflicts, ["menu.txt"]);
  const res = await gitMerge(r.dir, "theirs");
  assert.equal(res.conflicts, true);
  const status = await gitStatus(r.dir);
  assert.equal(status.operation, "merge");
  assert.ok(status.files.find((f) => f.path === "menu.txt")!.conflicted);
  await assert.rejects(gitContinue(r.dir), /still have conflicts/);

  const c = await gitConflict(r.dir, "menu.txt");
  const blocks = c.parts.filter((x) => x.kind === "conflict") as any[];
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].ours, ["garlic bread"]);
  assert.deepEqual(blocks[0].theirs, ["rye bread"]);
  assert.equal(blocks[0].oursLabel, "HEAD");
  await assert.rejects(gitResolve(r.dir, "menu.txt", { hash: "stale", choices: ["both"] }), (e: any) => e.status === 409);
  await gitResolve(r.dir, "menu.txt", { hash: c.hash, choices: ["both"] });
  assert.equal(r.read("menu.txt"), "soup\ngarlic bread\nrye bread\ncake\n");
  const done = await gitContinue(r.dir);
  assert.equal(done.ok, true);
  assert.equal((await gitStatus(r.dir)).operation, undefined);
  assert.equal(r.git("log", "-1", "--format=%P").trim().split(" ").length, 2);

  // Again, then abort: back to where it was.
  r.git("reset", "-q", "--hard", "HEAD~1");
  const before = r.head();
  await gitMerge(r.dir, "theirs");
  await gitAbort(r.dir);
  assert.equal(r.head(), before);
  assert.equal(r.read("menu.txt"), "soup\ngarlic bread\ncake\n");
  await gitMerge(r.dir, "theirs");
  await gitResolve(r.dir, "menu.txt", { side: "theirs" });
  assert.equal(r.read("menu.txt"), "soup\nrye bread\ncake\n");
});

test("the merge editor: a block's result written by hand, only the conflict blocks replaced, in the file's own line endings", async () => {
  const r = repo();
  r.git("config", "merge.conflictStyle", "diff3");
  // Far enough apart that git keeps them as two blocks.
  const middle = "cake\npie\nfruit\njam\nscones\n";
  r.commit("menu.txt", `soup\nbread\n${middle}tea\n`, "Menu");
  r.git("switch", "-q", "-c", "theirs");
  r.commit("menu.txt", `soup\nrye bread\n${middle}green tea\n`, "Rye");
  r.git("switch", "-q", "main");
  r.commit("menu.txt", `soup\ngarlic bread\n${middle}mint tea\n`, "Garlic");
  await gitMerge(r.dir, "theirs");
  // Two blocks, with the base (diff3) between them: one written by hand, one a side.
  let c = await gitConflict(r.dir, "menu.txt");
  let blocks = c.parts.filter((x) => x.kind === "conflict") as any[];
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].base, ["bread"], "the base is read for reference");

  const resolve = (choices: any[], hash = c.hash) => gitResolve(r.dir, "menu.txt", { hash, choices });
  await assert.rejects(resolve([{ text: "garlic rye bread\n" }]), /each of the 2 conflicts/, "one per block");
  await assert.rejects(resolve([{ text: "<<<<<<< HEAD\ngarlic\n" }, "ours"]), /conflict marker/);
  await assert.rejects(resolve(["ours", { text: "a\n=======\nb" }]), /Conflict 2's text still has a conflict marker/);
  await assert.rejects(resolve([{ text: "x".repeat(512 * 1024 + 1) }, "ours"]), (e: any) => e.status === 413);
  await assert.rejects(resolve([{ nope: 1 }, "ours"]), /each of the 2 conflicts/);
  await assert.rejects(resolve([{ text: "x" }, "ours"], "stale"), (e: any) => e.status === 409);
  assert.match(r.read("menu.txt"), /<<<<<<< HEAD/, "nothing written on a refusal");
  // ======== (eight) is a markdown underline, not a marker.
  const done = await resolve([{ text: "garlic rye bread\n========\n" }, "theirs"]);
  assert.match(done.message, /one block as you wrote it/);
  assert.equal(r.read("menu.txt"), `soup\ngarlic rye bread\n========\n${middle}green tea\n`, "the text around the blocks is the file's own");
  assert.ok(!(await gitStatus(r.dir)).files.find((f) => f.path === "menu.txt")!.conflicted, "staged");

  // A CRLF file: what's written in the textarea (LF) comes out CRLF; an empty result removes the block.
  const w = repo();
  w.commit("menu.txt", "soup\r\nbread\r\ncake\r\n", "Menu");
  w.git("switch", "-q", "-c", "theirs");
  w.commit("menu.txt", "soup\r\nrye bread\r\ncake\r\n", "Rye");
  w.git("switch", "-q", "main");
  w.commit("menu.txt", "soup\r\ngarlic bread\r\ncake\r\n", "Garlic");
  await gitMerge(w.dir, "theirs");
  let cw = await gitConflict(w.dir, "menu.txt");
  assert.equal(cw.parts.filter((x) => x.kind === "conflict").length, 1);
  await gitResolve(w.dir, "menu.txt", { hash: cw.hash, choices: [{ text: "garlic bread\nrye bread" }] });
  assert.equal(w.read("menu.txt"), "soup\r\ngarlic bread\r\nrye bread\r\ncake\r\n");
  w.git("merge", "--abort");
  await gitMerge(w.dir, "theirs");
  cw = await gitConflict(w.dir, "menu.txt");
  await gitResolve(w.dir, "menu.txt", { hash: cw.hash, choices: [{ text: "" }] });
  assert.equal(w.read("menu.txt"), "soup\r\ncake\r\n");
});

test("the shelf: put changes on it, take them off, throw them away, undo each", async () => {
  const r = repo();
  r.commit("a.txt", "a\n", "Start");
  r.write("a.txt", "changed\n");
  r.write("new.txt", "new file\n");
  await gitStashPush(r.dir, { paths: ["new.txt"] });
  assert.equal(fs.existsSync(path.join(r.dir, "new.txt")), false, "new files go on the shelf too");
  assert.equal(r.read("a.txt"), "changed\n", "only the file asked for");
  await undoLatest(r.dir);
  assert.equal(r.read("new.txt"), "new file\n", "undo takes it back off");
  assert.equal((await gitRefs(r.dir)).stashes.length, 0);

  await gitStashPush(r.dir, { message: "half-done menu" });
  let shelf = (await gitRefs(r.dir)).stashes;
  assert.equal(shelf[0].message, "On main: half-done menu");
  assert.equal((await gitStatus(r.dir)).files.length, 0);
  await gitStashApply(r.dir, shelf[0].oid);
  assert.equal(r.read("a.txt"), "changed\n");
  assert.equal((await gitRefs(r.dir)).stashes.length, 1, "apply keeps a copy");
  r.git("checkout", "-q", "--", "a.txt");
  fs.rmSync(path.join(r.dir, "new.txt"));
  await gitStashApply(r.dir, shelf[0].oid, { pop: true });
  assert.equal((await gitRefs(r.dir)).stashes.length, 0);
  await gitStashPush(r.dir);
  shelf = (await gitRefs(r.dir)).stashes;
  await gitStashDrop(r.dir, shelf[0].oid);
  assert.equal((await gitRefs(r.dir)).stashes.length, 0);
  await undoLatest(r.dir);
  assert.equal((await gitRefs(r.dir)).stashes[0]?.oid, shelf[0].oid, "undo puts a thrown-away shelf item back");
  await assert.rejects(gitStashDrop(r.dir, "0".repeat(40)), (e: any) => e.status === 409);
});

test("discard keeps a copy, and Undo brings the changes back", async () => {
  const r = repo();
  r.commit("a.txt", "a\n", "Start");
  r.commit("gone.txt", "keep me\n", "Gone");
  r.write("a.txt", "my edit\n");
  r.write("scratch.txt", "notes\n");
  fs.rmSync(path.join(r.dir, "gone.txt"));
  await gitDiscard(r.dir, ["a.txt", "scratch.txt", "gone.txt"]);
  assert.equal(r.read("a.txt"), "a\n");
  assert.equal(fs.existsSync(path.join(r.dir, "scratch.txt")), false);
  assert.equal(r.read("gone.txt"), "keep me\n");
  assert.equal((await gitStatus(r.dir)).files.length, 0);
  await undoLatest(r.dir);
  assert.equal(r.read("a.txt"), "my edit\n");
  assert.equal(r.read("scratch.txt"), "notes\n");
  assert.equal(fs.existsSync(path.join(r.dir, "gone.txt")), false, "the deletion is back too");
  await assert.rejects(gitDiscard(r.dir, ["../elsewhere.txt"]), (e: any) => e.status === 409);
});

test("commit and amend through the journal: undo keeps the changes staged", async () => {
  const r = repo();
  const first = r.commit("a.txt", "a\n", "Start");
  r.write("a.txt", "b\n");
  await gitStage(r.dir, ["a.txt"]);
  await gitCommitChanges(r.dir, "Change a");
  r.write("c.txt", "c\n");
  await gitStage(r.dir, ["c.txt"]);
  await gitCommitChanges(r.dir, "Change a, and add c", { amend: true });
  assert.deepEqual(r.subjects(), ["Change a, and add c", "Start"]);
  await undoLatest(r.dir);
  assert.deepEqual(r.subjects(), ["Change a", "Start"], "the amend is undone");
  assert.ok((await gitStatus(r.dir)).files.find((f) => f.path === "c.txt")!.staged, "and what it added is staged again");
  await undoLatest(r.dir);
  assert.equal(r.head(), first);
  assert.ok((await gitStatus(r.dir)).files.find((f) => f.path === "a.txt")!.staged);
});

test("edit history: reorder, reword, squash, fixup and drop; then undo", async () => {
  const r = repo();
  r.commit("a.txt", "base\n", "Base");
  const one = r.commit("one.txt", "1\n", "One");
  const two = r.commit("two.txt", "2\n", "Two");
  const three = r.commit("three.txt", "3\n", "Three");
  const four = r.commit("four.txt", "4\n", "Four");
  const before = r.head();

  const plan = await gitRebasePlan(r.dir, one);
  assert.deepEqual(plan.commits.map((c) => c.subject), ["One", "Two", "Three", "Four"]);
  await assert.rejects(gitRebaseRun(r.dir, one, [{ hash: one, action: "squash" }, { hash: two, action: "pick" }, { hash: three, action: "pick" }, { hash: four, action: "pick" }]), /can't be squashed/);
  await assert.rejects(gitRebaseRun(r.dir, one, [{ hash: one, action: "pick" }]), (e: any) => e.status === 409);

  await gitRebaseRun(r.dir, one, [
    { hash: two, action: "reword", message: "Two, reworded" },
    { hash: one, action: "pick" },
    { hash: three, action: "fixup" },
    { hash: four, action: "drop" },
  ]);
  assert.deepEqual(r.subjects(), ["One", "Two, reworded", "Base"]);
  assert.equal(fs.existsSync(path.join(r.dir, "four.txt")), false, "dropped");
  assert.ok(r.git("show", "--name-only", "--format=", "HEAD").includes("three.txt"), "Three was folded into One");
  await undoLatest(r.dir);
  assert.equal(r.head(), before);

  await gitRebaseRun(r.dir, two, [
    { hash: two, action: "pick" },
    { hash: three, action: "squash" },
    { hash: four, action: "pick" },
  ]);
  assert.deepEqual(r.subjects(), ["Four", "Two", "One", "Base"]);
  assert.match(r.git("log", "-1", "--skip=1", "--format=%B"), /Two[\s\S]*Three/, "a squash keeps both messages");

  r.write("dirty.txt", "x");
  r.git("add", "dirty.txt");
  await assert.rejects(gitRebaseRun(r.dir, one, []), /before editing history/);
});

test("go back to a commit, keeping uncommitted changes, and undo it", async () => {
  const r = repo();
  const first = r.commit("a.txt", "a\n", "Start");
  const second = r.commit("b.txt", "b\n", "Second");
  r.write("c.txt", "untracked work\n");
  await gitResetTo(r.dir, first);
  assert.equal(r.head(), first);
  assert.equal(r.read("c.txt"), "untracked work\n");
  await undoLatest(r.dir);
  assert.equal(r.head(), second);
  // An undo that would throw newer work away is refused.
  await gitResetTo(r.dir, first);
  r.commit("d.txt", "d\n", "Newer");
  await assert.rejects(undoLatest(r.dir), /Only the latest|moved since/);
});

test("fetch, pull and push against a remote, with --force-with-lease only", async () => {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "dx-gitops-remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: remote });
  const a = repo();
  a.commit("a.txt", "a\n", "Start");
  await assert.rejects(gitPush(a.dir), /no remote/);
  a.git("remote", "add", "origin", remote);
  await gitPush(a.dir);
  let refs = await gitRefs(a.dir);
  assert.equal(refs.branches.find((b) => b.current)!.upstream, "origin/main", "the first push sets the upstream");

  const b = repo();
  b.git("remote", "add", "origin", remote);
  b.git("fetch", "-q", "origin");
  b.git("reset", "-q", "--hard", "origin/main");
  b.git("branch", "-q", "--set-upstream-to=origin/main");
  b.commit("b.txt", "b\n", "From b");
  b.git("push", "-q");

  await gitFetch(a.dir);
  refs = await gitRefs(a.dir);
  assert.equal(refs.branches.find((x) => x.current)!.behind, 1);
  await gitPull(a.dir);
  assert.equal(a.subjects()[0], "From b");

  a.commit("a.txt", "a2\n", "A again");
  b.commit("b.txt", "b2\n", "B again");
  b.git("push", "-q");
  await assert.rejects(gitPush(a.dir), /Pull first/);
  await gitFetch(a.dir);
  await assert.rejects(gitPull(a.dir), /both have new commits/);
  await gitPush(a.dir, { force: true });
  assert.equal(execFileSync("git", ["log", "-1", "--format=%s", "main"], { cwd: remote, encoding: "utf8" }).trim(), "A again");
  const entries = (await gitUndoList(a.dir)).entries;
  assert.match(entries[0].label, /Pushed main \(forced, with lease\)/);
  assert.equal(entries[0].undo, undefined);

  // Tags: one, then all; a tag the remote has on another commit isn't moved.
  const remoteTags = () => execFileSync("git", ["tag", "-l"], { cwd: remote, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  await gitCreateTag(a.dir, "v1.0.0", { message: "First" });
  await gitCreateTag(a.dir, "nightly");
  await gitPushTags(a.dir, { name: "v1.0.0" });
  assert.deepEqual(remoteTags(), ["v1.0.0"]);
  await gitPushTags(a.dir, { all: true });
  assert.deepEqual(remoteTags().sort(), ["nightly", "v1.0.0"]);
  await assert.rejects(gitPushTags(a.dir, { name: "nope" }), (e: any) => e.status === 409);
  b.git("fetch", "-q", "origin");
  b.git("tag", "beta");
  b.git("push", "-q", "origin", "refs/tags/beta");
  a.commit("c.txt", "c\n", "Later");
  await gitCreateTag(a.dir, "beta");
  await assert.rejects(gitPushTags(a.dir, { name: "beta" }), /already has a tag called beta/);
});
