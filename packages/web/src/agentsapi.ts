import { agentSummary, loadConfig, readAgents, scanProjects } from "@dx/core";
import type { ApiRequest } from "./api.js";

/**
 * The agents on this computer (`GET /api/agents`): Claude Code's sessions and the subagents they
 * started, read from its session files by core/agents.ts: metadata only (names of tools, models,
 * titles, times, folders), never a message. Read-only; the folder of an agent is matched to the
 * projects dx knows, nothing is taken from the request except how far back to look.
 */
export const agentsRoutes: Record<string, (req: ApiRequest) => unknown> = {
  "GET /api/agents": (req) => {
    const asked = Number(req.query.get("hours"));
    const hours = Number.isFinite(asked) && asked >= 1 ? Math.min(24 * 14, asked) : 24;
    const agents = readAgents({ sinceHours: hours, projects: scanProjects(loadConfig()).map((p) => ({ name: p.name, dir: p.dir })) });
    return { at: new Date().toISOString(), hours, agents, summary: agentSummary(agents) };
  },
};
