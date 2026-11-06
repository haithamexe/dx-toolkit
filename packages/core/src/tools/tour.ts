import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readActivity, type ActivityEvent } from "./activity.js";
import { findEnvFiles, isExampleFile } from "./envaudit.js";
import { declaredRoutes, normalRoute, routeFits } from "./graveyard.js";
import { foldPath } from "./mocks.js";
import { mapApi, projectSpec, readSpec, specSource } from "./openapi.js";
import { planPrepare } from "./prepare.js";
import type { Project } from "./projects.js";
import { readDataSchema } from "./seeddata.js";
import { detectStack } from "./stacks.js";
import { detectTestFramework } from "./tests.js";

/**
 * The newcomer tour: a map of a project, made from its files and from what dx saw it do. What it
 * is, how to run it, which pages it has and which API calls each page makes (from the activity
 * history), which file answers each call, where its data comes from, which settings it needs
 * (names only, never values), how it's tested, and where the work happens. Something to hand a new
 * teammate, or yourself in six months. Read-only: nothing runs, nothing is written.
 */

export interface TourCall {
  /** "GET /api/orders/:id". */
  key: string;
  count: number;
  /** The file that answers it: "src/server/orders.ts:12". */
  file?: string;
}

export interface TourPage {
  /** "/checkout", "/orders/:id". */
  path: string;
  /** The file that renders it, when the routing says so. */
  file?: string;
  /** Page loads and route changes to it in the history. */
  visits: number;
  /** The API calls made while it was open. */
  calls: TourCall[];
}

export interface TourEndpoint {
  key: string;
  method?: string;
  path: string;
  file?: string;
  /** How many times it was called in the history. */
  calls: number;
  /** Pages that call it. */
  pages: string[];
}

export interface TourFolder {
  path: string;
  files: number;
  /** What it's for, guessed from its name. */
  what?: string;
}

export interface ProjectTour {
  project: string;
  dir: string;
  /** The README's first paragraph, as plain text. */
  about?: string;
  /** "Next.js 14", "React 18", "Prisma", "Tailwind CSS", "TypeScript". */
  tech: string[];
  packageManager?: string;
  run: {
    /** What dx does before starting it (install, .env, Docker, migrations). */
    steps: string[];
    /** The command that starts it. */
    command?: string;
    url?: string;
    /** For a project of several services. */
    services: { name: string; role: string; command?: string }[];
  };
  /** Settings it needs: names only, from the example file (else the .env files), never values. */
  env: { name: string; file: string }[];
  pages: TourPage[];
  endpoints: TourEndpoint[];
  /** The project's API spec, when it has one: what the API is meant to be, next to what was called. */
  spec?: { title: string; version: string; kind: string; source: string; endpoints: { method: string; path: string; summary?: string; calls: number }[]; undocumented: number };
  data?: { file: string; tables: { name: string; columns: number; links: string[] }[] };
  tests?: { framework: string; command: string };
  folders: TourFolder[];
  /** The files changed most in the last 90 days. */
  busy: { file: string; commits: number }[];
  /** What the page-to-call map is made from. */
  history: { days: number; events: number };
  at: string;
}

const TECH: Array<[pkg: string, name: string]> = [
  ["next", "Next.js"],
  ["nuxt", "Nuxt"],
  ["@remix-run/react", "Remix"],
  ["@sveltejs/kit", "SvelteKit"],
  ["astro", "Astro"],
  ["@angular/core", "Angular"],
  ["gatsby", "Gatsby"],
  ["react", "React"],
  ["vue", "Vue"],
  ["svelte", "Svelte"],
  ["solid-js", "Solid"],
  ["preact", "Preact"],
  ["react-native", "React Native"],
  ["expo", "Expo"],
  ["electron", "Electron"],
  ["vite", "Vite"],
  ["react-router-dom", "React Router"],
  ["react-router", "React Router"],
  ["express", "Express"],
  ["fastify", "Fastify"],
  ["hono", "Hono"],
  ["koa", "Koa"],
  ["@nestjs/core", "NestJS"],
  ["@trpc/server", "tRPC"],
  ["graphql", "GraphQL"],
  ["@prisma/client", "Prisma"],
  ["drizzle-orm", "Drizzle"],
  ["typeorm", "TypeORM"],
  ["sequelize", "Sequelize"],
  ["mongoose", "Mongoose"],
  ["@supabase/supabase-js", "Supabase"],
  ["pg", "PostgreSQL (pg)"],
  ["postgres", "PostgreSQL (postgres.js)"],
  ["mysql2", "MySQL (mysql2)"],
  ["mongodb", "MongoDB"],
  ["ioredis", "Redis"],
  ["redis", "Redis"],
  ["knex", "Knex"],
  ["firebase", "Firebase"],
  ["tailwindcss", "Tailwind CSS"],
  ["styled-components", "styled-components"],
  ["@emotion/react", "Emotion"],
  ["@reduxjs/toolkit", "Redux Toolkit"],
  ["zustand", "Zustand"],
  ["@tanstack/react-query", "TanStack Query"],
  ["swr", "SWR"],
  ["zod", "Zod"],
  ["next-auth", "NextAuth"],
  ["@auth/core", "Auth.js"],
  ["@clerk/nextjs", "Clerk"],
  ["stripe", "Stripe"],
  ["i18next", "i18next"],
  ["next-intl", "next-intl"],
  ["typescript", "TypeScript"],
];

const PY_TECH: Array<[RegExp, string]> = [
  [/^django\b/im, "Django"],
  [/^fastapi\b/im, "FastAPI"],
  [/^flask\b/im, "Flask"],
  [/^sqlalchemy\b/im, "SQLAlchemy"],
  [/^celery\b/im, "Celery"],
  [/^pydantic\b/im, "Pydantic"],
];

const FOLDER_ROLES: Array<[RegExp, string]> = [
  [/^(components?|ui|widgets)$/i, "UI components"],
  [/^(pages|app|routes|views|screens)$/i, "pages and routes"],
  [/^(api|server|backend|controllers|handlers|endpoints)$/i, "the API"],
  [/^(lib|libs|utils?|helpers|shared|common|core)$/i, "shared code"],
  [/^hooks$/i, "React hooks"],
  [/^(store|stores|state|redux|slices)$/i, "app state"],
  [/^(styles|css|theme)$/i, "styles"],
  [/^(public|static|assets|images|fonts)$/i, "static files"],
  [/^(prisma|db|database|migrations|models|schema|drizzle|entities)$/i, "the database"],
  [/^(tests?|__tests__|e2e|cypress|playwright|spec)$/i, "tests"],
  [/^(scripts|bin|tools)$/i, "scripts"],
  [/^(config|configs|settings)$/i, "configuration"],
  [/^(docs?|documentation)$/i, "documentation"],
  [/^(types|typings|@types)$/i, "type definitions"],
  [/^(services|clients|integrations)$/i, "calls to other services"],
  [/^(locales?|i18n|lang|translations|messages)$/i, "translations"],
  [/^(packages|apps)$/i, "packages of a monorepo"],
  [/^(\.github|\.circleci|\.gitlab)$/i, "CI"],
  [/^(middleware|middlewares)$/i, "middleware"],
  [/^(emails?|templates|mail)$/i, "email templates"],
];

const LOCKS = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock|uv\.lock)$/;

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as T;
  } catch {
    return undefined;
  }
}

function git(dir: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  return r.status === 0 ? r.stdout : "";
}

const major = (v: string | undefined) => /(\d+)/.exec(v ?? "")?.[1];

/** What the project is built with, from package.json (with major versions for frameworks) and Python requirements. */
export function detectTech(dir: string): string[] {
  const out: string[] = [];
  const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(path.join(dir, "package.json"));
  const deps = { ...pkg?.devDependencies, ...pkg?.dependencies };
  const seen = new Set<string>();
  for (const [name, label] of TECH) {
    if (!(name in deps) || seen.has(label)) continue;
    seen.add(label);
    const v = major(deps[name]);
    const versioned = ["Next.js", "Nuxt", "React", "Vue", "Angular", "Svelte", "SvelteKit", "Astro", "Express", "Vite", "Tailwind CSS"].includes(label);
    out.push(versioned && v ? `${label} ${v}` : label);
  }
  let py = "";
  for (const f of ["requirements.txt", "pyproject.toml"]) {
    try {
      py += fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      // not there
    }
  }
  if (py) {
    out.push("Python");
    for (const [re, label] of PY_TECH) if (re.test(py.replace(/^\s*["']?/gm, ""))) out.push(label);
  }
  if (fs.existsSync(path.join(dir, "go.mod"))) out.push("Go");
  if (fs.existsSync(path.join(dir, "Cargo.toml"))) out.push("Rust");
  if (fs.existsSync(path.join(dir, "Dockerfile")) || fs.existsSync(path.join(dir, "docker-compose.yml")) || fs.existsSync(path.join(dir, "compose.yaml"))) out.push("Docker");
  return out;
}

/** The README's first paragraph after its title, without badges, images, links' addresses or markup. */
export function readmeIntro(dir: string): string | undefined {
  const file = ["README.md", "readme.md", "Readme.md", "README.markdown", "README"].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (!file) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8").slice(0, 20_000);
  } catch {
    return undefined;
  }
  const lines = text.replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const para: string[] = [];
  let inCode = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      inCode = !inCode;
      if (para.length) break;
      continue;
    }
    if (inCode) continue;
    if (!line) {
      if (para.length) break;
      continue;
    }
    if (/^(#|<|\||>|-{3,}|={3,}|\[!\[|!\[)/.test(line)) {
      if (para.length) break;
      continue;
    }
    para.push(line);
  }
  const plain = para
    .join(" ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length < 12) return undefined;
  return plain.length > 500 ? `${plain.slice(0, 499)}…` : plain;
}

function envNames(dir: string): { name: string; file: string }[] {
  const files = findEnvFiles(dir);
  const examples = files.filter((f) => isExampleFile(path.basename(f)));
  const out = new Map<string, string>();
  // Example files first: they list every setting, the real ones may not.
  for (const f of examples.length ? examples : files) {
    let text: string;
    try {
      text = fs.readFileSync(path.isAbsolute(f) ? f : path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    // Names only: the part before "=". Values are never read into the tour.
    for (const m of text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) if (!out.has(m[1])) out.set(m[1], f);
  }
  return [...out].map(([name, file]) => ({ name, file })).slice(0, 200);
}

function folders(dir: string, tracked: string[]): TourFolder[] {
  const count = new Map<string, number>();
  for (const f of tracked) {
    const parts = f.split("/");
    if (parts.length < 2) continue;
    count.set(parts[0], (count.get(parts[0]) ?? 0) + 1);
    // One level in, for the usual source folders.
    if (parts.length > 2 && /^(src|app|lib|server|client|packages|apps)$/.test(parts[0])) count.set(`${parts[0]}/${parts[1]}`, (count.get(`${parts[0]}/${parts[1]}`) ?? 0) + 1);
  }
  const out: TourFolder[] = [];
  for (const [p, files] of count) {
    const name = p.split("/").at(-1) ?? p;
    const role = FOLDER_ROLES.find(([re]) => re.test(name))?.[1] ?? (p === "src" ? "the source" : undefined);
    out.push({ path: p, files, ...(role ? { what: role } : {}) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 60);
}

function busyFiles(dir: string): { file: string; commits: number }[] {
  const out = git(dir, ["log", "--since=90.days", "--no-merges", "--name-only", "--format=", "--relative"]);
  const count = new Map<string, number>();
  for (const f of out.split("\n")) {
    const file = f.trim();
    if (!file || LOCKS.test(file) || /\.(snap|map|min\.js)$/.test(file)) continue;
    count.set(file, (count.get(file) ?? 0) + 1);
  }
  return [...count]
    .filter(([file]) => fs.existsSync(path.join(dir, file)))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([file, commits]) => ({ file, commits }));
}

const pathOf = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    return new URL(url, "http://x").pathname;
  } catch {
    return undefined;
  }
};

const ASSET = /\.(m?[jt]sx?|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf)$/i;

/**
 * Which page each API call came from: the Referer the browser sent (same origin), else the page or
 * route the history was on just before (within 30 s), as the Activity page groups them.
 */
export function callsByPage(events: ActivityEvent[]): { pages: Map<string, number>; calls: Map<string, Map<string, number>>; all: Map<string, number> } {
  const pages = new Map<string, number>();
  const calls = new Map<string, Map<string, number>>();
  const all = new Map<string, number>();
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id);
  let current: { path: string; at: number } | undefined;
  for (const e of sorted) {
    if (e.type === "page" || e.type === "route") {
      const p = pathOf(e.type === "route" ? (e.page ?? e.url) : (e.url ?? e.page));
      if (!p || p.startsWith("/__dx/") || ASSET.test(p)) continue;
      const folded = foldPath(p);
      pages.set(folded, (pages.get(folded) ?? 0) + 1);
      current = { path: folded, at: Date.parse(e.at) };
      continue;
    }
    if (e.type !== "request" || !e.url) continue;
    const p = pathOf(e.url);
    if (!p || p.startsWith("/__dx/") || ASSET.test(p) || /^\/(@|node_modules\/|src\/|_next\/static)/.test(p)) continue;
    const key = `${(e.method ?? "GET").toUpperCase()} ${foldPath(p)}`;
    all.set(key, (all.get(key) ?? 0) + 1);
    const referer = e.requestHeaders?.referer ?? e.requestHeaders?.Referer;
    const fromRef = pathOf(referer);
    const page = e.page ? foldPath(pathOf(e.page) ?? "/") : fromRef ? foldPath(fromRef) : current && Date.parse(e.at) - current.at < 30_000 ? current.path : undefined;
    if (!page) continue;
    const m = calls.get(page) ?? new Map<string, number>();
    m.set(key, (m.get(key) ?? 0) + 1);
    calls.set(page, m);
  }
  return { pages, calls, all };
}

/** Builds the tour of a project. `events` defaults to the activity history (its whole length). */
export function projectTour(project: Pick<Project, "name" | "dir"> & Partial<Project>, options: { events?: ActivityEvent[]; days?: number } = {}): ProjectTour {
  const dir = project.dir;
  const days = options.days ?? 30;
  const events = options.events ?? readActivity({ dir, since: new Date(Date.now() - days * 86_400_000), limit: 50_000 });
  const tracked = git(dir, ["ls-files", "--cached", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  const declared = declaredRoutes(dir);
  const seen = callsByPage(events);

  // Endpoints: declared ones, then calls the history has that no declared route covers.
  const endpoints: TourEndpoint[] = declared.endpoints.map((d) => ({ key: `${d.method ?? "ANY"} ${d.path}`, method: d.method, path: d.path, file: d.from, calls: 0, pages: [] }));
  const endpointFor = (key: string): TourEndpoint => {
    const [method, p] = key.split(" ");
    const found = endpoints.find((x) => (!x.method || x.method === method) && routeFits(x.path, p));
    if (found) return found;
    const added: TourEndpoint = { key, method, path: p, calls: 0, pages: [] };
    endpoints.push(added);
    return added;
  };
  for (const [key, n] of seen.all) endpointFor(key).calls += n;

  // Pages: declared ones and visited ones, each with the calls made from it.
  const pages: TourPage[] = declared.pages.map((d) => ({ path: d.path, file: d.from, visits: 0, calls: [] }));
  const pageFor = (p: string): TourPage => {
    const found = pages.find((x) => routeFits(x.path, p)) ?? pages.find((x) => normalRoute(x.path) === normalRoute(p));
    if (found) return found;
    const added: TourPage = { path: p, visits: 0, calls: [] };
    pages.push(added);
    return added;
  };
  for (const [p, n] of seen.pages) pageFor(p).visits += n;
  for (const [p, m] of seen.calls) {
    const page = pageFor(p);
    for (const [key, count] of m) {
      const ep = endpointFor(key);
      const shown = ep.method ? `${ep.method} ${ep.path}` : key;
      const existing = page.calls.find((c) => c.key === shown);
      if (existing) existing.count += count;
      else page.calls.push({ key: shown, count, ...(ep.file ? { file: ep.file } : {}) });
      if (!ep.pages.includes(page.path)) ep.pages.push(page.path);
    }
  }
  for (const p of pages) p.calls.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  pages.sort((a, b) => b.visits - a.visits || a.path.localeCompare(b.path));
  endpoints.sort((a, b) => b.calls - a.calls || a.path.localeCompare(b.path));
  for (const e of endpoints) if (e.key.startsWith("ANY ")) e.key = e.key.slice(4);

  const proj = { name: project.name, dir, packageManager: project.packageManager, scripts: project.scripts ?? [], kind: project.kind ?? "node", root: project.root ?? path.dirname(dir), hasGit: project.hasGit ?? true, lastActive: project.lastActive ?? 0, devCommand: project.devCommand, url: project.url } as Project;
  let steps: string[] = [];
  try {
    steps = planPrepare(proj)
      .filter((s) => s.status !== "skip")
      .map((s) => (s.command ? `${s.title}: ${s.command}` : s.title));
  } catch {
    // a project dx can't plan for keeps an empty list
  }
  let services: ProjectTour["run"]["services"] = [];
  try {
    services = (detectStack(proj)?.services ?? []).map((s) => ({ name: s.name, role: s.role, command: s.kind === "docker" ? `docker compose up ${s.composeService ?? s.name}` : s.command }));
  } catch {
    // not a stack
  }
  const schema = readDataSchema(dir);
  const test = detectTestFramework(dir);
  let spec: ProjectTour["spec"];
  try {
    const stored = projectSpec(dir);
    if (stored) {
      const map = mapApi(readSpec(stored.doc), events);
      spec = { title: map.title, version: map.version, kind: map.kind, source: stored.source, endpoints: map.endpoints.slice(0, 300).map((e) => ({ method: e.method, path: e.path, ...(e.summary ? { summary: e.summary } : {}), calls: e.calls })), undocumented: map.undocumented.length };
    }
  } catch {
    // a spec dx can't read leaves the tour without one
  }
  const pm = project.packageManager;
  return {
    project: project.name,
    dir,
    about: readmeIntro(dir),
    tech: detectTech(dir),
    packageManager: pm,
    run: { steps, command: project.devCommand, url: project.url, services },
    env: envNames(dir),
    pages: pages.slice(0, 200),
    endpoints: endpoints.slice(0, 300),
    ...(spec ? { spec } : {}),
    data: schema
      ? {
          file: schema.file,
          tables: schema.tables.map((t) => ({ name: t.name, columns: t.columns.length, links: [...new Set(t.columns.filter((c) => c.ref).map((c) => c.ref!.table))] })),
        }
      : undefined,
    tests: test ? { framework: test.framework, command: test.framework === "pytest" ? "pytest" : test.framework === "go" ? "go test ./..." : pm === "bun" ? "bun run test" : `${pm ?? "npm"} test` } : undefined,
    folders: folders(dir, tracked),
    busy: busyFiles(dir),
    history: { days, events: events.length },
    at: new Date().toISOString(),
  };
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The tour as Markdown, to paste into a wiki or a file. */
export function tourMarkdown(t: ProjectTour): string {
  const out: string[] = [`# ${t.project}`, ""];
  if (t.about) out.push(t.about, "");
  if (t.tech.length) out.push(`**Built with:** ${t.tech.join(", ")}${t.packageManager ? ` (${t.packageManager})` : ""}`, "");
  out.push("## Running it", "");
  if (t.run.steps.length) {
    out.push("Before the first start:", "");
    for (const s of t.run.steps) out.push(`- ${s}`);
    out.push("");
  }
  if (t.run.services.length > 1) {
    out.push("It runs as several services:", "");
    for (const s of t.run.services) out.push(`- **${s.name}** (${s.role})${s.command ? `: \`${s.command}\`` : ""}`);
    out.push("");
  } else if (t.run.command) out.push(`Start it with \`${t.run.command}\`${t.run.url ? `, then open ${t.run.url}` : ""}.`, "");
  out.push(`Or \`dx go ${t.project}\`, which gets it ready and starts it.`, "");
  if (t.env.length) {
    out.push("## Settings it needs", "", `In \`.env\` (from ${[...new Set(t.env.map((e) => `\`${e.file}\``))].join(", ")}):`, "");
    out.push(t.env.map((e) => `\`${e.name}\``).join(", "), "");
  }
  const used = t.pages.filter((p) => p.visits || p.calls.length || p.file);
  if (used.length) {
    out.push("## Pages", "", "| Page | File | Calls |", "|---|---|---|");
    for (const p of used.slice(0, 60)) out.push(`| \`${p.path}\` | ${p.file ? `\`${p.file}\`` : ""} | ${p.calls.slice(0, 6).map((c) => `\`${c.key}\``).join("<br>")} |`);
    out.push("");
  }
  if (t.endpoints.length) {
    out.push("## API", "", "| Call | File | Used by |", "|---|---|---|");
    for (const e of t.endpoints.slice(0, 80)) out.push(`| \`${e.key}\` | ${e.file ? `\`${e.file}\`` : ""} | ${e.pages.slice(0, 4).map((p) => `\`${p}\``).join(", ")} |`);
    out.push("");
  }
  if (t.spec) {
    out.push("## API spec", "", `${t.spec.title}${t.spec.version ? ` ${t.spec.version}` : ""} (${t.spec.kind}, ${specSource(t.spec.source)}):`, "", "| Endpoint | What | Calls |", "|---|---|---|");
    for (const e of t.spec.endpoints.slice(0, 80)) out.push(`| \`${e.method} ${e.path}\` | ${(e.summary ?? "").replace(/\|/g, "\\|")} | ${e.calls} |`);
    out.push("");
  }
  if (t.data) {
    out.push("## Data", "", `From \`${t.data.file}\`:`, "");
    for (const tb of t.data.tables) out.push(`- **${tb.name}** (${count(tb.columns, "column")})${tb.links.length ? ` → ${tb.links.join(", ")}` : ""}`);
    out.push("");
  }
  if (t.tests) out.push("## Tests", "", `${t.tests.framework}: \`${t.tests.command}\``, "");
  const known = t.folders.filter((f) => f.what);
  if (known.length) {
    out.push("## Where things are", "");
    for (const f of known) out.push(`- \`${f.path}/\`: ${f.what} (${count(f.files, "file")})`);
    out.push("");
  }
  if (t.busy.length) {
    out.push("## Where the work happens", "", "Changed most in the last 90 days:", "");
    for (const b of t.busy) out.push(`- \`${b.file}\` (${count(b.commits, "commit")})`);
    out.push("");
  }
  out.push(`_Made by dx from the code and ${t.history.events ? `${t.history.events} recorded events of the last ${t.history.days} days` : "the code alone (no recorded activity yet)"}._`, "");
  return out.join("\n");
}
