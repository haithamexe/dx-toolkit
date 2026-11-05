import type { PageCheck } from "./browser.js";
import { foldPath } from "./mocks.js";

/**
 * Behaviour diff: the same page (and the same clicks) loaded on two versions of an app, the
 * calls it made, its errors and its console compared. "This version calls /api/cart twice more
 * and logs a new warning." Screenshots show what changed on screen; this shows what changed
 * underneath. Addresses are compared by path, folded (/orders/42 → /orders/:id), since the two
 * versions run at different ports.
 */

export type ChangeKind = "call-added" | "call-removed" | "call-count" | "status" | "error-new" | "error-gone" | "warning-new" | "warning-gone" | "step" | "page";

export interface BehaviourChange {
  kind: ChangeKind;
  /** "worse", "better" or a plain change. */
  tone: "worse" | "better" | "change";
  text: string;
}

export interface CallSummary {
  key: string;
  count: number;
  statuses: string[];
}

export interface BehaviourDiff {
  /** The page and steps that were compared. */
  path: string;
  changes: BehaviourChange[];
  before: { calls: CallSummary[]; errors: number; ok: boolean };
  after: { calls: CallSummary[]; errors: number; ok: boolean };
  same: boolean;
}

const INTERNAL = /^\/(__dx\/|@vite\/|@id\/|@fs\/|node_modules\/|__vite|_next\/(static|webpack)|sockjs-node|__webpack_hmr|favicon\.ico)/;

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split("?")[0];
  }
}

/** The page's API calls, by method and folded path, with how often and what they answered. */
export function callsOf(check: PageCheck): CallSummary[] {
  const map = new Map<string, CallSummary>();
  for (const r of check.requests ?? []) {
    if (r.type === "Document") continue;
    const p = pathOf(r.url);
    if (INTERNAL.test(p)) continue;
    const key = `${(r.method ?? "GET").toUpperCase()} ${foldPath(p)}`;
    const s = map.get(key) ?? { key, count: 0, statuses: [] };
    s.count++;
    const status = r.status ? String(r.status) : r.error ? "failed" : "?";
    if (!s.statuses.includes(status)) s.statuses.push(status);
    map.set(key, s);
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

const shape = (s: string) => s.split("\n")[0].replace(/https?:\/\/[^/\s]+/g, "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 200);
const bad = (statuses: string[]) => statuses.some((s) => s === "failed" || Number(s) >= 400);

function messages(check: PageCheck, which: "errors" | "warnings"): Map<string, string> {
  const list = which === "errors" ? [...check.exceptions, ...check.consoleErrors, ...(check.overlay ? [{ text: `Error overlay: ${check.overlay}` }] : [])] : check.consoleWarnings;
  const out = new Map<string, string>();
  for (const m of list) out.set(shape(m.text), m.text.split("\n")[0].slice(0, 300));
  return out;
}

/** What changed between the page as it was (`before`) and as it is (`after`). */
export function compareBehaviour(before: PageCheck, after: PageCheck, path = pathOf(after.url)): BehaviourDiff {
  const changes: BehaviourChange[] = [];
  const a = callsOf(before);
  const b = callsOf(after);
  const am = new Map(a.map((c) => [c.key, c]));
  const bm = new Map(b.map((c) => [c.key, c]));
  for (const c of b) {
    const old = am.get(c.key);
    if (!old) changes.push({ kind: "call-added", tone: bad(c.statuses) ? "worse" : "change", text: `New call: ${c.key}${c.count > 1 ? ` (${c.count} times)` : ""} → ${c.statuses.join(", ")}` });
    else {
      if (old.count !== c.count) changes.push({ kind: "call-count", tone: c.count > old.count ? "worse" : "better", text: `${c.key} is called ${c.count} time${c.count === 1 ? "" : "s"}, was ${old.count}` });
      if (old.statuses.join() !== c.statuses.join()) {
        const worse = bad(c.statuses) && !bad(old.statuses);
        const better = !bad(c.statuses) && bad(old.statuses);
        changes.push({ kind: "status", tone: worse ? "worse" : better ? "better" : "change", text: `${c.key} answers ${c.statuses.join(", ")}, was ${old.statuses.join(", ")}` });
      }
    }
  }
  for (const c of a) if (!bm.has(c.key)) changes.push({ kind: "call-removed", tone: "change", text: `No longer called: ${c.key}` });

  const ae = messages(before, "errors");
  const be = messages(after, "errors");
  for (const [k, text] of be) if (!ae.has(k)) changes.push({ kind: "error-new", tone: "worse", text: `New error: ${text}` });
  for (const [k, text] of ae) if (!be.has(k)) changes.push({ kind: "error-gone", tone: "better", text: `Gone: ${text}` });
  const aw = messages(before, "warnings");
  const bw = messages(after, "warnings");
  for (const [k, text] of bw) if (!aw.has(k)) changes.push({ kind: "warning-new", tone: "worse", text: `New warning: ${text}` });
  for (const [k, text] of aw) if (!bw.has(k)) changes.push({ kind: "warning-gone", tone: "better", text: `Warning gone: ${text}` });

  if ((before.status ?? 200) !== (after.status ?? 200)) changes.push({ kind: "page", tone: (after.status ?? 200) >= 400 ? "worse" : "change", text: `The page answers ${after.status ?? "nothing"}, was ${before.status ?? "nothing"}` });
  if (!!before.error !== !!after.error) changes.push({ kind: "page", tone: after.error ? "worse" : "better", text: after.error ? `The page didn't load: ${after.error}` : `The page loads again (was: ${before.error})` });
  if ((before.title ?? "") !== (after.title ?? "")) changes.push({ kind: "page", tone: "change", text: `Title "${after.title ?? ""}", was "${before.title ?? ""}"` });
  const steps = Math.max(before.steps?.length ?? 0, after.steps?.length ?? 0);
  for (let i = 0; i < steps; i++) {
    const x = before.steps?.[i];
    const y = after.steps?.[i];
    if (x?.ok && y && !y.ok) changes.push({ kind: "step", tone: "worse", text: `Step ${i + 1} (${y.action}) fails now: ${y.error ?? ""}`.trim() });
    else if (x && !x.ok && y?.ok) changes.push({ kind: "step", tone: "better", text: `Step ${i + 1} (${y.action}) works now` });
  }
  const order = { worse: 0, change: 1, better: 2 };
  changes.sort((p, q) => order[p.tone] - order[q.tone]);
  const errs = (c: PageCheck) => c.exceptions.length + c.consoleErrors.length;
  return { path, changes, before: { calls: a, errors: errs(before), ok: before.ok }, after: { calls: b, errors: errs(after), ok: after.ok }, same: changes.length === 0 };
}
