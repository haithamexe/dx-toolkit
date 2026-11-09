import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { readActivity, type ActivityEvent } from "./activity.js";
import { loadMocks } from "./mocks.js";
import { projectApis } from "./openapi.js";

/**
 * The endpoint graveyard: what a project declares and nobody used while dx was watching. API
 * routes found in the code (Express, Fastify, Hono, Koa routers, Next.js route handlers and
 * pages/api, SvelteKit and Nuxt server routes, FastAPI, Flask) and in its saved API spec; pages
 * from file-based routing (Next.js, SvelteKit, Nuxt, Astro, Remix) and React Router paths; and
 * mocks. Each is matched against the requests, page loads and route changes in the activity
 * history. Dead code found from what ran, not only from what's imported.
 */

export interface GraveEntry {
  /** "GET /api/orders/:id", or a page path "/settings/billing". */
  what: string;
  method?: string;
  path: string;
  /** Where it's declared: "src/server/routes.ts:42", "the API spec", "mocks". */
  from: string;
  /** The last time it was used in the history, if it was. */
  lastUsed?: string;
  uses: number;
}

export interface Graveyard {
  project: string;
  /** How far back the history goes (it's kept `activityDays`, default 7). */
  since: string;
  days: number;
  /** Requests and page events read. */
  events: number;
  endpoints: GraveEntry[];
  pages: GraveEntry[];
  mocks: GraveEntry[];
  /** Calls that matched no declared route (so a route finder may have missed some). */
  unmatched: number;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt", ".svelte-kit", ".output", ".venv", "venv", "__pycache__", "coverage", ".turbo", ".cache", "target", "vendor", "public", "static"]);
const CODE = /\.(m?[jt]sx?|cjs|vue|svelte|astro|py)$/i;

function files(dir: string): string[] {
  const git = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: dir, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  let list: string[] = [];
  if (git.status === 0 && git.stdout) list = git.stdout.split("\0").filter(Boolean);
  else {
    const walk = (rel: string, depth: number) => {
      if (depth > 10 || list.length > 20_000) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(r, depth + 1);
        } else if (e.isFile()) list.push(r);
      }
    };
    walk("", 0);
  }
  return list.filter((f) => CODE.test(f) && !f.split("/").some((p) => SKIP_DIRS.has(p)) && !/(\.test|\.spec|\.stories|\.d)\.[jt]sx?$/.test(f) && !/(^|\/)(__tests__|tests?|e2e|cypress|playwright)\//.test(f)).slice(0, 8000);
}

/** A path from any router's syntax, with parameters as `:x` and catch-alls as `**`. */
export function normalRoute(p: string): string {
  let out = `/${p}`
    .replace(/\[\[?\.\.\.[^\]]+\]\]?/g, "**") // [...slug], [[...slug]]
    .replace(/\[([^\]]+)\]/g, ":$1") // [id]
    .replace(/\{([^}]+)\}/g, ":$1") // {id}
    .replace(/<(?:\w+:)?(\w+)>/g, ":$1") // <int:id>
    .replace(/\*+/g, "**")
    .replace(/\/\([^)]*\)/g, "") // (group) folders
    .replace(/\/+/g, "/");
  if (!out.startsWith("/")) out = `/${out}`;
  if (out.length > 1) out = out.replace(/\/$/, "");
  return out;
}

/** Does a used path (folded or not) fit a declared route? */
export function routeFits(route: string, used: string): boolean {
  const r = route.split("/").filter(Boolean);
  const u = (used.split("?")[0].split("#")[0] || "/").split("/").filter(Boolean);
  for (let i = 0; i < r.length; i++) {
    if (r[i] === "**") return true;
    if (i >= u.length) return false;
    if (r[i].startsWith(":")) continue;
    if (r[i].toLowerCase() !== decodeURIComponent(u[i]).toLowerCase()) return false;
  }
  return r.length === u.length;
}

interface Declared {
  method?: string;
  path: string;
  from: string;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** API routes and pages the code declares. */
export function declaredRoutes(dir: string): { endpoints: Declared[]; pages: Declared[] } {
  const endpoints: Declared[] = [];
  const pages: Declared[] = [];
  const seen = new Set<string>();
  const add = (list: Declared[], d: Declared) => {
    const k = `${list === pages ? "page" : "api"} ${d.method ?? ""} ${d.path}`;
    if (seen.has(k) || list.length >= 1000) return;
    seen.add(k);
    list.push(d);
  };
  for (const f of files(dir)) {
    const noExt = f.replace(/\.[^./]+$/, "");
    // ---- file-based routing
    let m: RegExpExecArray | null;
    if ((m = /^(?:src\/)?app\/(.*?)\/?route$/.exec(noExt))) {
      // Next.js route handlers: the methods it exports.
      const text = read(dir, f);
      const methods = METHODS.filter((x) => new RegExp(`export\\s+(async\\s+)?(function|const)\\s+${x}\\b`).test(text));
      for (const x of methods.length ? methods : ["GET"]) add(endpoints, { method: x, path: normalRoute(m[1]), from: f });
      continue;
    }
    if ((m = /^(?:src\/)?pages\/api\/(.*)$/.exec(noExt))) {
      add(endpoints, { path: normalRoute(`/api/${m[1].replace(/(^|\/)index$/, "")}`), from: f });
      continue;
    }
    if ((m = /^(?:src\/)?app\/(.*?)\/?page$/.exec(noExt)) && /\.(m?[jt]sx?|mdx?)$/.test(f)) {
      add(pages, { path: normalRoute(m[1]), from: f });
      continue;
    }
    if ((m = /^(?:src\/)?pages\/(.*)$/.exec(noExt)) && /\.(m?[jt]sx?|vue|astro|mdx?)$/.test(f) && !/(^|\/)_(app|document|error|layout)$|\/\[?_/.test(m[1])) {
      add(pages, { path: normalRoute(m[1].replace(/(^|\/)index$/, "")), from: f });
      continue;
    }
    if ((m = /^src\/routes\/(.*?)\/?\+page(\.server)?\.(svelte|[jt]s)$/.exec(f))) {
      add(pages, { path: normalRoute(m[1]), from: f });
      continue;
    }
    if ((m = /^src\/routes\/(.*?)\/?\+server\.[jt]s$/.exec(f))) {
      const text = read(dir, f);
      for (const x of METHODS.filter((y) => new RegExp(`export\\s+(async\\s+)?(function|const)\\s+${y}\\b`).test(text))) add(endpoints, { method: x, path: normalRoute(m[1]), from: f });
      continue;
    }
    if ((m = /^server\/(api|routes)\/(.*?)(\.(get|post|put|patch|delete))?$/.exec(noExt))) {
      // Nuxt / Nitro: server/api/orders/[id].get.ts
      add(endpoints, { method: m[4]?.toUpperCase(), path: normalRoute(`${m[1] === "api" ? "/api/" : "/"}${m[2].replace(/(^|\/)index$/, "")}`), from: f });
      continue;
    }
    if ((m = /^app\/routes\/(.*)$/.exec(noExt)) && /\.[jt]sx?$/.test(f)) {
      // Remix flat routes: users.$id.tsx
      const p = m[1].replace(/\/route$/, "").replace(/^_index$|\._index$/, "").split(".").filter((s) => !s.startsWith("_")).map((s) => (s.startsWith("$") ? (s === "$" ? "**" : `:${s.slice(1)}`) : s)).join("/");
      add(pages, { path: normalRoute(p), from: f });
      continue;
    }
    // ---- routes written in code
    const text = read(dir, f);
    if (!text) continue;
    const lineOf = (i: number) => text.slice(0, i).split("\n").length;
    const code = /\b(?:app|router|server|api|fastify|routes|r|v1|v2|hono)\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*(['"`])(\/[^'"`]*)\2/gi;
    while ((m = code.exec(text))) add(endpoints, { method: m[1].toUpperCase() === "ALL" ? undefined : m[1].toUpperCase(), path: normalRoute(m[3]), from: `${f}:${lineOf(m.index)}` });
    const py = /@\w+\.(get|post|put|patch|delete|route)\(\s*(['"])(\/[^'"]*)\2([^)]*)\)/g;
    while ((m = py.exec(text))) {
      const methods = m[1] === "route" ? (/methods\s*=\s*\[([^\]]*)\]/.exec(m[4])?.[1].match(/[A-Z]+/g) ?? ["GET"]) : [m[1].toUpperCase()];
      for (const x of methods) add(endpoints, { method: x, path: normalRoute(m[3]), from: `${f}:${lineOf(m.index)}` });
    }
    const rr = /(?:<Route\b[^>]*\bpath=|\bpath\s*:\s*)(['"])(\/[^'"]*)\1/g;
    if (/react-router|@tanstack\/react-router|vue-router|createBrowserRouter|<Route\b/.test(text)) {
      while ((m = rr.exec(text))) add(pages, { path: normalRoute(m[2]), from: `${f}:${lineOf(m.index)}` });
    }
  }
  return { endpoints, pages };
}

function read(dir: string, f: string): string {
  try {
    const st = fs.statSync(path.join(dir, f));
    return st.isFile() && st.size < 512 * 1024 ? fs.readFileSync(path.join(dir, f), "utf8") : "";
  } catch {
    return "";
  }
}

const pathOfEvent = (e: ActivityEvent): string | undefined => {
  const raw = e.type === "request" ? e.url : e.type === "page" || e.type === "route" ? (e.url ?? e.page) : undefined;
  if (!raw) return undefined;
  try {
    const u = new URL(raw, "http://same.origin");
    // A #/route counts as the page.
    return u.hash.startsWith("#/") ? u.hash.slice(1).split("?")[0] : u.pathname;
  } catch {
    return undefined;
  }
};

/** What the project declares and nobody used in the history it has. */
export function findGraveyard(dir: string, project = path.basename(dir), options: { days?: number } = {}): Graveyard {
  const keep = Math.max(1, loadConfig().activityDays ?? 7);
  const days = Math.min(options.days ?? 30, keep);
  const since = new Date(Date.now() - days * 86_400_000);
  const events = readActivity({ dir, since, limit: 100_000 }).filter((e) => (e.type === "request" || e.type === "page" || e.type === "route") && !(e.url ?? "").startsWith("/__dx/") && !e.site);
  const calls = events.filter((e) => e.type === "request").map((e) => ({ method: (e.method ?? "GET").toUpperCase(), path: pathOfEvent(e) ?? "", at: e.at }));
  const visits = events.filter((e) => e.type !== "request").map((e) => ({ path: pathOfEvent(e) ?? "", at: e.at }));
  const { endpoints, pages } = declaredRoutes(dir);

  // The project's API spec (given, or found by itself) counts as declared too.
  for (const { spec } of projectApis(dir)) {
    for (const ep of spec.endpoints) if (!endpoints.some((d) => d.method === ep.method && d.path === normalRoute(ep.path))) endpoints.push({ method: ep.method, path: normalRoute(ep.path), from: spec.apiName ? `the API spec "${spec.apiName}"` : "the API spec" });
  }
  const used = (d: Declared, list: Array<{ method?: string; path: string; at: string }>) => {
    let uses = 0;
    let last: string | undefined;
    for (const c of list) {
      if (d.method && c.method && d.method !== c.method) continue;
      if (!routeFits(d.path, c.path)) continue;
      uses++;
      if (!last || c.at > last) last = c.at;
    }
    return { uses, last };
  };
  const toEntry = (d: Declared, list: Array<{ method?: string; path: string; at: string }>): GraveEntry => {
    const u = used(d, list);
    return { what: d.method ? `${d.method} ${d.path}` : d.path, method: d.method, path: d.path, from: d.from, uses: u.uses, lastUsed: u.last };
  };
  const unmatched = calls.filter((c) => !endpoints.some((d) => (!d.method || d.method === c.method) && routeFits(d.path, c.path))).length;
  const mockSet = loadMocks(dir, project);
  // One entry per method and path: a mock set keeps variants by query and body.
  const mockRoutes = [...new Map(mockSet.endpoints.map((m) => [`${m.method} ${normalRoute(m.path)}`, { method: m.method, path: normalRoute(m.path), from: "mocks" }])).values()];
  const mocks = mockRoutes.map((d) => toEntry(d, calls));
  const byUse = (a: GraveEntry, b: GraveEntry) => a.uses - b.uses || a.path.localeCompare(b.path);
  return {
    project,
    since: since.toISOString(),
    days,
    events: events.length,
    endpoints: endpoints.map((d) => toEntry(d, calls)).sort(byUse),
    pages: pages.map((d) => toEntry(d, visits)).sort(byUse),
    mocks: mocks.sort(byUse),
    unmatched,
  };
}
