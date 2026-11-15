import { loadConfig, saveConfig, type DxConfig } from "../config.js";

/**
 * How much dx does on its own, one choice per thing it can do without being asked:
 *
 *   suggest  dx notes that it could, quietly, and does nothing
 *   ask      dx asks first, with a button, each time (one question per project)
 *   do       dx does it and lists it under Recent changes, with Undo where there is one
 *
 * Only things dx already does by itself are here, and each can go down to "suggest" at any time.
 * What dx never does by itself stays out: running Claude Code (it runs only on a button), pushing,
 * releasing, deleting. The defaults are what dx did before the choice existed.
 */

export type Level = "suggest" | "ask" | "do";
export const LEVELS: Level[] = ["suggest", "ask", "do"];

export interface Capability {
  id: string;
  title: string;
  /** One line: what it does and what it never does. */
  what: string;
  default: Level;
  /** Whether what it does can be taken back from Recent changes. */
  undoable: boolean;
}

export const CAPABILITIES: Capability[] = [
  { id: "gitignore-rules", title: "Secret rules in .gitignore", what: "When a new project has a .env git would pick up, adds the rules that keep it out (only those rules, only added).", default: "do", undoable: true },
  { id: "claude-setup", title: "Pointing Claude Code at dx", what: "In a new project, local files that make its Claude Code sessions run and test through dx (never committed).", default: "do", undoable: true },
  { id: "git-fetch", title: "Fetching remotes", what: "Every few minutes for the projects you work in: git fetch, so \"behind\" is true. Never a merge, pull or push.", default: "do", undoable: false },
  { id: "weekly-summary", title: "Saving your weekly summary", what: "Writes last week's summary to ~/.dx/summaries on Monday. No network.", default: "do", undoable: false },
];

const byId = new Map(CAPABILITIES.map((c) => [c.id, c]));

export const capability = (id: string): Capability | undefined => byId.get(id);
export const isLevel = (v: unknown): v is Level => typeof v === "string" && (LEVELS as string[]).includes(v);

/** The level chosen for a capability, else its default. An unknown id is "suggest": it does nothing on its own. */
export function levelOf(id: string, config: Pick<DxConfig, "autonomy"> = loadConfig()): Level {
  const c = byId.get(id);
  if (!c) return "suggest";
  const chosen = config.autonomy?.[id];
  return isLevel(chosen) ? chosen : c.default;
}

/** Every capability with the level in force, for the Settings page and AI agents. */
export function autonomyState(config: Pick<DxConfig, "autonomy"> = loadConfig()): (Capability & { level: Level })[] {
  return CAPABILITIES.map((c) => ({ ...c, level: levelOf(c.id, config) }));
}

/** Sets one capability's level; returns the level it had. Choosing the default removes the entry, so the file stays small. */
export function setLevel(id: string, level: unknown): { previous: Level } {
  const c = byId.get(id);
  if (!c) throw new Error(`dx can't do "${id}" on its own, so there is nothing to set.`);
  if (!isLevel(level)) throw new Error(`The level is suggest, ask or do.`);
  const config = loadConfig();
  const previous = levelOf(id, config);
  const next = { ...(config.autonomy ?? {}) };
  if (level === c.default) delete next[id];
  else next[id] = level;
  saveConfig({ ...config, autonomy: Object.keys(next).length ? next : undefined });
  return { previous };
}
