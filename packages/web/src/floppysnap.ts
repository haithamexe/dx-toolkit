import type { FloppySnapshot } from "@dx/core";
import { aiLane } from "./ai.js";
import { devErrors, listDevServers } from "./dev.js";

/**
 * What Floppy needs to pick its mood, in one small answer: the dev servers dx runs (not
 * snapshots), the newest error that hasn't been fixed, and whether an AI agent is at work.
 */
export function floppySnapshot(): FloppySnapshot {
  const servers = listDevServers()
    .filter((s) => !s.snapshot)
    .map((s) => ({
      project: s.project,
      dir: s.dir,
      status: s.status,
      startedBy: s.startedBy,
      errorCount: s.errorCount,
      url: s.localUrl ?? s.url,
      step: s.status === "starting" ? s.prepare?.find((p) => p.status === "running")?.title : undefined,
    }));
  const snapshot: FloppySnapshot = { dashboard: true, servers };
  for (const s of servers.filter((x) => x.errorCount > 0 && x.status !== "stopped")) {
    const e = devErrors(s.dir)[0]?.errors.find((x) => !x.resolved);
    if (e) {
      snapshot.error = { project: s.project, dir: s.dir, id: e.id, message: e.message, file: e.file, line: e.line };
      break;
    }
  }
  const lane = aiLane({ limit: 1 });
  snapshot.ai = { active: lane.active, text: lane.calls[0]?.text, project: lane.calls[0]?.project ?? lane.servers.find((s) => s.status !== "stopped")?.project };
  return snapshot;
}
