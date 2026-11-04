import path from "node:path";
import { activityMatcher, appendActivity, byTime, loadConfig, nextActivityId, pruneActivity, readActivity, type ActivityEvent, type ActivityQuery } from "@dx/core";

/**
 * The dashboard's side of the activity history (core's activity.ts): events come in from the
 * proxy, the pages' recorder script and the dev servers, are kept in memory for following along,
 * and are written to disk in batches.
 */

export type NewActivity = Omit<ActivityEvent, "id" | "at" | "project"> & { at?: string; project?: string };

const RECENT = 2000;
const recent: ActivityEvent[] = [];
let queue: ActivityEvent[] = [];
let timer: NodeJS.Timeout | undefined;
let settings: { at: number; on: boolean; days: number } | undefined;
let prunedAt = 0;

/** Whether history is kept, and for how long. Read from the config at most every few seconds. */
export function activitySettings(): { on: boolean; days: number } {
  if (!settings || Date.now() - settings.at > 5000) {
    let on = true;
    let days = 7;
    try {
      const config = loadConfig();
      on = config.activity !== false;
      days = Math.max(1, Math.min(365, Math.round(config.activityDays ?? 7)));
    } catch {
      // unreadable config: the defaults
    }
    settings = { at: Date.now(), on, days };
  }
  return settings;
}

/** After the settings change: read them again on the next event. */
export function forgetActivitySettings(): void {
  settings = undefined;
}

export function recordActivity(e: NewActivity): ActivityEvent | undefined {
  if (!activitySettings().on) return undefined;
  const now = Date.now();
  const at = e.at && !Number.isNaN(Date.parse(e.at)) ? e.at : new Date(now).toISOString();
  const event = { ...e, id: nextActivityId(now), at, project: e.project ?? path.basename(e.dir) } as ActivityEvent;
  recent.push(event);
  if (recent.length > RECENT) recent.splice(0, recent.length - RECENT);
  queue.push(event);
  if (!timer) {
    timer = setTimeout(flushActivity, 500);
    timer.unref?.();
  }
  return event;
}

/** Writes what's waiting. Also called when the process exits. */
export function flushActivity(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (queue.length) {
    const batch = queue;
    queue = [];
    try {
      appendActivity(batch);
    } catch {
      // a disk that's full or read-only: what's in memory is still listed
    }
  }
  if (Date.now() - prunedAt > 3_600_000) {
    prunedAt = Date.now();
    try {
      pruneActivity(activitySettings().days);
    } catch {
      // try again in an hour
    }
  }
}

process.on("exit", flushActivity);

/** Events for the dashboard, the CLI and agents: from memory when following along, else from disk. */
export function listActivity(q: ActivityQuery): ActivityEvent[] {
  const limit = q.limit ?? 200;
  if (q.after !== undefined && recent.length && q.after >= recent[0].id) {
    const match = activityMatcher(q);
    return byTime(recent.filter(match)).slice(-limit);
  }
  flushActivity();
  return readActivity(q);
}

/** Forgets the in-memory copy too, when a history is cleared. */
export function forgetRecentActivity(dir?: string): void {
  flushActivity();
  if (!dir) return void recent.splice(0);
  const norm = (p: string) => (process.platform === "linux" ? path.resolve(p) : path.resolve(p).toLowerCase());
  for (let i = recent.length - 1; i >= 0; i--) if (norm(recent[i].dir) === norm(dir)) recent.splice(i, 1);
}
