import { readChanges, undoChange, ChangeError, type Change } from "@dx/core";
import { HttpError, type ApiRequest } from "./api.js";

/**
 * The changes list (`GET /api/changes`, `POST /api/undo`): what dx, an AI or you changed, newest
 * first, with a way back where there is one (core/changes.ts). The page never sees how an undo
 * works, only whether there is one; `POST /api/undo` takes a change's id and nothing else, and what
 * it does comes from the record dx wrote, checked again when pressed.
 */

export interface ChangeView {
  id: string;
  at: string;
  by: Change["by"];
  kind: string;
  project?: string;
  what: string;
  why?: string;
  undoable: boolean;
  permanent: boolean;
  undone?: string;
}

export const changeView = (c: Change): ChangeView => ({
  id: c.id,
  at: c.at,
  by: c.by,
  kind: c.kind,
  project: c.project,
  what: c.what,
  why: c.why,
  undoable: !!c.undo && !c.undone,
  permanent: !!c.permanent && !c.undo,
  undone: c.undone,
});

export const changesRoutes: Record<string, (req: ApiRequest) => unknown> = {
  "GET /api/changes": (req) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.get("limit")) || 100));
    return { changes: readChanges(limit).map(changeView) };
  },
  "POST /api/undo": async (req) => {
    const id = typeof req.body.id === "string" ? req.body.id : "";
    if (!id) throw new HttpError(400, "Which change? Give its id.");
    try {
      return { change: changeView(await undoChange(id)) };
    } catch (err) {
      if (err instanceof ChangeError) throw new HttpError(err.status, err.message);
      const status = (err as { status?: number }).status;
      throw new HttpError(typeof status === "number" ? status : 400, (err as Error).message);
    }
  },
};
