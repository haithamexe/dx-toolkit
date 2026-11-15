import { execFile } from "node:child_process";
import {
  attentionItems,
  BUILT_IN_VIEWS,
  cleanFilter,
  FacetError,
  facetCounts,
  filterFromQuery,
  filterItems,
  filterToQuery,
  frameworkOf,
  loadConfig,
  mapLimit,
  readMeta,
  readRuns,
  removeView,
  saveView,
  scanProjectsCached,
  setPinned,
  setProjectTags,
  type FacetItem,
  type Project,
  type StatusFacet,
} from "@dx/core";
import { HttpError, knownProject, type ApiRequest } from "./api.js";
import { factsFor } from "./homeapi.js";

/**
 * Slicing the projects (`GET /api/facets`, tags, pins and saved views): the facts about every
 * project gathered once (the same ones Home reads, so "Needs you" means the same thing in both),
 * kept a few seconds, then filtered and counted by core/facets.ts. The page keeps the filter in its
 * address, so a slice can be linked to; the server never trusts it (`cleanFilter`).
 *
 * Tags, pins and views are kept in `~/.dx/projectmeta.json`. Every route that changes them takes a
 * known project's `dir` (or a view's id) and checks values against core's own rules.
 */

interface Kept<T> {
  at: number;
  value: T;
}
let behindKept: Kept<Map<string, number>> | undefined;

/** Commits each project's branch is behind its upstream, from what's already fetched (git fetch is dx's, every few minutes). */
async function behindByDir(projects: Project[]): Promise<Map<string, number>> {
  if (behindKept && Date.now() - behindKept.at < 15_000) return behindKept.value;
  const counts = await mapLimit(
    projects.filter((p) => p.hasGit),
    4,
    (p) =>
      new Promise<[string, number]>((resolve) => {
        execFile("git", ["rev-list", "--count", "HEAD..@{upstream}"], { cwd: p.dir, timeout: 5000, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } }, (err, stdout) => {
          resolve([p.dir.toLowerCase(), err ? 0 : Number(String(stdout).trim()) || 0]);
        });
      }),
    (p): [string, number] => [p.dir.toLowerCase(), 0],
  );
  behindKept = { at: Date.now(), value: new Map(counts) };
  return behindKept.value;
}

let itemsKept: Kept<FacetItem[]> | undefined;
export const forgetFacets = (): void => {
  itemsKept = undefined;
};

/** Every project with the facts its facets are made of. */
export async function facetItems(): Promise<FacetItem[]> {
  if (itemsKept && Date.now() - itemsKept.at < 5_000) return itemsKept.value;
  const projects = scanProjectsCached(loadConfig());
  const [facts, behind] = await Promise.all([factsFor(projects, readRuns(2000)), behindByDir(projects)]);
  const needs = new Map<string, string>();
  for (const a of attentionItems(facts)) if (!needs.has(a.dir.toLowerCase())) needs.set(a.dir.toLowerCase(), a.title);
  const meta = readMeta();
  const pinned = new Set(meta.pinned.map((d) => d.toLowerCase()));
  const items = projects.map((p): FacetItem => {
    const f = facts.find((x) => x.dir.toLowerCase() === p.dir.toLowerCase());
    const key = p.dir.toLowerCase();
    const running = f?.server && (f.server.status === "starting" || f.server.status === "ready");
    const unsaved = f?.unsaved;
    const changed = unsaved?.changed ?? 0;
    const unpushed = unsaved?.unpushed ?? 0;
    const behindBy = behind.get(key) ?? 0;
    const status: StatusFacet[] = [];
    if (running) status.push("running");
    if (needs.has(key)) status.push("needs");
    if (changed || unpushed || (unsaved?.untracked ?? 0)) status.push("unsaved");
    if (behindBy) status.push("behind");
    return {
      name: p.name,
      dir: p.dir,
      kind: frameworkOf(p),
      status,
      tags: meta.tags[key] ?? [],
      pinned: pinned.has(key),
      lastActive: p.lastActive,
      branch: unsaved?.branch,
      changed,
      unpushed,
      behind: behindBy,
      server: f?.server ? { status: f.server.status, errorCount: f.server.errorCount, recorded: f.server.recorded, notRecorded: !!f.server.notRecorded } : undefined,
      attention: needs.get(key),
    };
  });
  itemsKept = { at: Date.now(), value: items };
  return items;
}

function facetCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof FacetError) throw new HttpError(err.status, err.message);
    throw err;
  }
}

export const facetRoutes: Record<string, (req: ApiRequest) => unknown> = {
  "GET /api/facets": async (req) => {
    const items = await facetItems();
    const filter = filterFromQuery(req.query);
    const meta = readMeta();
    const views = [...BUILT_IN_VIEWS.map((v) => ({ ...v, builtin: true })), ...meta.views.map((v) => ({ ...v, builtin: false }))].map((v) => ({
      id: v.id,
      name: v.name,
      builtin: v.builtin,
      filter: v.filter,
      query: filterToQuery(v.filter),
      count: filterItems(items, v.filter).length,
    }));
    return { total: items.length, filter, query: filterToQuery(filter), items: filterItems(items, filter), counts: facetCounts(items, filter), views };
  },
  "POST /api/facets/tags": (req) => {
    const project = knownProject(req.body.dir);
    const tags = facetCall(() => setProjectTags(project.dir, req.body.tags));
    forgetFacets();
    return { tags };
  },
  "POST /api/facets/pin": (req) => {
    const project = knownProject(req.body.dir);
    setPinned(project.dir, req.body.pinned === true);
    forgetFacets();
    return { pinned: req.body.pinned === true };
  },
  "POST /api/facets/view": (req) => {
    const view = facetCall(() => saveView(req.body.name, cleanFilter(req.body.filter)));
    return { view: { ...view, builtin: false, query: filterToQuery(view.filter) } };
  },
  "POST /api/facets/view/remove": (req) => {
    if (!removeView(req.body.id)) throw new HttpError(404, "That view isn't saved any more.");
    return { ok: true };
  },
};
