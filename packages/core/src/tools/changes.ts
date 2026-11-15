import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { writeFileAtomic } from "../atomic.js";
import { dxPath, ensureDxHome, loadConfig, saveConfig, type DxConfig } from "../config.js";
import { undoClaudeSetup } from "./agentsetup.js";
import { isLevel, setLevel } from "./autonomy.js";
import { removeGitignoreRules, writeEnvFile } from "./envaudit.js";
import { gitUndo } from "./gitops.js";
import { findKnownProject } from "./projects.js";

/**
 * Everything dx, an AI or you changed, in one list with a way back where there is one
 * (`~/.dx/changes.jsonl`, the newest 500). Each change that can be taken back says how, in data dx
 * wrote itself: what the undo needs is checked again when it's pressed (the project must still be
 * one dx knows, a file must still be what dx left), never taken on trust from the request.
 *
 * Not every change has an undo, and that is said plainly: a push or a release is `permanent`.
 */

export type ChangeBy = "dx" | "ai" | "you";

export type UndoKind = "gitignore-rules" | "claude-setup" | "config" | "env-file" | "git-undo" | "autonomy";

export interface Change {
  id: string;
  at: string;
  by: ChangeBy;
  kind: string;
  project?: string;
  dir?: string;
  /** One line: "Added 3 lines to .gitignore". */
  what: string;
  /** Why dx did it, in a few words. */
  why?: string;
  undo?: { kind: UndoKind; data: Record<string, unknown> };
  /** Nothing can take it back (a push, a release). */
  permanent?: boolean;
  /** When it was taken back. */
  undone?: string;
}

export class ChangeError extends Error {
  readonly status = 400;
}

const FILE = "changes.jsonl";
const KEEP = 500;
const BACKUP_DAYS = 7;

function readAll(): Change[] {
  try {
    return fs
      .readFileSync(dxPath(FILE), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Change];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function writeAll(list: Change[]): void {
  ensureDxHome();
  writeFileAtomic(dxPath(FILE), list.map((c) => JSON.stringify(c)).join("\n") + (list.length ? "\n" : ""), { mode: 0o600 });
}

const actorStore = new AsyncLocalStorage<ChangeBy>();

/**
 * Runs `fn` as someone: while it (and what it awaits) runs, a change written as "you" is written as
 * the actor instead. The dashboard wraps a request from an AI tool's dx server as "ai", so what an
 * agent changes through dx is listed as the agent's without every route knowing who asked.
 */
export function withActor<T>(actor: ChangeBy, fn: () => T): T {
  return actorStore.run(actor, fn);
}

const listeners = new Set<(change: Change) => void>();

/** Calls `fn` for every change written from now on (the dashboard turns them into live events). Returns how to stop. */
export function onChange(fn: (change: Change) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Writes a change down; never throws (a log must not break what it logs). */
export function recordChange(change: Omit<Change, "id" | "at">): Change {
  const full: Change = { id: `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`, at: new Date().toISOString(), ...change };
  if (full.by === "you" && actorStore.getStore() === "ai") full.by = "ai";
  setImmediate(() => {
    for (const fn of listeners) {
      try {
        fn(full);
      } catch {
        // a listener must not break the change
      }
    }
  });
  try {
    ensureDxHome();
    fs.appendFileSync(dxPath(FILE), `${JSON.stringify(full)}\n`, { mode: 0o600 });
    const all = readAll();
    if (all.length > KEEP + 100) writeAll(all.slice(-KEEP));
    pruneBackups();
  } catch {
    // the change itself happened; only the note of it failed
  }
  return full;
}

/** The newest changes first. */
export function readChanges(limit = 50): Change[] {
  return readAll().reverse().slice(0, limit);
}

// ---- backups of what a change overwrote (a .env), readable only by you, kept a week

const backupFile = (id: string) => dxPath("changes-backups", `${id.replace(/[^a-z0-9]/gi, "")}.bak`);

/** Keeps the text a change is about to replace; returns the id to put in the change's undo data. */
export function backupText(text: string): string {
  const id = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  fs.mkdirSync(dxPath("changes-backups"), { recursive: true });
  fs.writeFileSync(backupFile(id), text, { mode: 0o600 });
  return id;
}

function pruneBackups(): void {
  try {
    const dir = dxPath("changes-backups");
    for (const f of fs.readdirSync(dir)) {
      const full = `${dir}/${f}`;
      if (Date.now() - fs.statSync(full).mtimeMs > BACKUP_DAYS * 86_400_000) fs.rmSync(full, { force: true });
    }
  } catch {
    // no backups yet
  }
}

// ---- config, for the Settings page's changes

/** The settings that can be put back, with the type each must have. */
const CONFIG_KEYS: Record<string, "boolean" | "number" | "string"> = {
  editor: "string",
  githubUser: "string",
  scanDepth: "number",
  terminal: "string",
  activity: "boolean",
  envAlerts: "boolean",
  agentAlerts: "boolean",
  localhostRecording: "boolean",
  visualDiff: "boolean",
  activityDays: "number",
  activityMaxMB: "number",
};

/** What the settings were for the keys that differ in `after`: null where a key wasn't set. */
export function configBefore(before: DxConfig, after: DxConfig): { previous: Record<string, unknown>; changed: string[] } {
  const previous: Record<string, unknown> = {};
  const changed: string[] = [];
  for (const key of Object.keys(CONFIG_KEYS)) {
    const a = (before as unknown as Record<string, unknown>)[key];
    const b = (after as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      previous[key] = a ?? null;
      changed.push(key);
    }
  }
  return { previous, changed };
}

function restoreConfig(previous: unknown): void {
  if (!previous || typeof previous !== "object") throw new ChangeError("There is nothing to put back.");
  const config = loadConfig() as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(previous as Record<string, unknown>)) {
    const type = CONFIG_KEYS[key];
    if (!type) continue;
    if (value === null) config[key] = undefined;
    else if (typeof value === type) config[key] = value;
  }
  saveConfig(config as unknown as DxConfig);
}

// ---- undo

function knownDir(data: Record<string, unknown>): { dir: string; name: string } {
  const dir = typeof data.dir === "string" ? data.dir : "";
  const project = dir ? findKnownProject(dir) : undefined;
  if (!project) throw new ChangeError("That project isn't in your projects folders any more.");
  return { dir: project.dir, name: project.name };
}

async function runUndo(undo: NonNullable<Change["undo"]>): Promise<void> {
  const data = undo.data;
  switch (undo.kind) {
    case "gitignore-rules": {
      const { dir } = knownDir(data);
      const lines = Array.isArray(data.lines) ? data.lines.filter((l): l is string => typeof l === "string") : [];
      if (!removeGitignoreRules(dir, lines, data.created === true)) throw new ChangeError("The .gitignore has changed since: there's nothing of dx's left to take out.");
      return;
    }
    case "claude-setup": {
      const project = knownDir(data);
      if (!undoClaudeSetup(project, "web").length) throw new ChangeError("Nothing of dx's is left to remove there.");
      return;
    }
    case "config":
      return restoreConfig(data.previous);
    case "autonomy": {
      const id = typeof data.id === "string" ? data.id : "";
      if (!isLevel(data.previous)) throw new ChangeError("There is nothing to put back.");
      try {
        setLevel(id, data.previous);
      } catch (err) {
        throw new ChangeError((err as Error).message);
      }
      return;
    }
    case "env-file": {
      const { dir } = knownDir(data);
      const name = typeof data.name === "string" ? data.name : "";
      let text: string;
      try {
        text = fs.readFileSync(backupFile(String(data.backup ?? "")), "utf8");
      } catch {
        throw new ChangeError("The earlier version of that file isn't kept any more (backups last a week).");
      }
      try {
        writeEnvFile(dir, name, text);
      } catch (err) {
        throw new ChangeError((err as Error).message);
      }
      return;
    }
    case "git-undo": {
      const { dir } = knownDir(data);
      await gitUndo(dir, String(data.id ?? ""));
      return;
    }
  }
}

/** Takes a change back, once. */
export async function undoChange(id: string): Promise<Change> {
  const all = readAll();
  const change = all.find((c) => c.id === id);
  if (!change) throw new ChangeError("That change isn't in the list any more.");
  if (change.undone) throw new ChangeError("That change was already taken back.");
  if (!change.undo) throw new ChangeError(change.permanent ? "That can't be undone from dx." : "That one has no undo.");
  await runUndo(change.undo);
  change.undone = new Date().toISOString();
  writeAll(all);
  recordChange({ by: "you", kind: "undo", project: change.project, dir: change.dir, what: `Undid: ${change.what}` });
  return change;
}
