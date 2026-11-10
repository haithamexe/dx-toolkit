import { writeFileAtomic } from "./atomic.js";
import fs from "node:fs";
import { dxPath, ensureDxHome } from "./config.js";

/** One line per tool run in ~/.dx/runs.jsonl, so a failed or silent run is never invisible. */
export interface RunRecord {
  at: string;
  tool: string;
  ok: boolean;
  detail?: string;
  source?: string;
  /** Which project the run was about, when there was one. */
  project?: string;
  /** How long it ran, e.g. how long a dev server was up, or how long an AI agent's call took. */
  ms?: number;
  /** For an AI agent's call through the MCP server: a short, secret-free summary of its arguments. */
  args?: string;
}

export interface RunExtra {
  project?: string;
  ms?: number;
  args?: string;
}

const RUNS_FILE = "runs.jsonl";
const MAX_BYTES = 1_000_000;

export function recordRun(tool: string, ok: boolean, detail?: string, source = "cli", extra: RunExtra = {}): void {
  try {
    ensureDxHome();
    const file = dxPath(RUNS_FILE);
    const line: RunRecord = { at: new Date().toISOString(), tool, ok, source, ...(detail ? { detail } : {}), ...extra };
    fs.appendFileSync(file, JSON.stringify(line) + "\n", "utf8");
    trimIfLarge(file);
  } catch {
    // The run log must never break the tool that is being logged.
  }
}

export function readRuns(limit = 30): RunRecord[] {
  // limit 0 reads every line.
  const file = dxPath(RUNS_FILE);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const out: RunRecord[] = [];
  for (const line of limit > 0 ? lines.slice(-limit) : lines) {
    try {
      out.push(JSON.parse(line) as RunRecord);
    } catch {
      // skip a corrupted line rather than failing the whole read
    }
  }
  return out;
}

function trimIfLarge(file: string): void {
  const size = fs.statSync(file).size;
  if (size <= MAX_BYTES) return;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  // Other processes (an AI tool's MCP server) append to this file: replacing it whole, never truncating it in place, can lose
  // at most a line written in the same instant. If the file is busy (Windows), it's trimmed on a later write instead.
  try {
    writeFileAtomic(file, lines.slice(Math.floor(lines.length / 2)).join("\n") + "\n", { direct: false });
  } catch {
    // too busy to replace now; the next write tries again
  }
}
