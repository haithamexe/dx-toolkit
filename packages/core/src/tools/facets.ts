import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../atomic.js";
import { dxPath, ensureDxHome } from "../config.js";
import type { Project } from "./projects.js";

/**
 * Slicing the projects (the All projects page): every project has a few facts (is it running, does
 * it need you, is there work that isn't backed up, is it behind its remote; what kind it is; the
 * tags you gave it; whether you pinned it) and the page filters by them. Within one facet the
 * choices are "or" (Running or Needs you), across facets "and" (…and tagged client). Each choice
 * shows how many projects it would give, counted with the other facets applied, so a choice that
 * would show nothing says 0 instead of being a surprise.
 *
 * A filter is a small value that travels in the page's address (`#/projects?status=running&tag=client`),
 * so a slice can be bookmarked, shared and linked to; a saved view is a named filter. This file is
 * pure except for the one file where tags, pins and views are kept (`~/.dx/projectmeta.json`, 0600).
 */

export const STATUS_FACETS = ["running", "needs", "unsaved", "behind"] as const;
export type StatusFacet = (typeof STATUS_FACETS)[number];

export const STATUS_LABELS: Record<StatusFacet, string> = {
  running: "Running",
  needs: "Needs you",
  unsaved: "Unsaved work",
  behind: "Behind remote",
};

export interface FacetItem {
  name: string;
  dir: string;
  /** A framework or language: "Next.js", "Vite", "Node server", "Python". */
  kind: string;
  status: StatusFacet[];
  tags: string[];
  pinned: boolean;
  lastActive: number;
  branch?: string;
  changed: number;
  unpushed: number;
  behind: number;
  server?: { status: string; errorCount: number; recorded?: boolean; notRecorded?: boolean };
  /** The first thing that needs you, in a few words. */
  attention?: string;
}

export interface Filter {
  status: StatusFacet[];
  kind: string[];
  tag: string[];
  pinned: boolean;
  q: string;
}

export const emptyFilter = (): Filter => ({ status: [], kind: [], tag: [], pinned: false, q: "" });

const KIND_RE = /^[\w .#+/-]{1,32}$/;
export const TAG_RE = /^[a-z0-9][a-z0-9 _-]{0,23}$/;
const MAX_TAGS = 8;
const MAX_VIEWS = 20;

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [])
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 20);

/** A filter from anything (a request body, a saved file): known facets only, values checked, the rest dropped. */
export function cleanFilter(raw: unknown): Filter {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    status: [...new Set(list(r.status).filter((s): s is StatusFacet => (STATUS_FACETS as readonly string[]).includes(s)))],
    kind: [...new Set(list(r.kind).filter((k) => KIND_RE.test(k)))],
    tag: [...new Set(list(r.tag).map((t) => t.toLowerCase()).filter((t) => TAG_RE.test(t)))],
    pinned: r.pinned === true || r.pinned === "1" || r.pinned === "true",
    q: typeof r.q === "string" ? r.q.trim().slice(0, 80) : "",
  };
}

/** The filter in a page address's query: `status=running,needs&tag=client&q=shop`. */
export function filterFromQuery(query: URLSearchParams): Filter {
  return cleanFilter({ status: query.get("status"), kind: query.get("kind"), tag: query.get("tag"), pinned: query.get("pinned"), q: query.get("q") });
}

/** And back: what goes after the `?`, in a fixed order, empty facets left out. */
export function filterToQuery(f: Filter): string {
  const parts: string[] = [];
  if (f.status.length) parts.push(`status=${f.status.join(",")}`);
  if (f.kind.length) parts.push(`kind=${f.kind.map(encodeURIComponent).join(",")}`);
  if (f.tag.length) parts.push(`tag=${f.tag.map(encodeURIComponent).join(",")}`);
  if (f.pinned) parts.push("pinned=1");
  if (f.q) parts.push(`q=${encodeURIComponent(f.q)}`);
  return parts.join("&");
}

export const isEmptyFilter = (f: Filter): boolean => !f.status.length && !f.kind.length && !f.tag.length && !f.pinned && !f.q;

type Facet = "status" | "kind" | "tag" | "pinned" | "q";

function matches(item: FacetItem, f: Filter, skip?: Facet): boolean {
  if (skip !== "status" && f.status.length && !f.status.some((s) => item.status.includes(s))) return false;
  if (skip !== "kind" && f.kind.length && !f.kind.includes(item.kind)) return false;
  if (skip !== "tag" && f.tag.length && !f.tag.some((t) => item.tags.includes(t))) return false;
  if (skip !== "pinned" && f.pinned && !item.pinned) return false;
  if (skip !== "q" && f.q) {
    const q = f.q.toLowerCase();
    if (!`${item.name} ${item.kind} ${item.tags.join(" ")}`.toLowerCase().includes(q)) return false;
  }
  return true;
}

/** The projects a filter shows: pinned first, then by name. */
export function filterItems(items: FacetItem[], f: Filter): FacetItem[] {
  return items.filter((i) => matches(i, f)).sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name));
}

export interface FacetCount {
  value: string;
  label: string;
  count: number;
}

export interface FacetCounts {
  status: FacetCount[];
  kind: FacetCount[];
  tag: FacetCount[];
  pinned: number;
}

/**
 * How many projects each choice gives, with every other facet applied. A choice you've already made
 * stays listed (with its count) even at 0, so you can take it off.
 */
export function facetCounts(items: FacetItem[], f: Filter): FacetCounts {
  const count = (skip: Facet, has: (i: FacetItem) => boolean) => items.filter((i) => matches(i, f, skip) && has(i)).length;
  const kinds = [...new Set([...items.map((i) => i.kind), ...f.kind])].sort((a, b) => a.localeCompare(b));
  const tags = [...new Set([...items.flatMap((i) => i.tags), ...f.tag])].sort((a, b) => a.localeCompare(b));
  const byCountThenName = (a: FacetCount, b: FacetCount) => b.count - a.count || a.label.localeCompare(b.label);
  return {
    status: STATUS_FACETS.map((s) => ({ value: s, label: STATUS_LABELS[s], count: count("status", (i) => i.status.includes(s)) })),
    kind: kinds.map((k) => ({ value: k, label: k, count: count("kind", (i) => i.kind === k) })).sort(byCountThenName),
    tag: tags.map((t) => ({ value: t, label: t, count: count("tag", (i) => i.tags.includes(t)) })).sort(byCountThenName),
    pinned: count("pinned", (i) => i.pinned),
  };
}

// ---- what kind of project it is, in the words people use

const FRAMEWORKS: [dep: string, label: string][] = [
  ["next", "Next.js"],
  ["nuxt", "Nuxt"],
  ["@sveltejs/kit", "SvelteKit"],
  ["astro", "Astro"],
  ["@remix-run/react", "Remix"],
  ["react-router", "React Router"],
  ["vite", "Vite"],
  ["react-scripts", "Create React App"],
  ["@angular/core", "Angular"],
  ["gatsby", "Gatsby"],
  ["@nestjs/core", "Node server"],
  ["express", "Node server"],
  ["fastify", "Node server"],
  ["hono", "Node server"],
  ["koa", "Node server"],
];
const KIND_WORDS: Record<string, string> = { node: "Node", go: "Go", rust: "Rust", python: "Python", dotnet: ".NET", other: "Other", website: "Website" };

/** A framework from package.json's dependencies, else the language. Read from the one file, never run. */
export function frameworkOf(p: Pick<Project, "dir" | "kind">): string {
  if (p.kind === "node") {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(p.dir, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = { ...pkg.devDependencies, ...pkg.dependencies };
      for (const [dep, label] of FRAMEWORKS) if (dep in deps) return label;
    } catch {
      // no readable package.json: it's just Node
    }
  }
  return KIND_WORDS[p.kind] ?? "Other";
}

// ---- tags, pins and views: the one file dx keeps for them

export interface SavedView {
  id: string;
  name: string;
  filter: Filter;
}

interface Meta {
  tags: Record<string, string[]>;
  pinned: string[];
  views: SavedView[];
}

export class FacetError extends Error {
  readonly status = 400;
}

const metaFile = () => dxPath("projectmeta.json");
const keyOf = (dir: string) => dir.toLowerCase();

export function readMeta(): Meta {
  try {
    const raw = JSON.parse(fs.readFileSync(metaFile(), "utf8")) as Partial<Meta>;
    const tags: Record<string, string[]> = {};
    for (const [dir, t] of Object.entries(raw.tags ?? {})) {
      const clean = cleanTags(t);
      if (clean.length) tags[dir] = clean;
    }
    return {
      tags,
      pinned: Array.isArray(raw.pinned) ? raw.pinned.filter((d): d is string => typeof d === "string") : [],
      views: (Array.isArray(raw.views) ? raw.views : []).flatMap((v) => (v && typeof v.id === "string" && typeof v.name === "string" ? [{ id: v.id, name: v.name.slice(0, 40), filter: cleanFilter(v.filter) }] : [])).slice(0, MAX_VIEWS),
    };
  } catch {
    return { tags: {}, pinned: [], views: [] };
  }
}

function writeMeta(meta: Meta): void {
  ensureDxHome();
  writeFileAtomic(metaFile(), JSON.stringify(meta, null, 2), { mode: 0o600 });
}

/** Tags as they're kept: lower case, trimmed, each a short plain word or two, no repeats, at most eight. */
export function cleanTags(raw: unknown): string[] {
  return [...new Set(list(raw).map((t) => t.toLowerCase().replace(/\s+/g, " ")).filter((t) => TAG_RE.test(t)))].slice(0, MAX_TAGS);
}

/** Replaces a project's tags. A tag that isn't allowed is refused by name, not dropped without a word. */
export function setProjectTags(dir: string, tags: unknown): string[] {
  const wanted = list(tags).map((t) => t.toLowerCase().replace(/\s+/g, " "));
  const bad = wanted.find((t) => !TAG_RE.test(t));
  if (bad !== undefined) throw new FacetError(`"${bad}" isn't a tag: use letters, numbers, spaces, - or _, up to 24 characters.`);
  const clean = cleanTags(wanted);
  if (new Set(wanted).size > MAX_TAGS) throw new FacetError(`A project can have at most ${MAX_TAGS} tags.`);
  const meta = readMeta();
  if (clean.length) meta.tags[keyOf(dir)] = clean;
  else delete meta.tags[keyOf(dir)];
  writeMeta(meta);
  return clean;
}

export function setPinned(dir: string, pinned: boolean): void {
  const meta = readMeta();
  const rest = meta.pinned.filter((d) => keyOf(d) !== keyOf(dir));
  meta.pinned = pinned ? [...rest, keyOf(dir)] : rest;
  writeMeta(meta);
}

const viewId = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "view";

/** Saves a named filter as a view (the same name again replaces it). */
export function saveView(name: unknown, filter: unknown): SavedView {
  const clean = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  if (!clean || clean.length > 40) throw new FacetError("Give the view a name of up to 40 characters.");
  const f = cleanFilter(filter);
  if (isEmptyFilter(f)) throw new FacetError("There's nothing to save: choose something to filter by first.");
  const meta = readMeta();
  const id = viewId(clean);
  const view: SavedView = { id, name: clean, filter: f };
  const at = meta.views.findIndex((v) => v.id === id);
  if (at >= 0) meta.views[at] = view;
  else if (meta.views.length >= MAX_VIEWS) throw new FacetError(`You can keep up to ${MAX_VIEWS} views. Remove one first.`);
  else meta.views.push(view);
  writeMeta(meta);
  return view;
}

export function removeView(id: unknown): boolean {
  const meta = readMeta();
  const rest = meta.views.filter((v) => v.id !== id);
  if (rest.length === meta.views.length) return false;
  meta.views = rest;
  writeMeta(meta);
  return true;
}

/** The views dx has from the start: counted with the same filter code, never stored. */
export const BUILT_IN_VIEWS: SavedView[] = [
  { id: "needs-me", name: "Needs me", filter: { ...emptyFilter(), status: ["needs"] } },
  { id: "running", name: "Running", filter: { ...emptyFilter(), status: ["running"] } },
  { id: "unsaved", name: "Unsaved work", filter: { ...emptyFilter(), status: ["unsaved"] } },
  { id: "pinned", name: "Pinned", filter: { ...emptyFilter(), pinned: true } },
];
