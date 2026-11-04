import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-snap-home-"));
const { commitAt, createSnapshot, listSnapshots, removeSnapshot, searchCommits, snapshotByDir, snapshotProject, snapshotsRoot, resolveCommit, GitError } = await import("../index.js");

function repo(name = "shop-website") {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dx-snap-")), name);
  fs.mkdirSync(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "octocat@example.com");
  git("config", "user.name", "octocat");
  git("config", "core.autocrlf", "false");
  git("config", "commit.gpgsign", "false");
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };
  const commit = (message: string, author?: string) => {
    git("add", "-A");
    if (author) git("-c", `user.name=${author}`, "-c", `user.email=${author}@example.com`, "commit", "-q", "-m", message);
    else git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  return { dir, git, write, commit };
}

const pkg = (version: string) => JSON.stringify({ name: "shop-website", version, scripts: { dev: "node server.cjs" } }, null, 2);
const lock = (version: string) => JSON.stringify({ name: "shop-website", version, lockfileVersion: 3, packages: {} }, null, 2);

test("finds commits by message, hash prefix, author and a file they changed", async () => {
  const { dir, write, commit } = repo();
  write("README.md", "# shop\n");
  const first = commit("Start the shop");
  write("src/cart.js", "export const cart = [];\n");
  const cart = commit("Add the Cart page", "mona");
  write("src/checkout.js", "export {};\n");
  commit("Checkout flow");

  const byMessage = await searchCommits(dir, "cart page");
  assert.deepEqual(byMessage.map((c) => c.hash), [cart], "case doesn't matter");
  assert.ok(byMessage[0].matched.includes("message"));

  const byHash = await searchCommits(dir, first.slice(0, 7));
  assert.equal(byHash[0].hash, first);
  assert.equal(byHash[0].matched[0], "hash");

  const byAuthor = await searchCommits(dir, "MONA");
  assert.deepEqual(byAuthor.map((c) => c.hash), [cart]);
  assert.ok(byAuthor[0].matched.includes("author"));

  const byFile = await searchCommits(dir, "checkout.js");
  assert.equal(byFile.length, 1);
  assert.deepEqual(byFile[0].files, ["src/checkout.js"]);
  assert.ok(byFile[0].matched.includes("file"));

  assert.deepEqual(await searchCommits(dir, ".*"), [], "words, not patterns");
  assert.deepEqual(await searchCommits(dir, "  "), []);
  const all = await searchCommits(dir, "src/");
  assert.equal(all.length, 2, "newest first");
  assert.ok(all[0].at >= all[1].at);
});

test("a commit must be a hash that resolves", async () => {
  const { dir, write, commit } = repo();
  write("a.txt", "a\n");
  commit("One");
  await assert.rejects(resolveCommit(dir, "--all"), (e: Error) => e instanceof GitError && (e as InstanceType<typeof GitError>).status === 400);
  await assert.rejects(resolveCommit(dir, "HEAD"), GitError);
  await assert.rejects(resolveCommit(dir, "deadbeef"), (e: Error) => (e as InstanceType<typeof GitError>).status === 404);
});

test("a snapshot links node_modules when the lock file matches, runs as name@short, and removing it leaves the project's node_modules alone", async () => {
  const { dir, git, write, commit } = repo();
  write("package.json", pkg("1.0.0"));
  write("package-lock.json", lock("1.0.0"));
  write(".gitignore", "node_modules\n.env\n");
  write("server.cjs", "console.log('v1');\n");
  const v1 = commit("Version one");
  write("server.cjs", "console.log('v2');\n");
  commit("Version two");
  // The project's own installed packages and secrets, which aren't in git.
  write("node_modules/left-pad/index.js", "module.exports = 1;\n");
  write(".env", "API_KEY=local\n");
  const before = git("status", "--porcelain");

  let installs = 0;
  const snap = await createSnapshot({ name: "shop-website", dir }, v1.slice(0, 7), { runInstall: async () => (installs++, { ok: true, output: "" }) });
  assert.equal(snap.name, `shop-website@${v1.slice(0, 7)}`);
  assert.equal(snap.hash, v1);
  assert.ok(snap.path.startsWith(snapshotsRoot()), "under ~/.dx/snapshots");
  assert.equal(snap.packages, "linked");
  assert.equal(installs, 0, "nothing installed: the lock file is the same");
  assert.equal(fs.readFileSync(path.join(snap.dir, "server.cjs"), "utf8"), "console.log('v1');\n", "the files as they were then");
  assert.ok(fs.lstatSync(path.join(snap.dir, "node_modules")).isSymbolicLink(), "a link, not a copy");
  assert.ok(fs.existsSync(path.join(snap.dir, "node_modules", "left-pad", "index.js")));
  assert.equal(fs.readFileSync(path.join(snap.dir, ".env"), "utf8"), "API_KEY=local\n", ".env copied in");
  assert.deepEqual(snap.envFiles, [".env"]);
  assert.equal(git("status", "--porcelain"), before, "the working copy isn't touched");
  assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "main", "nor the branch");

  assert.equal(snapshotByDir(snap.dir)?.id, snap.id, "registered");
  assert.equal(snapshotByDir(dir), undefined, "the project itself isn't a snapshot");
  assert.equal(snapshotProject(snap)?.name, snap.name);
  assert.equal(snapshotProject(snap)?.devCommand, "npm run dev");

  const again = await createSnapshot({ name: "shop-website", dir }, v1);
  assert.equal(again.createdAt, snap.createdAt, "reused when it's already there");

  await removeSnapshot(snap.id);
  assert.equal(fs.existsSync(snap.path), false, "the snapshot's folder is gone");
  assert.ok(fs.existsSync(path.join(dir, "node_modules", "left-pad", "index.js")), "the project's own node_modules is untouched");
  assert.ok(fs.existsSync(path.join(dir, ".env")));
  assert.equal(listSnapshots().length, 0);
  assert.equal(snapshotByDir(snap.dir), undefined, "not known any more");
  assert.ok(!git("worktree", "list").includes(snap.id), "git forgot the worktree");
  await assert.rejects(removeSnapshot(snap.id), (e: Error) => (e as InstanceType<typeof GitError>).status === 404);
});

test("a snapshot installs its packages when the lock file changed since, and one whose folder is gone drops out of the list", async () => {
  const { dir, write, commit } = repo();
  write("package.json", pkg("1.0.0"));
  write("package-lock.json", lock("1.0.0"));
  write(".gitignore", "node_modules\n");
  const v1 = commit("Old lock");
  write("package-lock.json", lock("2.0.0"));
  commit("New lock");
  write("node_modules/x/index.js", "1\n");

  const ran: string[] = [];
  const snap = await createSnapshot({ name: "shop-website", dir }, v1, {
    runInstall: async (cmd) => {
      ran.push(`${cmd.command} ${cmd.args.join(" ")}`);
      assert.ok(cmd.cwd.startsWith(snapshotsRoot()), "inside the snapshot");
      return { ok: true, output: "" };
    },
  });
  assert.equal(snap.packages, "installed");
  assert.deepEqual(ran, ["npm ci"], "exactly as locked at that commit");
  assert.equal(fs.existsSync(path.join(snap.dir, "node_modules")), false, "nothing linked");

  fs.rmSync(snap.path, { recursive: true, force: true });
  assert.equal(listSnapshots().length, 0, "pruned");
});

test("commitAt says which commit HEAD was on at a moment, from the reflog", async () => {
  const { dir, git, write, commit } = repo();
  write("a.txt", "1\n");
  const one = commit("One");
  write("a.txt", "2\n");
  const two = commit("Two");
  // Back on One for a while (a checkout), as the reflog records it.
  git("checkout", "-q", one);
  const now = Date.now();
  const at = await commitAt(dir, now + 1000);
  assert.equal(at?.hash, one, "the checkout is the newest move");
  assert.equal(at?.from, "reflog");
  assert.ok(at?.since && at.since <= now + 1000);
  git("checkout", "-q", "main");
  assert.equal((await commitAt(dir, Date.now() + 2000))?.hash, two);
  assert.equal(await commitAt(dir, Date.parse("2001-01-01")), undefined, "before the first commit");
  await assert.rejects(commitAt(dir, Number.NaN), GitError);
});
