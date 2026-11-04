import crypto from "node:crypto";
import type { FixProposal } from "@dx/core";

/**
 * Proposals from Ask Claude to fix, kept in this process only, by a random id. Apply takes the
 * id and uses the patch kept here: a patch never comes from the page. They expire after 30
 * minutes, and at most 20 are kept (the oldest go first).
 */

const TTL_MS = 30 * 60_000;
const MAX = 20;

interface Stored {
  dir: string;
  at: number;
  fix: FixProposal;
}

const store = new Map<string, Stored>();

function prune(now = Date.now()): void {
  for (const [id, s] of store) if (now - s.at > TTL_MS) store.delete(id);
  while (store.size > MAX) store.delete(store.keys().next().value!);
}

export function rememberFix(dir: string, fix: FixProposal): string {
  prune();
  const id = crypto.randomBytes(12).toString("hex");
  store.set(id, { dir, at: Date.now(), fix });
  prune();
  return id;
}

/** The proposal with this id, only for the project it was made for, and only while it's fresh. */
export function storedFix(id: unknown, dir: string): FixProposal | undefined {
  prune();
  if (typeof id !== "string" || !/^[0-9a-f]{24}$/.test(id)) return undefined;
  const s = store.get(id);
  return s && s.dir.toLowerCase() === dir.toLowerCase() ? s.fix : undefined;
}

export function forgetFix(id: unknown): boolean {
  return typeof id === "string" && store.delete(id);
}
