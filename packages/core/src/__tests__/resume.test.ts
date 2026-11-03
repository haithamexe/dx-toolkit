import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-resume-test-"));
const { addJournalEntry } = await import("../tools/journal.js");
const { leaveNote, readSession, rememberSession, resumeInfo } = await import("../tools/sessions.js");
const { findUnsavedWork } = await import("../tools/status.js");
const { readProject } = await import("../tools/projects.js");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe", encoding: "utf8" });

function repo(name: string): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dx-resume-")), name);
  fs.mkdirSync(dir);
  git(dir, "init", "-q");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, scripts: { dev: "node x.js" } }));
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "first");
  return dir;
}

test("remembers the branch, notes and commits since", () => {
  const dir = repo("todo-app");
  rememberSession(dir, "todo-app", { ran: ["web", "api"] });
  assert.equal(readSession(dir)?.branch, "main");
  leaveNote(dir, "todo-app", "Halfway through the checkout form; next: validation", "ai");
  git(dir, "switch", "-qc", "feature/cart");
  fs.writeFileSync(path.join(dir, "cart.js"), "x");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "Add cart");
  fs.writeFileSync(path.join(dir, "wip.js"), "y");
  addJournalEntry("todo-app: started the checkout form");

  const r = resumeInfo({ name: "todo-app", dir });
  assert.equal(r.session?.note, "Halfway through the checkout form; next: validation");
  assert.equal(r.session?.noteBy, "ai");
  assert.deepEqual(r.session?.ran, ["web", "api"]);
  assert.equal(r.branchThen, "main");
  assert.equal(r.branch, "feature/cart");
  assert.equal(r.newCommits, 1);
  assert.equal(r.lastCommit?.subject, "Add cart");
  assert.deepEqual(r.uncommitted, ["wip.js"]);
  assert.equal(r.journal.length, 1);

  leaveNote(dir, "todo-app", "", "you");
  assert.equal(readSession(dir)?.note, undefined);
  assert.deepEqual(readSession(dir)?.ran, ["web", "api"], "removing the note keeps the rest");
});

test("finds work that exists only on this computer", async () => {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), "dx-origin-"));
  git(origin, "init", "-q", "--bare");

  const saved = repo("shop-website");
  git(saved, "remote", "add", "origin", origin);
  git(saved, "push", "-q", "origin", "main");

  const ahead = repo("api-gateway");
  git(ahead, "remote", "add", "origin", origin);
  git(ahead, "fetch", "-q", "origin");
  git(ahead, "push", "-q", "origin", "main:other");
  fs.writeFileSync(path.join(ahead, "a.js"), "1");
  git(ahead, "add", ".");
  git(ahead, "commit", "-qm", "local only");
  git(ahead, "switch", "-qc", "spike");
  fs.writeFileSync(path.join(ahead, "b.js"), "2");
  git(ahead, "add", ".");
  git(ahead, "commit", "-qm", "spike work");
  fs.writeFileSync(path.join(ahead, "notes.txt"), "draft");
  fs.writeFileSync(path.join(ahead, "a.js"), "changed");
  git(ahead, "stash", "push", "-q", "a.js");

  const local = repo("octocat-notes");

  const projects = [saved, ahead, local].map((d) => readProject(d)!);
  const all = await findUnsavedWork({ projects, all: true });
  const by = Object.fromEntries(all.map((w) => [w.project, w]));

  assert.equal(by["shop-website"].unpushed, 0);
  assert.equal(by["shop-website"].noRemote, false);
  // "first" is on the remote (as other); "local only" and "spike work" aren't.
  assert.equal(by["api-gateway"].unpushed, 2);
  assert.deepEqual(by["api-gateway"].unpushedBranches.sort(), ["main", "spike"]);
  assert.equal(by["api-gateway"].stashes, 1);
  assert.equal(by["api-gateway"].untracked, 1);
  assert.equal(by["octocat-notes"].noRemote, true);

  const unsaved = await findUnsavedWork({ projects });
  assert.deepEqual(unsaved.map((w) => w.project).sort(), ["api-gateway", "octocat-notes"]);
});
