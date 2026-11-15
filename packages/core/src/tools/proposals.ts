import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { writeFileAtomic } from "../atomic.js";
import { dxPath, ensureDxHome } from "../config.js";
import type { Level } from "./autonomy.js";

/**
 * What dx would do on its own but was told to ask about (or only suggest): kept until you answer.
 * "Do it" runs it through the dashboard (web/proposalsapi.ts, which checks the project and the
 * values again); "Not now" removes it and keeps dx from raising the same one for a day. The file
 * is dx's own (`~/.dx/proposals.json`, 0600); what an action carries is data dx wrote.
 */

export type ProposalKind = "gitignore-rules" | "claude-setup" | "git-fetch" | "weekly-summary";

export interface Proposal {
  id: string;
  capability: string;
  /** ask: dx waits for a yes. suggest: it is listed quietly. */
  level: Exclude<Level, "do">;
  at: string;
  project?: string;
  dir?: string;
  /** One line: "Add 3 rules to shop-website's .gitignore". */
  what: string;
  why?: string;
  action: { kind: ProposalKind; data: Record<string, unknown> };
}

interface Stored {
  items: Proposal[];
  /** capability + folder → until when dx doesn't raise it again. */
  snoozed: Record<string, number>;
}

const FILE = "proposals.json";
const MAX = 50;
export const SNOOZE_MS = 24 * 3_600_000;

const keyOf = (capability: string, dir?: string) => `${capability}|${(dir ?? "").toLowerCase()}`;

function read(): Stored {
  try {
    const raw = JSON.parse(fs.readFileSync(dxPath(FILE), "utf8")) as Partial<Stored>;
    return { items: Array.isArray(raw.items) ? raw.items.filter((p) => p && typeof p.id === "string" && typeof p.what === "string" && p.action) : [], snoozed: raw.snoozed && typeof raw.snoozed === "object" ? raw.snoozed : {} };
  } catch {
    return { items: [], snoozed: {} };
  }
}

function write(s: Stored): void {
  ensureDxHome();
  const now = Date.now();
  for (const [k, until] of Object.entries(s.snoozed)) if (until < now) delete s.snoozed[k];
  writeFileAtomic(dxPath(FILE), JSON.stringify(s, null, 2), { mode: 0o600 });
}

/**
 * Raises one, or updates the one already there for the same capability and project. Returns
 * undefined when you said "not now" to it within the last day.
 */
export function propose(p: Omit<Proposal, "id" | "at">): Proposal | undefined {
  const s = read();
  const key = keyOf(p.capability, p.dir);
  if ((s.snoozed[key] ?? 0) > Date.now()) return undefined;
  const at = s.items.findIndex((x) => keyOf(x.capability, x.dir) === key);
  const full: Proposal = { ...p, id: at >= 0 ? s.items[at].id : randomBytes(5).toString("hex"), at: new Date().toISOString() };
  if (at >= 0) s.items[at] = full;
  else s.items.push(full);
  if (s.items.length > MAX) s.items.splice(0, s.items.length - MAX);
  write(s);
  return full;
}

export function listProposals(): Proposal[] {
  return read().items;
}

/** Removes one so it can be acted on (or dismissed); `snooze` keeps dx from raising it again for a day. */
export function takeProposal(id: string, snooze = false): Proposal | undefined {
  const s = read();
  const at = s.items.findIndex((p) => p.id === id);
  if (at < 0) return undefined;
  const [p] = s.items.splice(at, 1);
  if (snooze) s.snoozed[keyOf(p.capability, p.dir)] = Date.now() + SNOOZE_MS;
  write(s);
  return p;
}

/** Drops what a capability had open (its level went back to "do", or the thing was done another way). */
export function dropProposals(capability: string): void {
  const s = read();
  const rest = s.items.filter((p) => p.capability !== capability);
  if (rest.length !== s.items.length) write({ ...s, items: rest });
}
