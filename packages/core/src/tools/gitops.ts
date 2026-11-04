import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dxPath } from "../config.js";
import { GitError, gitCommit, gitFailure, gitOperation, gitRoot, gitRun, gitStatusAt, type GitOperation, type GitResult, type GitStatus } from "./git.js";

/**
 * The git operations behind the Git page's drag and drop: branches, tags, revert, cherry-pick,
 * merge and rebase (with a preview), the stash shelf, fetch/pull/push, discard, amend, conflicts,
 * editing history, and undo.
 *
 * Nothing from a request reaches git unchecked: names of branches, tags and stashes must be in a
 * fresh listing (or pass `check-ref-format` for a new one), commits must resolve to a commit, and
 * paths must be in a fresh `git status`. Every change is written to an undo journal first, with
 * what it takes to go back; undoing reads only the journal, never the request.
 */

// ------------------------------------------------------------------ refs

export interface GitBranch {
  name: string;
  oid: string;
  subject: string;
  /** Commit time, ms. */
  at: number;
  current: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  /** Its upstream was deleted on the remote. */
  gone: boolean;
  /** Everything on it is already in the branch you're on. */
  merged: boolean;
}

export interface GitRemoteBranch {
  name: string;
  remote: string;
  branch: string;
  oid: string;
  subject: string;
  at: number;
}

export interface GitTag {
  name: string;
  /** The commit it points at. */
  commit: string;
  annotated: boolean;
  at: number;
}

export interface GitStash {
  index: number;
  oid: string;
  message: string;
  at: number;
}

export interface GitRefs {
  current?: string;
  head?: string;
  remotes: string[];
  branches: GitBranch[];
  remoteBranches: GitRemoteBranch[];
  tags: GitTag[];
  stashes: GitStash[];
}

const SEP = "\x1f";

async function revParse(root: string, rev: string): Promise<string | undefined> {
  const r = await gitRun(root, ["rev-parse", "-q", "--verify", `${rev}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

export async function gitRefs(dir: string): Promise<GitRefs> {
  return refsAt(await gitRoot(dir));
}

async function refsAt(root: string): Promise<GitRefs> {
  const format = ["%(refname)", "%(objectname)", "%(upstream:short)", "%(upstream:track,nobracket)", "%(committerdate:unix)", "%(contents:subject)", "%(*objectname)", "%(objecttype)", "%(*committerdate:unix)", "%(creatordate:unix)"].join("%1f");
  const [refs, current, head, remotes, stashes] = await Promise.all([
    gitRun(root, ["for-each-ref", `--format=${format}`, "refs/heads", "refs/remotes", "refs/tags"]),
    gitRun(root, ["symbolic-ref", "--short", "-q", "HEAD"]),
    gitRun(root, ["rev-parse", "-q", "--verify", "HEAD"]),
    gitRun(root, ["remote"]),
    gitRun(root, ["stash", "list", "--format=%H%x1f%ct%x1f%gs"]),
  ]);
  const hasHead = head.code === 0;
  const merged = new Set(
    hasHead ? (await gitRun(root, ["for-each-ref", "--merged=HEAD", "--format=%(refname:short)", "refs/heads"])).stdout.split(/\r?\n/).filter(Boolean) : [],
  );
  const out: GitRefs = {
    current: current.code === 0 ? current.stdout.trim() : undefined,
    head: hasHead ? head.stdout.trim() : undefined,
    remotes: remotes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    branches: [],
    remoteBranches: [],
    tags: [],
    stashes: [],
  };
  for (const line of refs.stdout.split(/\r?\n/).filter(Boolean)) {
    const [ref, oid, upstream, track, at, subject, peeled, type, peeledAt, createdAt] = line.split(SEP);
    if (ref.startsWith("refs/heads/")) {
      const name = ref.slice(11);
      const ahead = /ahead (\d+)/.exec(track ?? "");
      const behind = /behind (\d+)/.exec(track ?? "");
      out.branches.push({
        name,
        oid,
        subject: subject ?? "",
        at: Number(at) * 1000,
        current: name === out.current,
        upstream: upstream || undefined,
        ahead: ahead ? Number(ahead[1]) : 0,
        behind: behind ? Number(behind[1]) : 0,
        gone: track === "gone",
        merged: merged.has(name),
      });
    } else if (ref.startsWith("refs/remotes/")) {
      const name = ref.slice(13);
      if (name.endsWith("/HEAD")) continue;
      const remote = out.remotes.find((r) => name.startsWith(`${r}/`)) ?? name.split("/")[0];
      out.remoteBranches.push({ name, remote, branch: name.slice(remote.length + 1), oid, subject: subject ?? "", at: Number(at) * 1000 });
    } else if (ref.startsWith("refs/tags/")) {
      const annotated = type === "tag";
      out.tags.push({ name: ref.slice(10), commit: annotated ? peeled : oid, annotated, at: Number(annotated ? peeledAt || createdAt : at) * 1000 });
    }
  }
  out.stashes = stashes.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      const [oid, at, message] = line.split(SEP);
      return { index, oid, at: Number(at) * 1000, message: message ?? "" };
    });
  out.tags.sort((a, b) => b.at - a.at);
  return out;
}

async function newRefName(root: string, name: unknown, kind: "branch" | "tag"): Promise<string> {
  if (typeof name !== "string" || !name.trim() || name.length > 200 || name.startsWith("-")) throw new GitError(`Give the ${kind} a name.`);
  const n = name.trim();
  const r = kind === "branch" ? await gitRun(root, ["check-ref-format", "--branch", n]) : await gitRun(root, ["check-ref-format", `refs/tags/${n}`]);
  if (r.code !== 0) throw new GitError(`"${n}" can't be a ${kind} name: no spaces, "..", "~", "^", ":", "?", "*", "[" or "\\", and it can't end in "/" or ".lock".`);
  return n;
}

function knownBranch(refs: GitRefs, name: unknown): GitBranch {
  const b = typeof name === "string" ? refs.branches.find((x) => x.name === name) : undefined;
  if (!b) throw new GitError(`There's no branch called ${typeof name === "string" ? name : "that"} any more. Refresh the page.`, 409);
  return b;
}

/** A branch to merge or rebase onto: a local or remote branch from a fresh listing. Returns the full ref. */
function knownTarget(refs: GitRefs, name: unknown): { ref: string; label: string; arg: string } {
  if (typeof name !== "string") throw new GitError("Which branch?");
  // git is given the short name (it appears in conflict markers and messages) unless a tag or
  // another branch shares it, when only the full ref is unambiguous.
  const clash = refs.tags.some((t) => t.name === name) || (refs.branches.some((b) => b.name === name) && refs.remoteBranches.some((b) => b.name === name));
  if (refs.branches.some((b) => b.name === name)) return { ref: `refs/heads/${name}`, label: name, arg: clash ? `refs/heads/${name}` : name };
  if (refs.remoteBranches.some((b) => b.name === name)) return { ref: `refs/remotes/${name}`, label: name, arg: clash ? `refs/remotes/${name}` : name };
  throw new GitError(`There's no branch called ${name} any more. Refresh the page.`, 409);
}

async function knownCommit(root: string, hash: unknown): Promise<{ oid: string; parents: string[]; subject: string }> {
  if (typeof hash !== "string" || !/^[0-9a-f]{4,40}$/i.test(hash)) throw new GitError("Which commit? Give its hash.");
  const oid = await revParse(root, hash);
  if (!oid) throw new GitError("That commit isn't in this repository.", 404);
  const r = await gitRun(root, ["log", "-1", "--format=%P%x1f%s", oid]);
  const [parents, subject] = r.stdout.trim().split(SEP);
  return { oid, parents: parents ? parents.split(" ").filter(Boolean) : [], subject: subject ?? "" };
}

async function isAncestor(root: string, a: string, b: string): Promise<boolean> {
  return (await gitRun(root, ["merge-base", "--is-ancestor", a, b])).code === 0;
}

// ------------------------------------------------------------------ the undo journal

export type UndoStep =
  /** Move the branch (or HEAD) from `from` back to `to`: soft keeps the changes staged (a commit), keep restores the files (a merge). */
  | { kind: "reset"; from: string; to: string; mode: "soft" | "keep" }
  | { kind: "branch-restore"; name: string; oid: string }
  | { kind: "branch-delete"; name: string; oid: string }
  | { kind: "branch-rename"; from: string; to: string }
  | { kind: "switch"; to: string; detached: boolean }
  | { kind: "tag-restore"; name: string; oid: string }
  | { kind: "tag-delete"; name: string; oid: string }
  | { kind: "stash-restore"; oid: string; message: string }
  | { kind: "stash-pop"; oid: string }
  | { kind: "files"; files: { path: string; blob: string | null }[] };

export interface UndoEntry {
  id: string;
  at: number;
  action: string;
  label: string;
  undo?: UndoStep;
  /** Why it can't be undone, when it can't (a push, say). */
  note?: string;
  undone?: boolean;
}

const JOURNAL_MAX = 50;

function journalFile(root: string): string {
  const key = crypto.createHash("sha1").update(path.resolve(root).toLowerCase()).digest("hex").slice(0, 12);
  return dxPath("git-undo", `${path.basename(root).replace(/[^\w.-]/g, "_")}-${key}.json`);
}

function readUndoJournal(root: string): UndoEntry[] {
  try {
    const list = JSON.parse(fs.readFileSync(journalFile(root), "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeJournal(root: string, list: UndoEntry[]): void {
  const file = journalFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list.slice(-JOURNAL_MAX)), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function journal(root: string, action: string, label: string, undo?: UndoStep, note?: string): UndoEntry {
  const entry: UndoEntry = { id: `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`, at: Date.now(), action, label, undo, note };
  writeJournal(root, [...readUndoJournal(root), entry]);
  return entry;
}

async function headOf(root: string): Promise<string | undefined> {
  const r = await gitRun(root, ["rev-parse", "-q", "--verify", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** Runs something that moves HEAD, and journals how to move it back. */
async function movingHead(root: string, action: string, label: string, mode: "soft" | "keep", fn: () => Promise<GitResult>): Promise<GitResult & { moved: boolean }> {
  const before = await headOf(root);
  const r = await fn();
  const after = await headOf(root);
  const moved = !!after && after !== before;
  // Stopped half way (a conflict): Abort is the way back, and Continue journals the finished result.
  if (moved && (await gitOperation(root))) return { ...r, moved };
  if (moved) journal(root, action, label, before ? { kind: "reset", from: after, to: before, mode } : undefined, before ? undefined : "The first commit can't be undone from here.");
  return { ...r, moved };
}

export interface GitActionResult {
  ok: boolean;
  message: string;
  /** It stopped on a conflict: the files are on the board, and Continue or Abort finish it. */
  conflicts?: boolean;
}

/** After a merge, rebase, cherry-pick or revert: done, stopped on conflicts, or failed with git's words. */
async function outcome(root: string, r: GitResult, done: string, what: string): Promise<GitActionResult> {
  if (r.code === 0) return { ok: true, message: done };
  const status = await gitStatusAt(root);
  if (status.operation || status.files.some((f) => f.conflicted)) {
    const n = status.files.filter((f) => f.conflicted).length;
    return { ok: false, conflicts: true, message: `${what} stopped on ${n === 1 ? "a conflict in 1 file" : `conflicts in ${n} files`}. Resolve them, stage them, then Continue (or Abort).` };
  }
  throw gitFailure(r, `Couldn't ${what.toLowerCase()}`);
}

function refuseDuringOperation(status: GitStatus): void {
  if (status.operation) throw new GitError(`A ${status.operation} is in progress. Finish it (Continue) or Abort it first.`);
}

/** The journal, newest first, and git's own reflog for anything older. */
export async function gitUndoList(dir: string): Promise<{ entries: UndoEntry[]; reflog: { oid: string; ref: string; message: string; at: number }[] }> {
  const root = await gitRoot(dir);
  const r = await gitRun(root, ["reflog", "-n", "40", "--format=%H%x1f%gd%x1f%gs%x1f%ct"]);
  const reflog = r.code === 0
    ? r.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
        const [oid, ref, message, at] = line.split(SEP);
        return { oid, ref, message: message ?? "", at: Number(at) * 1000 };
      })
    : [];
  return { entries: readUndoJournal(root).slice().reverse(), reflog };
}

/** Undoes the newest journal entry that isn't undone yet (`id` must be that one). */
export async function gitUndo(dir: string, id: string): Promise<GitActionResult> {
  const root = await gitRoot(dir);
  const list = readUndoJournal(root);
  const open = list.filter((e) => !e.undone);
  const entry = open[open.length - 1];
  if (!entry || entry.id !== id) throw new GitError("Only the latest action can be undone, one at a time. Refresh the page.", 409);
  if (!entry.undo) throw new GitError(entry.note ?? "That can't be undone from here.");
  const status = await gitStatusAt(root);
  refuseDuringOperation(status);
  const u = entry.undo;
  const run = async (args: string[], what: string, input?: string) => {
    const r = await gitRun(root, args, { input });
    if (r.code !== 0) throw gitFailure(r, what);
  };
  switch (u.kind) {
    case "reset": {
      const head = await headOf(root);
      if (head !== u.from) throw new GitError("The branch has moved since, so undoing this would throw newer work away. Use Go back here in the list below instead.", 409);
      await run(["reset", `--${u.mode}`, u.to], "Couldn't undo");
      break;
    }
    case "branch-restore":
      await run(["branch", "--", u.name, u.oid], "Couldn't bring the branch back");
      break;
    case "branch-delete": {
      const refs = await refsAt(root);
      const b = refs.branches.find((x) => x.name === u.name);
      if (!b) break;
      if (b.current) throw new GitError(`You're on ${u.name}: switch to another branch first.`);
      if (b.oid !== u.oid) throw new GitError(`${u.name} has new commits since, so it isn't deleted.`, 409);
      await run(["branch", "-D", "--", u.name], "Couldn't delete the branch");
      break;
    }
    case "branch-rename":
      await run(["branch", "-m", "--", u.to, u.from], "Couldn't rename it back");
      break;
    case "switch":
      await run(u.detached ? ["switch", "--detach", u.to] : ["switch", "--", u.to], "Couldn't switch back");
      break;
    case "tag-restore":
      await run(["update-ref", `refs/tags/${u.name}`, u.oid, "0".repeat(40)], "Couldn't bring the tag back");
      break;
    case "tag-delete":
      await run(["update-ref", "-d", `refs/tags/${u.name}`, u.oid], "Couldn't delete the tag");
      break;
    case "stash-restore":
      await run(["stash", "store", "-m", u.message, u.oid], "Couldn't put it back on the shelf");
      break;
    case "stash-pop": {
      const refs = await refsAt(root);
      if (refs.stashes[0]?.oid !== u.oid) throw new GitError("The shelf has changed since, so this isn't undone. Take it off the shelf by hand.", 409);
      const r = await gitRun(root, ["stash", "pop", "--index"]);
      if (r.code !== 0) throw gitFailure(r, "Couldn't take it back off the shelf");
      break;
    }
    case "files":
      for (const f of u.files) {
        const full = inside(root, f.path);
        if (f.blob === null) {
          fs.rmSync(full, { force: true });
          continue;
        }
        const r = await gitRun(root, ["cat-file", "blob", f.blob]);
        if (r.code !== 0) throw gitFailure(r, `Couldn't bring back ${f.path}`);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, r.raw);
      }
      break;
  }
  entry.undone = true;
  writeJournal(root, list);
  return { ok: true, message: `Undone: ${entry.label}` };
}

/** A path from the journal or a status, inside the repository. */
function inside(root: string, file: string): string {
  const full = path.resolve(root, file);
  if (!full.startsWith(path.resolve(root) + path.sep)) throw new GitError("That file isn't inside the repository.");
  return full;
}

/** Moves the branch to an earlier (or any) commit, keeping uncommitted changes: "Go back here". */
export async function gitResetTo(dir: string, hash: string): Promise<GitActionResult> {
  const root = await gitRoot(dir);
  refuseDuringOperation(await gitStatusAt(root));
  const c = await knownCommit(root, hash);
  const r = await movingHead(root, "reset", `Moved the branch to ${c.oid.slice(0, 7)} ${c.subject}`, "keep", () => gitRun(root, ["reset", "--keep", c.oid]));
  if (r.code !== 0) throw gitFailure(r, "Couldn't move the branch (uncommitted changes in the way?)");
  return { ok: true, message: `The branch is at ${c.oid.slice(0, 7)} now.` };
}

// ------------------------------------------------------------------ commits

export async function gitCommitChanges(dir: string, message: string, options: { amend?: boolean } = {}): Promise<{ hash: string; short: string; subject: string }> {
  const root = await gitRoot(dir);
  const before = await headOf(root);
  const c = await gitCommit(root, message, options);
  if (before) journal(root, options.amend ? "amend" : "commit", `${options.amend ? "Amended" : "Committed"} ${c.short} ${c.subject}`, { kind: "reset", from: c.hash, to: before, mode: "soft" });
  else journal(root, "commit", `Committed ${c.short} ${c.subject}`, undefined, "The first commit can't be undone from here.");
  return c;
}

export async function gitRevert(dir: string, hash: string): Promise<GitActionResult> {
  const root = await gitRoot(dir);
  refuseDuringOperation(await gitStatusAt(root));
  const c = await knownCommit(root, hash);
  const r = await movingHead(root, "revert", `Reverted ${c.oid.slice(0, 7)} ${c.subject}`, "keep", () =>
    gitRun(root, ["revert", "--no-edit", ...(c.parents.length > 1 ? ["-m", "1"] : []), c.oid], { timeoutMs: 120_000 }),
  );
  return outcome(root, r, `Reverted ${c.oid.slice(0, 7)}: a new commit undoes its changes.`, "The revert");
}

export async function gitCherryPick(dir: string, hash: string): Promise<GitActionResult> {
  const root = await gitRoot(dir);
  refuseDuringOperation(await gitStatusAt(root));
  const c = await knownCommit(root, hash);
  if ((await headOf(root)) && (await isAncestor(root, c.oid, "HEAD"))) throw new GitError("That commit is already on this branch.");
  // A copy made earlier has another hash but the same change: `git cherry` marks it with "-".
  if (c.parents[0] && (await headOf(root))) {
    const same = await gitRun(root, ["cherry", "HEAD", c.oid, c.parents[0]]);
    if (same.code === 0 && same.stdout.trim().startsWith("-")) throw new GitError("That change is already on this branch (copied before).");
  }
  const r = await movingHead(root, "cherry-pick", `Copied ${c.oid.slice(0, 7)} ${c.subject} onto this branch`, "keep", () =>
    gitRun(root, ["cherry-pick", ...(c.parents.length > 1 ? ["-m", "1"] : []), c.oid], { timeoutMs: 120_000 }),
  );
  return outcome(root, r, `Copied ${c.oid.slice(0, 7)} onto this branch.`, "The cherry-pick");
}

// ------------------------------------------------------------------ branches and tags

export async function gitCreateBranch(dir: string, name: string, options: { at?: string; switchTo?: boolean } = {}): Promise<GitActionResult> {
  const root = await gitRoot(dir);
  const n = await newRefName(root, name, "branch");
  const refs = await refsAt(root);
  if (refs.branches.some((b) => b.name === n)) throw new GitError(`There's already a branch called ${n}.`);
  const at = options.at ? (await knownCommit(root, options.at)).oid : refs.head;
  if (!at) throw new GitError("Make a first commit before creating branches.");
  if (options.switchTo) {
    const r = await gitRun(root, ["switch", "-c", n, at]);
    if (r.code !== 0) throw gitFailure(r, "Couldn't create the branch");
    journal(root, "branch", `Created ${n} and switched to it`, refs.current ? { kind: "switch", to: refs.current, detached: false } : undefined);
  } else {
    const r = await gitRun(root, ["branch", "--", n, at]);
    if (r.code !== 0) throw gitFailure(r, "Couldn't create the branch");
    journal(root, "branch", `Created ${n} at ${at.slice(0, 7)}`, { kind: "branch-delete", name: n, oid: at });
  }
  return { ok: true, message: `Created ${n}.` };
}

/** Switches branch; a remote branch gets a local one that tracks it. With `shelve`, changes go on the shelf first. */
export async function gitSwitch(dir: string, name: string, options: { shelve?: boolean } = {}): Promise<GitActionResult> {
  const root = await gitRoot(dir);
  const status = await gitStatusAt(root);
  refuseDuringOperation(status);
  const refs = await refsAt(root);
  const local = refs.branches.find((b) => b.name === name);
  const remote = local ? undefined : refs.remoteBranches.find((b) => b.name === name);
  if (!local && !remote) throw new GitError(`There's no branch called ${name} any more. Refresh the page.`, 409);
  if (local?.current) return { ok: true, message: `You're on ${name} already.` };
  const from = refs.current ? { to: refs.current, detached: false } : refs.head ? { to: refs.head, detached: true } : undefined;
  if (options.shelve && status.files.length) {
    const s = await gitRun(root, ["stash", "push", "-u", "-m", `dx: changes on ${refs.current ?? "HEAD"} before switching to ${name}`], { literal: false });
    if (s.code !== 0) throw gitFailure(s, "Couldn't put the changes on the shelf");
  }
  const target = local ? local.name : remote!.branch;
  const exists = refs.branches.some((b) => b.name === target);
  const r = remote && !exists ? await gitRun(root, ["switch", "--track", `${remote.name}`]) : await gitRun(root, ["switch", "--", target]);
  if (r.code !== 0) {
    if (/would be overwritten|commit your changes or stash/i.test(r.stderr)) throw new GitError(`Your changes would be overwritten by ${target}. Put them on the shelf first (Switch and shelve), or commit them.`, 409);
    throw gitFailure(r, "Couldn't switch");
  }
  journal(root, "switch", `Switched to ${target}${options.shelve && status.files.length ? " (changes on the shelf)" : ""}`, from && { kind: "switch", ...from });
  return { ok: true, message: `On ${target} now.` };
}

export async function gitRenameBranch(dir: string, from: string, to: string): Promise<GitActionResult> {
  const root = await gitRoot(dir);
  const refs = await refsAt(root);
  const b = knownBranch(refs, from);
  const n = await newRefName(root, to, "branch");
  if (refs.branches.some((x) => x.name === n)) throw new GitError(`There's already a branch called ${n}.`);
  const r = await gitRun(root, ["branch", "-m", "--", b.name, n]);
  if (r.code !== 0) throw gitFailure(r, "Couldn't rename the branch");
  journal(root, "rename", `Renamed ${b.name} to ${n}`, { kind: "branch-rename", from: b.name, to: n });
  return { ok: true, message: `Renamed ${b.name} to ${n}.` };
}

export async function gitDeleteBranch(dir: string, name: string): Promise<GitActionResult> {
  const root = await gitRoot(dir);
  const refs = await refsAt(root);
  const b = knownBranch(refs, name);
  if (b.current) throw new GitError(`You're on ${name}: switch to another branch first.`);
  // -D: the page has said whether it's merged and asked first; the journal can bring it back.
  const r = await gitRun(root, ["branch", "-D", "--", b.name]);
  if (r.code !== 0) throw gitFailure(r, "Couldn't delete the branch");
  journal(root, "delete-branch", `Deleted ${b.name}${b.merged ? "" : " (it wasn't merged)"}`, { kind: "branch-restore", name: b.name, oid: b.oid });
  return { ok: true, message: `Deleted ${b.name}.` };
}

export async function gitCreateTag(dir: string, name: string, options: { at?: string; message?: string } = {}): Promise<GitActionResult> {
  const root = await gitRoot(dir);
  const n = await newRefName(root, name, "tag");
  const refs = await refsAt(root);
  if (refs.tags.some((t) => t.name === n)) throw new GitError(`There's already a tag called ${n}.`);
  const at = options.at ? (await knownCommit(root, options.at)).oid : refs.head;
  if (!at) throw new GitError("Make a first commit before tagging.");
  const message = (options.message ?? "").trim().slice(0, 10_000);
  const r = message ? await gitRun(root, ["tag", "-a", "-F", "-", "--", n, at], { input: `${message}\n` }) : await gitRun(root, ["tag", "--", n, at]);
  if (r.code !== 0) throw gitFailure(r, "Couldn't create the tag");
  const oid = (await gitRun(root, ["rev-parse", `refs/tags/${n}`])).stdout.trim();
  journal(root, "tag", `Tagged ${at.slice(0, 7)} as ${n}`, { kind: "tag-delete", name: n, oid });
  return { ok: true, message: `Tagged ${at.slice(0, 7)} as ${n}.` };
}

export async function gitDeleteTag(dir: string, name: string): Promise<GitActionResult> {
  const root = await gitRoot(dir);
  const refs = await refsAt(root);
  if (typeof name !== "string" || !refs.tags.some((t) => t.name === name)) throw new GitError(`There's no tag called ${name} any more. Refresh the page.`, 409);
  const oid = (await gitRun(root, ["rev-parse", `refs/tags/${name}`])).stdout.trim();
  const r = await gitRun(root, ["tag", "-d", "--", name]);
  if (r.code !== 0) throw gitFailure(r, "Couldn't delete the tag");
  journal(root, "delete-tag", `Deleted the tag ${name}`, { kind: "tag-restore", name, oid });
  return { ok: true, message: `Deleted the tag ${name}.` };
}

// ------------------------------------------------------------------ merge and rebase

export interface GitMergePreview {
  branch: string;
  current?: string;
  /** Commits that would come in, newest first (at most 30 listed). */
  incoming: { hash: string; subject: string }[];
  incomingCount: number;
  /** Commits on your branch that aren't on the other one: what a rebase replays. */
  outgoing: { hash: string; subject: string }[];
  outgoingCount: number;
  upToDate: boolean;
  fastForward: boolean;
  /** Files a merge would conflict in; undefined when git is too old to tell (before 2.38). */
  conflicts?: string[];
}

const commitList = (text: string) =>
  text.split(/\r?\n/).filter(Boolean).map((l) => {
    const [hash, subject] = l.split(SEP);
    return { hash, subject: subject ?? "" };
  });

/** What merging (or rebasing onto) a branch would do, worked out without touching any file. */
export async function gitMergePreview(dir: string, branch: string): Promise<GitMergePreview> {
  const root = await gitRoot(dir);
  const refs = await refsAt(root);
  const t = knownTarget(refs, branch);
  if (!refs.head) throw new GitError("Make a first commit before merging.");
  const [inc, incCount, out, outCount, tree] = await Promise.all([
    gitRun(root, ["log", "-n", "30", "--format=%H%x1f%s", `HEAD..${t.ref}`, "--"]),
    gitRun(root, ["rev-list", "--count", `HEAD..${t.ref}`, "--"]),
    gitRun(root, ["log", "-n", "30", "--format=%H%x1f%s", `${t.ref}..HEAD`, "--"]),
    gitRun(root, ["rev-list", "--count", `${t.ref}..HEAD`, "--"]),
    gitRun(root, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "HEAD", t.ref]),
  ]);
  const incomingCount = Number(incCount.stdout.trim()) || 0;
  const outgoingCount = Number(outCount.stdout.trim()) || 0;
  let conflicts: string[] | undefined;
  if (tree.code === 0) conflicts = [];
  else if (tree.code === 1) conflicts = tree.stdout.split(/\r?\n/).slice(1).filter(Boolean);
  return {
    branch: t.label,
    current: refs.current,
    incoming: commitList(inc.stdout),
    incomingCount,
    outgoing: commitList(out.stdout),
    outgoingCount,
    upToDate: incomingCount === 0,
    fastForward: outgoingCount === 0 && incomingCount > 0,
    conflicts,
  };
}

export type MergeMode = "merge" | "squash" | "fast-forward";

/** Merges a branch into the one you're on. */
export async function gitMerge(dir: string, branch: string, mode: MergeMode = "merge"): Promise<GitActionResult> {
  const root = await gitRoot(dir);
  refuseDuringOperation(await gitStatusAt(root));
  const refs = await refsAt(root);
  const t = knownTarget(refs, branch);
  if (!refs.current) throw new GitError("You're not on a branch (detached HEAD): switch to one to merge into it.");
  if (t.label === refs.current) throw new GitError("That's the branch you're on.");
  const into = refs.current;
  if (mode === "squash") {
    const r = await movingHead(root, "squash", `Squashed ${t.label} into ${into}`, "keep", async () => {
      const m = await gitRun(root, ["merge", "--squash", t.arg], { timeoutMs: 120_000 });
      if (m.code !== 0) return m;
      return gitRun(root, ["commit", "-q", "--no-edit"], { timeoutMs: 120_000 });
    });
    return outcome(root, r, `Squashed ${t.label} into one new commit on ${into}.`, "The squash");
  }
  // git's own wording, with the short name: given the full ref, it would write "Merge branch 'refs/heads/x'".
  const title = t.ref.startsWith("refs/remotes/") ? `Merge remote-tracking branch '${t.label}'` : `Merge branch '${t.label}'`;
  const args = mode === "fast-forward" ? ["merge", "--ff-only", t.arg] : ["merge", "--no-ff", "--no-edit", "-m", into === "main" || into === "master" ? title : `${title} into ${into}`, t.arg];
  const r = await movingHead(root, "merge", `Merged ${t.label} into ${into}`, "keep", () => gitRun(root, args, { timeoutMs: 120_000 }));
  if (r.code !== 0 && mode === "fast-forward") throw gitFailure(r, `${into} can't simply move forward to ${t.label}: both have new commits. Merge or rebase instead`);
  return outcome(root, r, mode === "fast-forward" ? `${into} moved forward to ${t.label}.` : `Merged ${t.label} into ${into}.`, "The merge");
}

/** Replays the branch you're on on top of another one. */
export async function gitRebase(dir: string, onto: string): Promise<GitActionResult> {
  const root = await gitRoot(dir);
  refuseDuringOperation(await gitStatusAt(root));
  const refs = await refsAt(root);
  const t = knownTarget(refs, onto);
  if (!refs.current) throw new GitError("You're not on a branch (detached HEAD): switch to one to rebase it.");
  if (t.label === refs.current) throw new GitError("That's the branch you're on.");
  const r = await movingHead(root, "rebase", `Rebased ${refs.current} onto ${t.label}`, "keep", () => gitRun(root, ["rebase", t.arg], { timeoutMs: 180_000 }));
  return outcome(root, r, `${refs.current} now sits on top of ${t.label}.`, "The rebase");
}

/** Finishes a merge, rebase, cherry-pick or revert that stopped on conflicts. */
export async function gitContinue(dir: string): Promise<GitActionResult> {
  const root = await gitRoot(dir);
  const status = await gitStatusAt(root);
  if (!status.operation) throw new GitError("Nothing is waiting to be continued.");
  if (status.files.some((f) => f.conflicted)) throw new GitError("Some files still have conflicts. Resolve them and stage them first.");
  const op = status.operation;
  const args: Record<GitOperation, string[]> = {
    merge: ["commit", "-q", "--no-edit"],
    rebase: ["rebase", "--continue"],
    "cherry-pick": ["cherry-pick", "--continue"],
    revert: ["revert", "--continue"],
  };
  // A rebase keeps where it started in ORIG_HEAD; the others start from HEAD as it is now.
  const orig = op === "rebase" ? (await gitRun(root, ["rev-parse", "-q", "--verify", "ORIG_HEAD"])).stdout.trim() : await headOf(root);
  const r = await gitRun(root, args[op], { timeoutMs: 180_000 });
  const res = await outcome(root, r, `The ${op} is done.`, `The ${op}`);
  const after = await headOf(root);
  if (res.ok && orig && after && after !== orig) journal(root, op, `Finished the ${op}`, { kind: "reset", from: after, to: orig, mode: "keep" });
  return res;
}

export async function gitAbort(dir: string): Promise<GitActionResult> {
  const root = await gitRoot(dir);
  const status = await gitStatusAt(root);
  if (!status.operation) throw new GitError("Nothing is in progress to abort.");
  const r = await gitRun(root, [status.operation, "--abort"]);
  if (r.code !== 0) throw gitFailure(r, `Couldn't abort the ${status.operation}`);
  return { ok: true, message: `The ${status.operation} is aborted: everything is as it was before.` };
}

// ------------------------------------------------------------------ conflicts

export interface ConflictBlock {
  ours: string[];
  theirs: string[];
  base?: string[];
  oursLabel: string;
  theirsLabel: string;
}

export interface ConflictFile {
  path: string;
  /** A hash of the file as read: a resolution must name it, so it can't apply to a file that changed. */
  hash: string;
  /** Text between and around conflicts, and the conflicts themselves, in order. */
  parts: ({ kind: "text"; lines: string[] } | ({ kind: "conflict" } & ConflictBlock))[];
  binary: boolean;
}

const CONFLICT_MAX = 512 * 1024;

function conflictPath(root: string, status: GitStatus, file: unknown): string {
  const f = typeof file === "string" ? status.files.find((x) => x.path === file && x.conflicted) : undefined;
  if (!f) throw new GitError(`${typeof file === "string" ? file : "That file"} has no conflict any more. Refresh the page.`, 409);
  return f.path;
}

function readConflict(root: string, file: string): ConflictFile {
  const full = inside(root, file);
  let buf: Buffer;
  try {
    const stat = fs.lstatSync(full);
    if (!stat.isFile()) throw new GitError(`${file} isn't a plain file: take one side whole.`);
    if (stat.size > CONFLICT_MAX) throw new GitError(`${file} is too big to resolve here: take one side whole, or use your editor.`);
    buf = fs.readFileSync(full);
  } catch (err) {
    if (err instanceof GitError) throw err;
    return { path: file, hash: "", parts: [], binary: true };
  }
  const hash = crypto.createHash("sha1").update(buf).digest("hex");
  if (buf.subarray(0, 8000).includes(0)) return { path: file, hash, parts: [], binary: true };
  const lines = buf.toString("utf8").split("\n");
  const parts: ConflictFile["parts"] = [];
  let text: string[] = [];
  let block: (ConflictBlock & { side: "ours" | "base" | "theirs" }) | undefined;
  for (const line of lines) {
    const bare = line.replace(/\r$/, "");
    if (!block && bare.startsWith("<<<<<<<")) {
      if (text.length) parts.push({ kind: "text", lines: text });
      text = [];
      block = { ours: [], theirs: [], oursLabel: bare.slice(8).trim(), theirsLabel: "", side: "ours" };
    } else if (block && bare.startsWith("|||||||") && block.side === "ours") {
      block.base = [];
      block.side = "base";
    } else if (block && bare === "=======" && block.side !== "theirs") {
      block.side = "theirs";
    } else if (block && bare.startsWith(">>>>>>>") && block.side === "theirs") {
      block.theirsLabel = bare.slice(8).trim();
      const { side: _side, ...rest } = block;
      parts.push({ kind: "conflict", ...rest });
      block = undefined;
    } else if (block) {
      (block.side === "ours" ? block.ours : block.side === "base" ? block.base! : block.theirs).push(line);
    } else text.push(line);
  }
  if (block) throw new GitError(`${file} has a conflict marker without its end: resolve it in your editor.`);
  if (text.length) parts.push({ kind: "text", lines: text });
  return { path: file, hash, parts, binary: false };
}

export async function gitConflict(dir: string, file: string): Promise<ConflictFile> {
  const root = await gitRoot(dir);
  return readConflict(root, conflictPath(root, await gitStatusAt(root), file));
}

export type ConflictChoice = "ours" | "theirs" | "both" | "both-theirs-first";

/**
 * Resolves each conflict of a file with Mine, Theirs or Both, rebuilt from the file's own text
 * (never from the request), then stages it. `side` takes one side of the whole file, binary too.
 */
export async function gitResolve(dir: string, file: string, options: { hash?: string; choices?: ConflictChoice[]; side?: "ours" | "theirs" }): Promise<GitActionResult> {
  const root = await gitRoot(dir);
  const name = conflictPath(root, await gitStatusAt(root), file);
  if (options.side === "ours" || options.side === "theirs") {
    const r = await gitRun(root, ["checkout", `--${options.side}`, "--", name]);
    if (r.code !== 0) throw gitFailure(r, `Couldn't take that side of ${name}`);
  } else {
    const c = readConflict(root, name);
    if (c.binary) throw new GitError(`${name} is binary: take one side whole.`);
    if (c.hash !== options.hash) throw new GitError(`${name} changed since it was shown. Refresh and try again.`, 409);
    const blocks = c.parts.filter((p) => p.kind === "conflict").length;
    const choices = options.choices ?? [];
    if (choices.length !== blocks || !choices.every((x) => ["ours", "theirs", "both", "both-theirs-first"].includes(x))) throw new GitError(`Pick a side for each of the ${blocks} conflicts.`);
    let i = 0;
    const out: string[] = [];
    for (const p of c.parts) {
      if (p.kind === "text") out.push(...p.lines);
      else {
        const ch = choices[i++];
        out.push(...(ch === "ours" ? p.ours : ch === "theirs" ? p.theirs : ch === "both" ? [...p.ours, ...p.theirs] : [...p.theirs, ...p.ours]));
      }
    }
    fs.writeFileSync(inside(root, name), out.join("\n"));
  }
  const add = await gitRun(root, ["add", "--", name]);
  if (add.code !== 0) throw gitFailure(add, `Couldn't stage ${name}`);
  return { ok: true, message: `${name} is resolved and staged.` };
}

// ------------------------------------------------------------------ the stash shelf

function knownStash(refs: GitRefs, oid: unknown): GitStash {
  const s = typeof oid === "string" ? refs.stashes.find((x) => x.oid === oid) : undefined;
  if (!s) throw new GitError("That isn't on the shelf any more. Refresh the page.", 409);
  return s;
}

/** Puts changes on the shelf: all of them, or the files given (new files included). */
export async function gitStashPush(dir: string, options: { paths?: string[]; message?: string } = {}): Promise<GitActionResult> {
  const root = await gitRoot(dir);
  const status = await gitStatusAt(root);
  refuseDuringOperation(status);
  if (!status.files.length) throw new GitError("There are no changes to put on the shelf.");
  let paths: string[] | undefined;
  if (options.paths?.length) {
    const known = new Map(status.files.map((f) => [f.path, f]));
    paths = [];
    for (const p of options.paths) {
      const f = typeof p === "string" ? known.get(p) : undefined;
      if (!f) throw new GitError(`${p} isn't among the changed files any more. Refresh the list.`, 409);
      paths.push(f.path, ...(f.from ? [f.from] : []));
    }
  }
  const message = (options.message ?? "").trim().slice(0, 200) || (paths ? `${paths.length === 1 ? paths[0] : `${paths.length} files`}` : `everything on ${status.branch ?? "HEAD"}`);
  const args = ["stash", "push", "-u", "-m", message, ...(paths ? ["--pathspec-from-file=-", "--pathspec-file-nul"] : [])];
  const r = await gitRun(root, args, { input: paths ? paths.join("\0") : "", literal: !!paths });
  if (r.code !== 0) throw gitFailure(r, "Couldn't put the changes on the shelf");
  const top = (await refsAt(root)).stashes[0];
  journal(root, "stash", `Put ${paths ? (paths.length === 1 ? paths[0] : `${paths.length} files`) : "every change"} on the shelf`, top && { kind: "stash-pop", oid: top.oid });
  return { ok: true, message: "On the shelf." };
}

/** Takes something off the shelf: `pop` removes it there, `apply` leaves a copy. */
export async function gitStashApply(dir: string, oid: string, options: { pop?: boolean } = {}): Promise<GitActionResult> {
  const root = await gitRoot(dir);
  refuseDuringOperation(await gitStatusAt(root));
  const s = knownStash(await refsAt(root), oid);
  const r = await gitRun(root, ["stash", options.pop ? "pop" : "apply", "--index", `stash@{${s.index}}`]);
  if (r.code !== 0) {
    if (/conflict/i.test(r.stdout + r.stderr)) {
      return { ok: false, conflicts: true, message: "Those changes clash with yours: the clashing files are marked as conflicts, and the shelf keeps its copy." };
    }
    throw gitFailure(r, "Couldn't take it off the shelf");
  }
  if (options.pop) journal(root, "unstash", `Took "${s.message}" off the shelf`, { kind: "stash-restore", oid: s.oid, message: s.message }, undefined);
  return { ok: true, message: options.pop ? "Off the shelf and back in your files." : "Back in your files; the shelf keeps a copy." };
}

export async function gitStashDrop(dir: string, oid: string): Promise<GitActionResult> {
  const root = await gitRoot(dir);
  const s = knownStash(await refsAt(root), oid);
  const r = await gitRun(root, ["stash", "drop", `stash@{${s.index}}`]);
  if (r.code !== 0) throw gitFailure(r, "Couldn't remove it from the shelf");
  journal(root, "drop-stash", `Threw away "${s.message}" from the shelf`, { kind: "stash-restore", oid: s.oid, message: s.message });
  return { ok: true, message: "Removed from the shelf." };
}

// ------------------------------------------------------------------ discard

/** Throws away changes to files in the working folder, keeping a copy in git so Undo brings them back. */
export async function gitDiscard(dir: string, paths: string[]): Promise<GitActionResult> {
  const root = await gitRoot(dir);
  const status = await gitStatusAt(root);
  if (!Array.isArray(paths) || !paths.length) throw new GitError("Which files? Give their paths.");
  const byPath = new Map(status.files.map((f) => [f.path, f]));
  const files = paths.map((p) => {
    const f = typeof p === "string" ? byPath.get(p) : undefined;
    if (!f || !f.unstaged) throw new GitError(`${p} has no changes to discard any more. Refresh the list.`, 409);
    if (f.conflicted) throw new GitError(`${p} has a conflict: resolve it instead.`);
    return f;
  });
  // A copy of each file as it is now, as a blob in git's own store: that's what Undo writes back.
  const backup: { path: string; blob: string | null }[] = [];
  for (const f of files) {
    const full = inside(root, f.path);
    const stat = fs.lstatSync(full, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) {
      backup.push({ path: f.path, blob: null });
      continue;
    }
    const h = await gitRun(root, ["hash-object", "-w", "--stdin-paths", "--no-filters"], { input: `${f.path}\n` });
    if (h.code !== 0) throw gitFailure(h, `Couldn't keep a copy of ${f.path}, so it wasn't discarded`);
    backup.push({ path: f.path, blob: h.stdout.trim() });
  }
  const tracked = files.filter((f) => !f.untracked).map((f) => f.path);
  if (tracked.length) {
    const r = await gitRun(root, ["restore", "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: tracked.join("\0") });
    if (r.code !== 0) throw gitFailure(r, "Couldn't discard the changes");
  }
  for (const f of files.filter((x) => x.untracked)) fs.rmSync(inside(root, f.path), { force: true });
  // Undo puts back what was there: a file that didn't exist (a deleted file brought back) is removed again.
  journal(root, "discard", `Discarded changes to ${files.length === 1 ? files[0].path : `${files.length} files`}`, {
    kind: "files",
    files: backup.map((b, i) => (files[i].worktree === "D" ? { path: b.path, blob: null } : b)),
  });
  return { ok: true, message: `Discarded ${files.length === 1 ? files[0].path : `${files.length} files`}. Undo brings them back.` };
}

// ------------------------------------------------------------------ fetch, pull, push

function remoteFor(refs: GitRefs): string {
  if (!refs.remotes.length) throw new GitError("This repository has no remote to push to. Add one with git remote add origin <url>.");
  return refs.remotes.includes("origin") ? "origin" : refs.remotes[0];
}

const NETWORK = { timeoutMs: 180_000 };

export async function gitFetch(dir: string): Promise<GitActionResult> {
  const root = await gitRoot(dir);
  const refs = await refsAt(root);
  if (!refs.remotes.length) throw new GitError("This repository has no remote to fetch from.");
  const r = await gitRun(root, ["fetch", "--all", "--prune"], NETWORK);
  if (r.code !== 0) throw gitFailure(r, "Couldn't fetch (signed in? try git fetch in a terminal)");
  return { ok: true, message: "Fetched: the remote branches are up to date." };
}

/** Pulls with fast-forward only: when both sides moved, merging or rebasing is a choice the page makes visible. */
export async function gitPull(dir: string): Promise<GitActionResult> {
  const root = await gitRoot(dir);
  refuseDuringOperation(await gitStatusAt(root));
  const refs = await refsAt(root);
  const b = refs.branches.find((x) => x.current);
  if (!b) throw new GitError("You're not on a branch (detached HEAD).");
  if (!b.upstream) throw new GitError(`${b.name} has no upstream to pull from. Push it first.`);
  const r = await movingHead(root, "pull", `Pulled ${b.upstream} into ${b.name}`, "keep", () => gitRun(root, ["pull", "--ff-only"], NETWORK));
  if (r.code !== 0) {
    if (/not possible to fast-forward|diverg/i.test(r.stderr)) throw new GitError(`${b.name} and ${b.upstream} both have new commits. Drag ${b.upstream} onto ${b.name} to merge it, or ${b.name} onto ${b.upstream} to rebase.`, 409);
    throw gitFailure(r, "Couldn't pull (signed in? uncommitted changes in the way?)");
  }
  return { ok: true, message: r.moved ? `Pulled ${b.upstream}.` : "Already up to date." };
}

/** Pushes the branch you're on (setting its upstream the first time). Forcing is only ever --force-with-lease. */
export async function gitPush(dir: string, options: { force?: boolean } = {}): Promise<GitActionResult> {
  const root = await gitRoot(dir);
  const refs = await refsAt(root);
  const b = refs.branches.find((x) => x.current);
  if (!b) throw new GitError("You're not on a branch (detached HEAD).");
  const args = b.upstream ? ["push"] : ["push", "-u", remoteFor(refs), `refs/heads/${b.name}`];
  if (options.force) args.push("--force-with-lease");
  const r = await gitRun(root, args, NETWORK);
  if (r.code !== 0) {
    if (/rejected|fetch first|non-fast-forward/i.test(r.stderr)) throw new GitError(`The remote has commits ${b.name} doesn't. Pull first (or, if you rewrote history on purpose, Force push).`, 409);
    if (/stale info|lease/i.test(r.stderr)) throw new GitError("Someone pushed since you last fetched, so the force push stopped. Fetch and look first.", 409);
    throw gitFailure(r, "Couldn't push (signed in?)");
  }
  journal(root, "push", `Pushed ${b.name}${options.force ? " (forced, with lease)" : ""}`, undefined, "A push changes the remote: it can't be undone from here.");
  return { ok: true, message: `Pushed ${b.name}.` };
}

/** Pushes one tag (a name from a fresh listing), or every tag with `all`. Tags never move, so nothing is forced. */
export async function gitPushTags(dir: string, options: { name?: string; all?: boolean } = {}): Promise<GitActionResult> {
  const root = await gitRoot(dir);
  const refs = await refsAt(root);
  const remote = remoteFor(refs);
  if (!options.all && !refs.tags.some((t) => t.name === options.name)) throw new GitError(`There's no tag called ${options.name ?? "that"} any more. Refresh the page.`, 409);
  if (options.all && !refs.tags.length) throw new GitError("There are no tags to push.");
  const args = options.all ? ["push", remote, "--tags"] : ["push", remote, `refs/tags/${options.name}`];
  const r = await gitRun(root, args, NETWORK);
  if (r.code !== 0) {
    if (/already exists|rejected/i.test(r.stderr)) throw new GitError(`The remote already has ${options.all ? "a tag with one of these names" : `a tag called ${options.name}`} on another commit. Tags aren't moved by dx: delete it there first if you mean to.`, 409);
    throw gitFailure(r, "Couldn't push (signed in?)");
  }
  const what = options.all ? `every tag (${refs.tags.length})` : `the tag ${options.name}`;
  journal(root, "push-tag", `Pushed ${what} to ${remote}`, undefined, "A push changes the remote: it can't be undone from here.");
  return { ok: true, message: `Pushed ${what} to ${remote}.` };
}

// ------------------------------------------------------------------ editing history (interactive rebase)

export interface RebasePlanCommit {
  hash: string;
  short: string;
  subject: string;
  author: string;
}

export type RebaseAction = "pick" | "reword" | "squash" | "fixup" | "drop";

/** The commits from `from` (included) up to HEAD, oldest first: what Edit history rewrites. */
export async function gitRebasePlan(dir: string, from: string): Promise<{ base?: string; commits: RebasePlanCommit[] }> {
  const root = await gitRoot(dir);
  return planAt(root, from);
}

async function planAt(root: string, from: string): Promise<{ base?: string; commits: RebasePlanCommit[] }> {
  const c = await knownCommit(root, from);
  if (!(await isAncestor(root, c.oid, "HEAD"))) throw new GitError("That commit isn't on the branch you're on, so there's no history to edit from it.");
  const base = c.parents[0];
  const range = base ? `${base}..HEAD` : "HEAD";
  const merges = await gitRun(root, ["rev-list", "--merges", "--count", range]);
  if (Number(merges.stdout.trim()) > 0) throw new GitError("There's a merge in that stretch of history: editing it here would flatten the merge. Pick a later commit.");
  const r = await gitRun(root, ["log", "--reverse", "--format=%H%x1f%s%x1f%an", range, "--"]);
  const commits = r.stdout.split(/\r?\n/).filter(Boolean).map((l) => {
    const [hash, subject, author] = l.split(SEP);
    return { hash, short: hash.slice(0, 7), subject: subject ?? "", author: author ?? "" };
  });
  if (commits.length > 100) throw new GitError("That's more than 100 commits to edit at once. Pick a later commit.");
  return { base, commits };
}

/**
 * Rewrites the commits from `from` to HEAD as the steps say: in their order, each picked,
 * reworded, squashed or fixed up into the one before, or dropped. The todo is written by dx from
 * the plan's own hashes; new messages go in files, never on a command line.
 */
export async function gitRebaseRun(dir: string, from: string, steps: { hash: string; action: RebaseAction; message?: string }[]): Promise<GitActionResult> {
  const root = await gitRoot(dir);
  const status = await gitStatusAt(root);
  refuseDuringOperation(status);
  if (status.files.some((f) => !f.untracked)) throw new GitError("Commit, shelve or discard your changes before editing history.");
  const plan = await planAt(root, from);
  const known = new Set(plan.commits.map((c) => c.hash));
  if (!Array.isArray(steps) || steps.length !== known.size || new Set(steps.map((s) => s?.hash)).size !== known.size || !steps.every((s) => known.has(s?.hash))) {
    throw new GitError("The steps don't match the history any more. Refresh and try again.", 409);
  }
  const actions: RebaseAction[] = ["pick", "reword", "squash", "fixup", "drop"];
  if (!steps.every((s) => actions.includes(s.action))) throw new GitError("Each commit is picked, reworded, squashed, fixed up or dropped.");
  const firstKept = steps.find((s) => s.action !== "drop");
  if (!firstKept) throw new GitError("That would drop every commit. Use Go back here instead.");
  if (firstKept.action === "squash" || firstKept.action === "fixup") throw new GitError("The first commit kept can't be squashed: there's nothing before it to squash into.");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dx-rebase-"));
  try {
    const slash = (p: string) => p.replace(/\\/g, "/");
    const lines: string[] = [];
    steps.forEach((s, i) => {
      if (s.action === "reword") {
        const text = String(s.message ?? "").replace(/\r\n/g, "\n").trim();
        if (!text || text.length > 10_000) throw new GitError("Write the new message for each commit you reword.");
        const file = path.join(tmp, `message-${i}.txt`);
        fs.writeFileSync(file, `${text}\n`);
        lines.push(`pick ${s.hash}`, `exec git commit --amend -q --no-verify -F "${slash(file)}"`);
      } else lines.push(`${s.action} ${s.hash}`);
    });
    const todo = path.join(tmp, "todo");
    fs.writeFileSync(todo, `${lines.join("\n")}\n`);
    // git hands the editor the path of its todo file; this one copies dx's over it.
    const editor = path.join(tmp, "editor.cjs");
    fs.writeFileSync(editor, 'require("fs").copyFileSync(process.argv[2], process.argv[3]);\n');
    const sequenceEditor = `"${slash(process.execPath)}" "${slash(editor)}" "${slash(todo)}"`;
    const args = plan.base ? ["rebase", "-i", plan.base] : ["rebase", "-i", "--root"];
    const before = await headOf(root);
    const r = await gitRun(root, args, { timeoutMs: 180_000, env: { GIT_SEQUENCE_EDITOR: sequenceEditor } });
    const res = await outcome(root, r, `History rewritten: ${plan.commits.length} commit(s) edited.`, "Editing history");
    const after = await headOf(root);
    if (res.ok && before && after && before !== after) journal(root, "rebase-i", `Edited the history from ${plan.commits[0].short}`, { kind: "reset", from: after, to: before, mode: "keep" });
    return res;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
