import fs from "node:fs";
import { dxPath, loadConfig, readRuns, recordRun, scanProjects, type RunRecord } from "@dx/core";
import { listDevServers, stopDevServer, type DevServerInfo } from "./dev.js";

/**
 * The AI lane: what an AI agent is doing through dx, live. Its calls come from ~/.dx/runs.jsonl,
 * where the MCP server writes each one as `mcp.<tool>` (see mcp/src/calls.ts), so the feed works
 * whether the dashboard was running or not and `dx runs` shows the same thing. The servers are the
 * dev servers dx runs that the agent started.
 */

export interface AiCall {
  at: string;
  tool: string;
  ok: boolean;
  text: string;
  project?: string;
  /** The project's folder, when the name is one dx knows: the page links to it. */
  dir?: string;
  args?: string;
  ms?: number;
}

export interface AiLane {
  /** An MCP call in the last few minutes, or a server the agent started is running. */
  active: boolean;
  lastCallAt?: string;
  calls: AiCall[];
  servers: DevServerInfo[];
  /** When the user last pressed Interrupt, and what it stopped. */
  interrupted?: { at: string; stopped: string[] };
}

/** How long after its last call an agent still counts as active. */
export const AI_ACTIVE_MS = 5 * 60_000;
const READ_RUNS = 600;

let cache: { sig: string; calls: AiCall[] } | undefined;
let dirs: { at: number; byName: Map<string, string> } | undefined;
let interrupted: AiLane["interrupted"];

function projectDirs(): Map<string, string> {
  if (!dirs || Date.now() - dirs.at > 30_000) {
    try {
      dirs = { at: Date.now(), byName: new Map(scanProjects(loadConfig()).map((p) => [p.name, p.dir])) };
    } catch {
      dirs = { at: Date.now(), byName: new Map() };
    }
  }
  return dirs.byName;
}

/** The agent's calls from the run log, newest first; read again only when the file changed. */
export function aiCalls(limit = 50): AiCall[] {
  let sig = "";
  try {
    const st = fs.statSync(dxPath("runs.jsonl"));
    sig = `${st.size}:${st.mtimeMs}`;
  } catch {
    return [];
  }
  if (cache?.sig !== sig) {
    const byName = projectDirs();
    const calls = readRuns(READ_RUNS)
      .filter((r: RunRecord) => r.source === "mcp" && r.tool.startsWith("mcp."))
      .reverse()
      .map((r) => {
        const c: AiCall = { at: r.at, tool: r.tool.slice(4), ok: r.ok, text: r.detail ?? r.tool.slice(4) };
        if (r.project) c.project = r.project;
        const dir = r.project ? byName.get(r.project) : undefined;
        if (dir) c.dir = dir;
        if (r.args) c.args = r.args;
        if (typeof r.ms === "number") c.ms = r.ms;
        return c;
      });
    cache = { sig, calls };
  }
  return cache.calls.slice(0, limit);
}

const alive = (s: DevServerInfo) => s.status === "starting" || s.status === "ready";

export function aiServers(): DevServerInfo[] {
  return listDevServers().filter((s) => s.startedBy === "ai" && alive(s));
}

export function aiLane(options: { limit?: number; now?: number } = {}): AiLane {
  const calls = aiCalls(options.limit ?? 50);
  const servers = aiServers();
  const last = calls[0]?.at;
  const now = options.now ?? Date.now();
  const recent = !!last && now - Date.parse(last) < AI_ACTIVE_MS;
  const lane: AiLane = { active: recent || servers.length > 0, calls, servers };
  if (last) lane.lastCallAt = last;
  if (interrupted) lane.interrupted = interrupted;
  return lane;
}

/**
 * Interrupt: stops the dev servers the agent started, the ones dx runs and nothing else. With
 * `dirs`, only those of them (the page sends the ones its dialog named). dx can't stop the agent
 * itself: it runs in the user's AI tool.
 */
export async function interruptAi(onlyDirs?: string[]): Promise<{ stopped: string[] }> {
  const norm = (d: string) => (process.platform === "win32" ? d.toLowerCase() : d);
  const wanted = onlyDirs ? new Set(onlyDirs.map(norm)) : undefined;
  const targets = aiServers().filter((s) => !wanted || wanted.has(norm(s.dir)));
  const stopped: string[] = [];
  for (const s of targets) {
    await stopDevServer(s.dir);
    stopped.push(s.project);
  }
  interrupted = { at: new Date().toISOString(), stopped };
  recordRun("ai.interrupt", true, stopped.length ? `stopped the agent's ${stopped.join(", ")}` : "nothing of the agent's was running", "web");
  return { stopped };
}

/** For tests: forget the last interrupt. */
export function forgetAiLane(): void {
  interrupted = undefined;
  cache = undefined;
  dirs = undefined;
}
