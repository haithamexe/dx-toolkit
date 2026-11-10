import { agentsReadable, auditEnvAsync, findKnownProject, loadConfig, loadTools, readAgents, readDataSchema, scanProjectsCached } from "@dx/core";
import type { ApiRequest } from "./api.js";

/**
 * What the sidebar needs to know to show only pages that have something in them (`GET /api/nav`):
 * the agents on this computer, the project's own tools, whether a data schema was found, and how
 * many .env problems the project has. Counts only: no names, no values. The env look is kept for
 * 30 seconds per project, since it runs git; the agents are read the way the Agents page reads them.
 */
const envKept = new Map<string, { at: number; problems: number }>();

export const navRoutes: Record<string, (req: ApiRequest) => unknown> = {
  "GET /api/nav": async (req) => {
    const dir = String(req.query.get("dir") ?? "");
    const project = dir ? findKnownProject(dir) : undefined;
    let agents = 0;
    if (agentsReadable()) {
      try {
        agents = readAgents({ sinceHours: 24, projects: scanProjectsCached(loadConfig()).map((p) => ({ name: p.name, dir: p.dir })) }).length;
      } catch {
        // unreadable: nothing to show
      }
    }
    if (!project) return { agents, tools: 0, data: false, env: 0 };
    const key = project.dir.toLowerCase();
    let kept = envKept.get(key);
    if (!kept || Date.now() - kept.at > 30_000) {
      const audit = await auditEnvAsync(project.dir, { secrets: false }).catch(() => undefined);
      // Only real exposure counts (a .env git would commit, or has): missing .gitignore rules alone aren't worth a badge.
      kept = { at: Date.now(), problems: audit ? audit.files.filter((f) => f.tracked || f.notIgnored).length : 0 };
      envKept.set(key, kept);
    }
    let tools = 0;
    try {
      tools = loadTools(project.dir).length;
    } catch {
      // a tools file that can't be read: none to show
    }
    return { agents, tools, data: !!readDataSchema(project.dir), env: kept.problems };
  },
};
