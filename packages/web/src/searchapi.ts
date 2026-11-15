import { readFileWindow, scanProjectsCached, loadConfig, searchProject, searchProjects, type SearchMode } from "@dx/core";
import { HttpError, knownProject, type ApiRequest } from "./api.js";

/**
 * Code search (`GET /api/search`, `GET /api/search/preview`): file names and file contents of one known
 * project, or of every project dx knows. Read-only. What is searched is only what git lists for the
 * project's folder, secrets files are never read, and the preview serves only a file that search could
 * have found (core/codesearch.ts has the rules). The words searched for are never kept or logged.
 */

const MODES = new Set<SearchMode>(["all", "files", "content"]);
const flag = (v: string | null) => v === "1" || v === "true";

function list(v: string | null, pattern: RegExp, max = 10): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => pattern.test(s))
    .slice(0, max);
}

export const searchRoutes: Record<string, (req: ApiRequest) => unknown> = {
  "GET /api/search": async (req) => {
    const q = (req.query.get("q") ?? "").slice(0, 200);
    const mode = (req.query.get("mode") ?? "all") as SearchMode;
    if (!MODES.has(mode)) throw new HttpError(400, "Search files, content, or both: mode is files, content or all.");
    const cs = req.query.get("case");
    const options = {
      query: q,
      mode,
      caseSensitive: cs === "1" ? true : cs === "0" ? false : undefined,
      wholeWord: flag(req.query.get("word")),
      regex: flag(req.query.get("regex")),
      ext: list(req.query.get("ext"), /^[a-z0-9]{1,10}$/i),
      folders: list(req.query.get("folder"), /^[^\0:*?"<>|]{1,200}$/).filter((f) => !f.split(/[\/]/).includes("..")),
      maxFiles: 100,
    };
    if (req.query.get("scope") === "all") {
      const projects = scanProjectsCached(loadConfig()).map((p) => ({ name: p.name, dir: p.dir }));
      return { scope: "all", ...(await searchProjects(projects, options)) };
    }
    const project = knownProject(req.query.get("dir"), { snapshots: true });
    return { scope: "project", project: project.name, dir: project.dir, ...(await searchProject(project.dir, options)) };
  },
  // A window of a found file, for the preview beside the results.
  "GET /api/search/preview": async (req) => {
    const project = knownProject(req.query.get("dir"), { snapshots: true });
    const line = Math.max(1, Math.min(Number(req.query.get("line")) || 1, 10_000_000));
    const around = Math.max(3, Math.min(Number(req.query.get("around")) || 20, 100));
    const w = await readFileWindow(project.dir, String(req.query.get("file") ?? ""), line - around, line + around);
    if (!w) throw new HttpError(404, "That file can't be previewed: it isn't one of the project's files, or it isn't text dx shows.");
    return { ...w, line };
  },
};
