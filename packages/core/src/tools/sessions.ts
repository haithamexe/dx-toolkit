import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { dxPath, ensureDxHome } from "../config.js";
import { readJournal, type JournalEntry } from "./journal.js";
import type { Project } from "./projects.js";

/**
 * Where you left off in each project: when you last worked on it, on which branch, what was
 * running, and a note on what you (or your AI agent) were in the middle of. Kept in
 * ~/.dx/sessions.json, so `dx go`, `dx resume` and the resume_project MCP tool can bring it back.
 */

export interface ProjectSession {
  name: string;
  /** Last time dx saw work on it: a dx go, a dev server starting or stopping, a note. */
  at: string;
  branch?: string;
  head?: string;
  /** The services that were running, or ["dev"] for a plain dev server. */
  ran?: string[];
  /** Errors still open when the dev server stopped. */
  openErrors?: string[];
  /** What you were in the middle of, or the next step. */
  note?: string;
  noteBy?: "you" | "ai";
  noteAt?: string;
}

export interface ResumeInfo {
  project: string;
  dir: string;
  session?: ProjectSession;
  /** How long since then, in ms. */
  away?: number;
  branch?: string;
  /** The branch then, when it isn't the one checked out now. */
  branchThen?: string;
  /** Commits since then (by anyone, on this branch). */
  newCommits: number;
  lastCommit?: { subject: string; at: string };
  uncommitted: string[];
  /** Recent journal entries that mention the project. */
  journal: JournalEntry[];
}

const FILE = "sessions.json";
const MAX_NOTE = 2000;

type Store = Record<string, ProjectSession>;

function key(dir: string): string {
  return process.platform === "linux" ? dir : dir.toLowerCase();
}

function load(): Store {
  try {
    return JSON.parse(fs.readFileSync(dxPath(FILE), "utf8")) as Store;
  } catch {
    return {};
  }
}

function save(store: Store): void {
  ensureDxHome();
  const tmp = dxPath(`${FILE}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, dxPath(FILE));
}

export function readSession(dir: string): ProjectSession | undefined {
  return load()[key(dir)];
}

/** Reads the file once, for looking up many projects. */
export function sessionLookup(): (dir: string) => ProjectSession | undefined {
  const store = load();
  return (dir) => store[key(dir)];
}

/** Records work on a project now, with its current branch and commit. */
export function rememberSession(dir: string, name: string, patch: Partial<ProjectSession> = {}): ProjectSession {
  const store = load();
  const k = key(dir);
  const { branch, head } = gitHere(dir);
  const next: ProjectSession = { ...store[k], ...patch, name, at: new Date().toISOString(), ...(branch ? { branch } : {}), ...(head ? { head } : {}) };
  store[k] = next;
  try {
    save(store);
  } catch {
    // Remembering must never break the thing being remembered.
  }
  return next;
}

/** Leaves a note on where things stand; an empty note removes it. */
export function leaveNote(dir: string, name: string, note: string, by: "you" | "ai"): ProjectSession {
  const text = note.trim().slice(0, MAX_NOTE);
  return rememberSession(dir, name, text ? { note: text, noteBy: by, noteAt: new Date().toISOString() } : { note: undefined, noteBy: undefined, noteAt: undefined });
}

export function resumeInfo(project: Pick<Project, "name" | "dir">): ResumeInfo {
  const session = readSession(project.dir);
  const info: ResumeInfo = { project: project.name, dir: project.dir, session, newCommits: 0, uncommitted: [], journal: [] };
  if (session) info.away = Date.now() - Date.parse(session.at);
  const now = gitHere(project.dir);
  info.branch = now.branch;
  if (session?.branch && now.branch && session.branch !== now.branch) info.branchThen = session.branch;
  if (now.branch) {
    const last = git(project.dir, ["log", "-1", "--format=%s%x09%cI"]);
    if (last) {
      const [subject, at] = last.split("\t");
      info.lastCommit = { subject, at };
    }
    if (session?.head && now.head && session.head !== now.head) {
      info.newCommits = Number(git(project.dir, ["rev-list", "--count", `${session.head}..HEAD`]) ?? 0) || 0;
    }
    info.uncommitted = (git(project.dir, ["status", "--porcelain"]) ?? "")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3));
  }
  const name = project.name.toLowerCase();
  info.journal = readJournal({ sinceDays: 60 })
    .filter((e) => e.text.toLowerCase().includes(name))
    .slice(-3);
  return info;
}

function gitHere(dir: string): { branch?: string; head?: string } {
  const branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = git(dir, ["rev-parse", "--short", "HEAD"]);
  return { branch: branch && branch !== "HEAD" ? branch : undefined, head };
}

function git(dir: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim() || undefined;
  } catch {
    return undefined;
  }
}
