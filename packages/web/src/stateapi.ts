import { cloneProject, exportState, isValidProjectName, repoName, importState, lastStateImport, loadConfig, planStateImport, readState, recordRun, scanProjects, stateSummary, StateError, undoStateImport } from "@dx/core";
import { HttpError, type ApiRequest } from "./api.js";
import { forgetAlertTools } from "./toolsapi.js";

/**
 * dx's state as one file, for another computer (core/state.ts): Export builds it from what dx keeps
 * (plus the page's own preferences, which only it knows); Import reads a file strictly, says what
 * it would do, then brings it in after backing up every file it touches; Undo puts those back.
 * Projects are only ever ones dx finds here, never a path from the request.
 */

function call<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof StateError) throw new HttpError(err.status, err.message);
    throw err;
  }
}

async function callAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StateError) throw new HttpError(err.status, err.message);
    throw err;
  }
}

// Folders being cloned now, so a double click can't start two that delete each other's work.
const cloning = new Set<string>();

export const stateRoutes: Record<string, (req: ApiRequest) => unknown> = {
  "POST /api/state/export": async (req) => {
    const state = await exportState({ projects: scanProjects(loadConfig()), page: req.body.page as Record<string, unknown> | undefined });
    recordRun("state", true, `exported ${stateSummary(state)}`, "web");
    return state;
  },
  "POST /api/state/import/check": (req) => {
    const state = call(() => readState(req.body.file));
    return callAsync(() => planStateImport(state, scanProjects(loadConfig())));
  },
  "POST /api/state/import": async (req) => {
    const state = call(() => readState(req.body.file));
    const raw = req.body.map;
    const map: Record<string, string | null> = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (/^\d{1,4}$/.test(k) && (v === null || typeof v === "string")) map[k] = v;
    }
    const r = await callAsync(() => importState(state, { projects: scanProjects(loadConfig()), map, settings: req.body.settings !== false }));
    forgetAlertTools();
    recordRun("state", true, `imported ${r.projects.length} project${r.projects.length === 1 ? "" : "s"}${r.skipped.length ? ` (${r.skipped.length} not on this computer)` : ""}`, "web");
    return r;
  },
  // Clones one project of the file that isn't on this computer (its remote, as https), on the person's click. Only the clone: no packages are installed, since the file isn't code dx should run installs for.
  "POST /api/state/import/clone": async (req) => {
    const state = call(() => readState(req.body.file));
    const index = Number(req.body.index);
    if (!Number.isInteger(index) || index < 0) throw new HttpError(400, "Which project of the file?");
    const plan = await callAsync(() => planStateImport(state, scanProjects(loadConfig())));
    const entry = plan.projects[index];
    if (!entry) throw new HttpError(404, "The file has no such project.");
    if (entry.match) throw new HttpError(409, `${entry.name} is already here (${entry.match.name}).`);
    if (!entry.cloneUrl) throw new HttpError(400, `${entry.name} has no repository address to clone from.`);
    // A name with capitals or spaces can't be a folder: the repository's own name is used then.
    const folder = isValidProjectName(entry.name) ? entry.name : repoName(entry.cloneUrl).toLowerCase();
    if (cloning.has(folder)) throw new HttpError(409, `${folder} is already being cloned.`);
    cloning.add(folder);
    try {
      const r = await cloneProject({ url: entry.cloneUrl, name: folder, install: false, source: "web" });
      recordRun("state", true, `cloned ${entry.name} for the import`, "web");
      return { ok: true, name: r.name, dir: r.dir, next: "Set it up from All projects (install its packages) when you want to run it." };
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    } finally {
      cloning.delete(folder);
    }
  },
  "GET /api/state/last": () => ({ last: lastStateImport() ?? null }),
  "POST /api/state/undo": () => {
    const r = call(() => undoStateImport());
    forgetAlertTools();
    recordRun("state", true, `undid the import of ${r.at}`, "web");
    return r;
  },
};
