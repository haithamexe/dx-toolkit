import { exportState, importState, lastStateImport, loadConfig, planStateImport, readState, recordRun, scanProjects, stateSummary, StateError, undoStateImport } from "@dx/core";
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
  "GET /api/state/last": () => ({ last: lastStateImport() ?? null }),
  "POST /api/state/undo": () => {
    const r = call(() => undoStateImport());
    forgetAlertTools();
    recordRun("state", true, `undid the import of ${r.at}`, "web");
    return r;
  },
};
