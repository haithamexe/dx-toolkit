import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { dxPath, ensureDxHome } from "../config.js";
import { writeFileAtomic } from "../atomic.js";

/**
 * What was sent to an AI, written down when it is sent: which feature, for which project, what
 * went (a label and a size for each part, never the text itself), and what came of it. "AI activity
 * today" on the Recent changes page reads it. dx sends nothing to an AI by itself: every use here
 * was a button you pressed, so the list is also the proof of that.
 */

export type AiFeature = "fix" | "commit-message" | "tool-chat" | "mock-data";
export type AiOutcome = "proposed" | "applied" | "dismissed" | "used" | "nothing" | "failed";

export interface SentPart {
  label: string;
  bytes: number;
}

export interface AiUse {
  id: string;
  at: string;
  feature: AiFeature;
  project?: string;
  /** Which tool answered: claude or codex. */
  tool?: string;
  sent: SentPart[];
  outcome: AiOutcome;
}

const FILE = "ai-uses.jsonl";
const KEEP = 300;

const read = (): AiUse[] => {
  try {
    return fs
      .readFileSync(dxPath(FILE), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as AiUse];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
};

/** Writes one down; never throws. Part labels are clipped, and only labels and sizes are kept. */
export function recordAiUse(use: Omit<AiUse, "id" | "at">): AiUse {
  const full: AiUse = {
    id: `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`,
    at: new Date().toISOString(),
    ...use,
    sent: use.sent.slice(0, 20).map((p) => ({ label: String(p.label).slice(0, 120), bytes: Math.max(0, Math.round(p.bytes)) })),
  };
  try {
    ensureDxHome();
    fs.appendFileSync(dxPath(FILE), `${JSON.stringify(full)}\n`, { mode: 0o600 });
    const all = read();
    if (all.length > KEEP + 50) writeFileAtomic(dxPath(FILE), all.slice(-KEEP).map((u) => JSON.stringify(u)).join("\n") + "\n", { mode: 0o600 });
  } catch {
    // a log must not break what it logs
  }
  return full;
}

/** What came of a use: the patch was applied, the message was used, it was dismissed. */
export function setAiOutcome(id: string, outcome: AiOutcome): void {
  try {
    const all = read();
    const hit = all.find((u) => u.id === id);
    if (!hit) return;
    hit.outcome = outcome;
    writeFileAtomic(dxPath(FILE), all.map((u) => JSON.stringify(u)).join("\n") + "\n", { mode: 0o600 });
  } catch {
    // as above
  }
}

/** The uses since a moment, newest first. */
export function readAiUses(sinceMs = Date.now() - 24 * 3_600_000, limit = 50): AiUse[] {
  return read()
    .filter((u) => Date.parse(u.at) >= sinceMs)
    .reverse()
    .slice(0, limit);
}
