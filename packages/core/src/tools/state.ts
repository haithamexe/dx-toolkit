import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configPath, dxHome, dxPath, expandHome, loadConfig, saveConfig, stripBom, type DxConfig } from "../config.js";
import { chaosFile, cleanChaos, loadChaos, saveChaos, type ChaosConfig } from "./chaos.js";
import { cleanTool, importTools, loadTools, toolsFile, type CustomTool } from "./customtools.js";
import { gitRun } from "./git.js";
import { journalPath, mergeJournalText, parseJournal, type JournalEntry } from "./journal.js";
import { cleanMockEndpoint, loadMocks, mockFile, MOCK_ENDPOINTS_MAX, saveMocks, type MockEndpoint } from "./mocks.js";
import { exportableSpecs, forgetSpec, readSpec, saveSpec, specFile } from "./openapi.js";
import type { Project } from "./projects.js";
import { cleanRule, loadRules, rulesFile, RULES_MAX, saveRules, type TrafficRule } from "./rules.js";
import { isValidProjectName, templatesDir } from "./scaffold.js";
import { listScenes, loadScene, sceneSlug, scenesFolder, type Scene } from "./seeddata.js";
import { importNote, readSession } from "./sessions.js";
import { normalizeEnv, normalizeSiteHost, type SiteConfig } from "./sites.js";
import { summariesDir } from "./summary.js";

/**
 * dx's state as one file, to carry to another computer: settings, the journal, saved summaries,
 * templates, and per project the tools, mocks, rules, API spec, chaos settings, data scenes, note
 * and alert choices. Never what's live or this computer's own: commits and branches, the activity
 * history and run log, snapshots, captures, caches, the dx browser's profile, certificates, the
 * dashboard's token, .env files. Projects are named by their git remote (host/owner/repo, never an
 * address with a password in it) and folder name, never by a path, and matched again on import.
 */

export const STATE_MAX = 25 * 1024 * 1024;
const TEMPLATES_MAX = 10 * 1024 * 1024;
const TEMPLATE_FILE_MAX = 2 * 1024 * 1024;
const SCENES_MAX = 10 * 1024 * 1024;
const BACKUPS_KEPT = 5;

/** Settings that mean the same on another computer. Paths, ports dx picked, Floppy's place and the app's install aren't among them. */
const PORTABLE = ["editor", "scanDepth", "ignore", "devServerTimeout", "githubUser", "autoConnectAi", "localDomains", "localDomainsPort", "activity", "activityDays", "activityMaxMB", "localhostRecording", "visualDiff", "visualMobile", "envAlerts", "terminal", "aiCli"] as const;
type PortableKey = (typeof PORTABLE)[number];
/** Editors dx knows by name: an editor setting is a command dx runs, so one from a file must be one of these. */
const EDITORS = new Set(["code", "code-insiders", "cursor", "windsurf", "zed", "subl", "webstorm", "idea", "phpstorm", "pycharm", "goland", "rider", "fleet", "nvim", "vim", "emacs", "nova", "atom"]);

/** The dashboard's own preferences that mean the same anywhere (none holds a path). */
export const STATE_PAGE_PREFS = ["theme", "detailMode", "aiLane", "toolAgent", "toolModel", "toolEffort", "gitTab", "chaosTab", "labTab", "activityView", "activitySince", "activityWho", "cleanupDays", "journalDays", "summaryDays", "summaryGithub", "visualView", "gremlinActions", "gremlinPath", "localePaths", "localeRtl"];

export interface StateSettings extends Partial<Pick<DxConfig, PortableKey>> {
  /** Projects folders under the home folder, as ~/… */
  projectsRoots?: string[];
  floppyColourway?: "navy" | "charcoal" | "maroon";
}

export interface StateProject {
  name: string;
  /** host/owner/repo of its git remote. */
  remote?: string;
  tools?: Omit<CustomTool, "createdAt" | "updatedAt">[];
  mocks?: { endpoints: MockEndpoint[] };
  rules?: TrafficRule[];
  /** The project's API specs (several can be kept), and that they were all removed on purpose. */
  specs?: { id?: string; name?: string; source: string; doc: Record<string, unknown>; service?: string; mount?: string }[];
  specsOff?: true;
  chaos?: Partial<Pick<ChaosConfig, "level" | "faults" | "seed" | "paths" | "clock" | "phone" | "locale">>;
  scenes?: Scene[];
  note?: { text: string; by: "you" | "ai"; at: string };
  alerts?: { off?: boolean; osOff?: boolean };
  sites?: Omit<SiteConfig, "project">[];
}

export interface DxState {
  format: "dx-state";
  version: 1;
  exportedAt: string;
  settings: StateSettings;
  /** Recorded sites that belong to no project. */
  sites: SiteConfig[];
  journal: JournalEntry[];
  summaries: { name: string; text: string }[];
  templates: { name: string; files: { path: string; data: string }[] }[];
  /** The dashboard's preferences, when it made the file. */
  page?: Record<string, string>;
  projects: StateProject[];
  /** What was too big to come along. */
  left?: string[];
}

export class StateError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------ naming projects without paths

/** A remote as host/owner/repo, lower case, never with a user or password; undefined for a remote on this computer. */
export function remoteKey(url: string): string | undefined {
  const u = url.trim();
  let host: string;
  let p: string;
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(u);
  if (scp) {
    host = scp[1];
    p = scp[2];
  } else {
    try {
      const x = new URL(u);
      if (!/^(https?|ssh|git):$/.test(x.protocol)) return undefined;
      host = x.hostname;
      p = x.pathname;
    } catch {
      return undefined;
    }
  }
  p = p.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (!host || !p || p.split("/").some((s) => !s || s === "." || s === "..")) return undefined;
  return `${host}/${p}`.toLowerCase();
}

/** Each git project's remote (origin, else the first), a few at a time. */
export async function projectRemotes(projects: Pick<Project, "dir" | "hasGit">[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const queue = projects.filter((p) => p.hasGit);
  await Promise.all(
    Array.from({ length: Math.min(8, queue.length) }, async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        const r = await gitRun(p.dir, ["remote", "-v"], { literal: false });
        const lines = r.code === 0 ? r.stdout.split(/\r?\n/).filter((l) => l.endsWith("(fetch)")) : [];
        const line = lines.find((l) => l.startsWith("origin\t")) ?? lines[0];
        const key = line ? remoteKey(line.split("\t")[1]?.replace(/\s+\(fetch\)$/, "") ?? "") : undefined;
        if (key) out.set(p.dir, key);
      }
    }),
  );
  return out;
}

const same = (a: string, b: string) => (process.platform === "linux" ? path.resolve(a) === path.resolve(b) : path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase());
const alertKey = (dir: string) => path.resolve(dir).toLowerCase();

/** A path under the home folder as ~/…, with forward slashes; undefined for anything else. */
function homeRelative(p: string): string | undefined {
  const rel = path.relative(os.homedir(), path.resolve(p));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return `~/${rel.split(path.sep).join("/")}`;
}

/** A ~/… path from a file, as a path on this computer; undefined when it isn't one. */
function fromHome(p: unknown): string | undefined {
  if (typeof p !== "string" || !/^~\/[^\0\r\n]{1,300}$/.test(p) || p.split("/").some((s) => s === "..")) return undefined;
  return expandHome(p.split("/").join(path.sep));
}

// ------------------------------------------------------------------ export

function readJsonFile(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, "utf8"))) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function templateFiles(dir: string): { files: { path: string; data: string }[]; bytes: number } {
  const files: { path: string; data: string }[] = [];
  let bytes = 0;
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) {
        const buf = fs.readFileSync(path.join(dir, r));
        if (buf.length > TEMPLATE_FILE_MAX) throw new StateError(`${r} is over 2 MB`);
        bytes += buf.length;
        files.push({ path: r, data: buf.toString("base64") });
      }
    }
  };
  walk("");
  return { files, bytes };
}

/**
 * Everything dx keeps that can go to another computer, for the projects found here. `page` is the
 * dashboard's own preferences, when it asks.
 */
export async function exportState(options: { projects: Project[]; config?: DxConfig; page?: Record<string, unknown> }): Promise<DxState> {
  const config = options.config ?? loadConfig();
  const left: string[] = [];
  const settings: StateSettings = {};
  for (const k of PORTABLE) if (config[k] !== undefined) (settings as Record<string, unknown>)[k] = config[k];
  const roots = config.projectsRoots.map(homeRelative).filter((r): r is string => !!r);
  if (roots.length) settings.projectsRoots = roots;
  if (config.floppy?.colourway) settings.floppyColourway = config.floppy.colourway;

  const remotes = await projectRemotes(options.projects);
  let sceneBytes = 0;
  const projects: StateProject[] = [];
  for (const p of options.projects) {
    const sp: StateProject = { name: p.name, ...(remotes.get(p.dir) ? { remote: remotes.get(p.dir) } : {}) };
    const tools = loadTools(p.dir).map(({ createdAt: _c, updatedAt: _u, ...t }) => t);
    if (tools.length) sp.tools = tools;
    if (fs.existsSync(mockFile(p.dir))) {
      const endpoints = loadMocks(p.dir, p.name).endpoints;
      if (endpoints.length) sp.mocks = { endpoints };
    }
    if (fs.existsSync(rulesFile(p.dir))) {
      const rules = loadRules(p.dir, p.name).rules.map(({ updatedAt: _u, ...r }) => r);
      if (rules.length) sp.rules = rules;
    }
    const kept = exportableSpecs(p.dir);
    if (kept.specs.length) sp.specs = kept.specs;
    else if (kept.off) sp.specsOff = true;
    if (fs.existsSync(chaosFile(p.dir))) {
      const c = loadChaos(p.dir, p.name);
      sp.chaos = { level: c.level, faults: c.faults, seed: c.seed, ...(c.paths ? { paths: c.paths } : {}), ...(c.clock ? { clock: c.clock } : {}), ...(c.phone ? { phone: c.phone } : {}), ...(c.locale ? { locale: c.locale } : {}) };
    }
    const scenes: Scene[] = [];
    for (const s of listScenes(p.dir).filter((x) => x.kind !== "backup")) {
      try {
        const scene = loadScene(p.dir, s.slug);
        const size = JSON.stringify(scene).length;
        if (sceneBytes + size > SCENES_MAX) {
          left.push(`${p.name}: the data scene "${s.name}" (data scenes can take 10 MB in all)`);
          continue;
        }
        sceneBytes += size;
        scenes.push(scene);
      } catch {
        // a scene that can't be read stays behind
      }
    }
    if (scenes.length) sp.scenes = scenes;
    const session = readSession(p.dir);
    if (session?.note && session.noteAt) sp.note = { text: session.note, by: session.noteBy === "ai" ? "ai" : "you", at: session.noteAt };
    const alerts = config.projectAlerts?.[alertKey(p.dir)];
    if (alerts && (alerts.off || alerts.osOff)) sp.alerts = { ...(alerts.off ? { off: true } : {}), ...(alerts.osOff ? { osOff: true } : {}) };
    const sites = (config.sites ?? []).filter((s) => s.project && same(s.project, p.dir)).map(({ project: _p, ...s }) => s);
    if (sites.length) sp.sites = sites;
    if (Object.keys(sp).some((k) => k !== "name" && k !== "remote")) projects.push(sp);
  }

  const summaries: DxState["summaries"] = [];
  try {
    for (const f of fs.readdirSync(summariesDir()).filter((f) => SUMMARY_NAME.test(f))) summaries.push({ name: f, text: fs.readFileSync(path.join(summariesDir(), f), "utf8") });
  } catch {
    // none saved
  }

  const templates: DxState["templates"] = [];
  let templateBytes = 0;
  const tdir = templatesDir(config);
  try {
    for (const e of fs.readdirSync(tdir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".") || !isValidProjectName(e.name)) continue;
      try {
        const t = templateFiles(path.join(tdir, e.name));
        if (templateBytes + t.bytes > TEMPLATES_MAX) {
          left.push(`the template "${e.name}" (templates can take 10 MB in all)`);
          continue;
        }
        templateBytes += t.bytes;
        templates.push({ name: e.name, files: t.files });
      } catch (err) {
        left.push(`the template "${e.name}" (${(err as Error).message})`);
      }
    }
  } catch {
    // no templates
  }

  const page = options.page ? cleanPage(options.page) : undefined;
  let journal: JournalEntry[] = [];
  try {
    journal = parseJournal(stripBom(fs.readFileSync(journalPath(), "utf8")));
  } catch {
    // no journal yet
  }
  return {
    format: "dx-state",
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    sites: (config.sites ?? []).filter((s) => !s.project),
    journal,
    summaries,
    templates,
    ...(page && Object.keys(page).length ? { page } : {}),
    projects,
    ...(left.length ? { left } : {}),
  };
}

// ------------------------------------------------------------------ reading a file, strictly

const SUMMARY_NAME = /^[\w-][\w.-]{0,99}\.md$/;
const TOP = new Set(["format", "version", "exportedAt", "settings", "sites", "journal", "summaries", "templates", "page", "projects", "left"]);
const PROJECT_FIELDS = new Set(["name", "remote", "tools", "mocks", "rules", "spec", "specs", "specsOff", "chaos", "scenes", "note", "alerts", "sites"]);

function obj(v: unknown, where: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new StateError(`${where} isn't an object.`);
  return v as Record<string, unknown>;
}
function list(v: unknown, where: string, max: number): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) throw new StateError(`${where} is a list of at most ${max}.`);
  return v;
}
function only(o: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new StateError(`${where} has "${k}", which isn't something a dx state file has.`);
}

function cleanPage(input: unknown): Record<string, string> {
  const o = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const k of STATE_PAGE_PREFS) {
    const v = o[k];
    if (typeof v === "string" && v.length <= 200 && !/[\0-\x1f]/.test(v)) out[k] = v;
  }
  return out;
}

function cleanSettings(input: unknown): StateSettings {
  const o = obj(input ?? {}, "settings");
  const out: StateSettings = {};
  const bool = (k: PortableKey) => typeof o[k] === "boolean" && ((out as Record<string, unknown>)[k] = o[k]);
  const int = (k: PortableKey, min: number, max: number) => Number.isInteger(o[k]) && (o[k] as number) >= min && (o[k] as number) <= max && ((out as Record<string, unknown>)[k] = o[k]);
  for (const k of ["autoConnectAi", "localDomains", "activity", "localhostRecording", "visualDiff", "visualMobile", "envAlerts"] as const) bool(k);
  int("scanDepth", 1, 6);
  int("devServerTimeout", 5, 600);
  int("localDomainsPort", 0, 65535);
  int("activityDays", 1, 90);
  int("activityMaxMB", 50, 20000);
  if (typeof o.editor === "string" && EDITORS.has(o.editor)) out.editor = o.editor;
  if (typeof o.githubUser === "string" && /^[A-Za-z0-9-]{1,39}$/.test(o.githubUser)) out.githubUser = o.githubUser;
  if (typeof o.terminal === "string" && /^[a-z0-9-]{1,30}$/.test(o.terminal)) out.terminal = o.terminal;
  if (o.aiCli === "claude" || o.aiCli === "codex") out.aiCli = o.aiCli;
  if (Array.isArray(o.ignore)) out.ignore = o.ignore.filter((x): x is string => typeof x === "string" && /^[^\\/\0\r\n]{1,100}$/.test(x)).slice(0, 100);
  if (Array.isArray(o.projectsRoots)) out.projectsRoots = o.projectsRoots.filter((r): r is string => !!fromHome(r)).slice(0, 20);
  if (o.floppyColourway === "navy" || o.floppyColourway === "charcoal" || o.floppyColourway === "maroon") out.floppyColourway = o.floppyColourway;
  return out;
}

function cleanSite(input: unknown, where: string): SiteConfig {
  const o = obj(input, where);
  try {
    const host = normalizeSiteHost(String(o.host ?? ""));
    const label = typeof o.label === "string" ? o.label.trim().slice(0, 60) : "";
    return { host, env: normalizeEnv(o.env, host), ...(label ? { label } : {}) };
  } catch (err) {
    throw new StateError(`${where}: ${(err as Error).message}`);
  }
}

function cleanProject(input: unknown, i: number): StateProject {
  const where = `Project ${i + 1}`;
  const o = obj(input, where);
  only(o, PROJECT_FIELDS, where);
  if (typeof o.name !== "string" || !o.name.trim() || o.name.length > 100) throw new StateError(`${where} needs a name.`);
  const p: StateProject = { name: o.name.trim() };
  const at = `${p.name}:`;
  if (o.remote !== undefined) {
    if (typeof o.remote !== "string" || !/^[a-z0-9.-]+(\/[\w.~-]+)+$/.test(o.remote) || o.remote.split("/").includes("..")) throw new StateError(`${at} its remote isn't host/owner/repo.`);
    p.remote = o.remote;
  }
  const wrap = <T>(what: string, fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      throw new StateError(`${at} ${what}: ${(err as Error).message}`);
    }
  };
  const tools = list(o.tools, `${at} tools`, 100);
  if (tools.length) p.tools = tools.map((t, n) => wrap(`tool ${n + 1}`, () => cleanTool(t)));
  if (o.mocks !== undefined) {
    const m = obj(o.mocks, `${at} mocks`);
    only(m, new Set(["endpoints"]), `${at} mocks`);
    p.mocks = { endpoints: list(m.endpoints, `${at} mocks`, MOCK_ENDPOINTS_MAX).map((e, n) => wrap(`mock ${n + 1}`, () => cleanMockEndpoint(e))) };
  }
  const rules = list(o.rules, `${at} rules`, RULES_MAX);
  if (rules.length)
    p.rules = rules.map((r, n) =>
      wrap(`rule ${n + 1}`, () => {
        const rule = cleanRule(r);
        if (!rule) throw new StateError("it isn't a rule.");
        return rule;
      }),
    );
  // One spec (`spec`, from files made before there could be several) or a list of them (`specs`).
  const oneSpec = (raw: unknown, n: number): NonNullable<StateProject["specs"]>[number] => {
    const s = obj(raw, `${at} API ${n + 1}`);
    only(s, new Set(["id", "name", "source", "doc", "service", "mount"]), `${at} API ${n + 1}`);
    if (typeof s.source !== "string" || !/^(file:[^\0\r\n]{1,500}|url:\/[^\0\r\n]{0,500}|pasted)$/.test(s.source) || (s.source.startsWith("file:") && s.source.split(/[\\/]/).includes(".."))) throw new StateError(`${at} the API's source isn't right.`);
    const doc = obj(s.doc, `${at} API ${n + 1}`);
    if ((typeof doc.openapi !== "string" && typeof doc.swagger !== "string") || !doc.paths || typeof doc.paths !== "object") throw new StateError(`${at} API ${n + 1} isn't an OpenAPI or Swagger document.`);
    wrap(`API ${n + 1}`, () => readSpec(doc));
    const out: NonNullable<StateProject["specs"]>[number] = { source: s.source, doc };
    if (s.id !== undefined) {
      if (typeof s.id !== "string" || !/^[a-z0-9-]{1,40}$/.test(s.id)) throw new StateError(`${at} an API's id isn't right.`);
      out.id = s.id;
    }
    if (s.name !== undefined) {
      if (typeof s.name !== "string" || !s.name.trim() || s.name.length > 60) throw new StateError(`${at} an API's name isn't right.`);
      out.name = s.name.trim();
    }
    if (s.service !== undefined) {
      if (typeof s.service !== "string" || !/^[\w.-]{1,60}$/.test(s.service)) throw new StateError(`${at} an API's service isn't right.`);
      out.service = s.service;
    }
    if (s.mount !== undefined) {
      if (typeof s.mount !== "string" || !/^\/[\w./{}~-]{0,200}$/.test(s.mount)) throw new StateError(`${at} where an API is served isn't right.`);
      out.mount = s.mount;
    }
    return out;
  };
  if (o.spec !== undefined) {
    const s = obj(o.spec, `${at} spec`);
    if (s.off === true && Object.keys(s).length === 1) p.specsOff = true;
    else p.specs = [oneSpec(s, 0)];
  }
  const specs = list(o.specs, `${at} API specs`, 20);
  if (specs.length) p.specs = specs.map(oneSpec);
  if (o.specsOff === true) p.specsOff = true;
  if (o.chaos !== undefined) {
    const c = obj(o.chaos, `${at} chaos`);
    only(c, new Set(["level", "faults", "seed", "paths", "clock", "phone", "locale"]), `${at} chaos`);
    const cleaned = wrap("chaos", () => cleanChaos(c as Partial<Record<keyof ChaosConfig, unknown>>));
    delete cleaned.on;
    p.chaos = cleaned;
  }
  const scenes = list(o.scenes, `${at} data scenes`, 50);
  if (scenes.length)
    p.scenes = scenes.map((raw, n) => {
      const s = obj(raw, `${at} data scene ${n + 1}`);
      only(s, new Set(["format", "version", "name", "kind", "createdAt", "order", "rows", "recipe", "seed"]), `${at} data scene ${n + 1}`);
      if (s.format !== "dx-scene" || s.version !== 1 || (s.kind !== "made" && s.kind !== "saved")) throw new StateError(`${at} data scene ${n + 1} isn't a dx scene.`);
      wrap(`data scene ${n + 1}`, () => sceneSlug(String(s.name ?? "")));
      if (!Array.isArray(s.order) || !s.order.every((t) => typeof t === "string" && /^[\w.-]{1,100}$/.test(t))) throw new StateError(`${at} data scene ${n + 1}'s tables aren't right.`);
      const rows = obj(s.rows, `${at} data scene ${n + 1}'s rows`);
      for (const [t, r] of Object.entries(rows)) if (!/^[\w.-]{1,100}$/.test(t) || !Array.isArray(r) || !r.every((x) => x && typeof x === "object" && !Array.isArray(x))) throw new StateError(`${at} data scene ${n + 1}'s rows aren't right.`);
      return { format: "dx-scene", version: 1, name: String(s.name).slice(0, 100), kind: s.kind as Scene["kind"], createdAt: typeof s.createdAt === "string" ? s.createdAt.slice(0, 40) : new Date().toISOString(), order: s.order as string[], rows: rows as Scene["rows"], ...(typeof s.recipe === "string" ? { recipe: s.recipe.slice(0, 40) } : {}), ...(Number.isInteger(s.seed) ? { seed: s.seed as number } : {}) };
    });
  if (o.note !== undefined) {
    const n = obj(o.note, `${at} note`);
    if (typeof n.text !== "string" || !n.text.trim() || n.text.length > 2000 || (n.by !== "you" && n.by !== "ai") || typeof n.at !== "string" || Number.isNaN(Date.parse(n.at))) throw new StateError(`${at} its note isn't right.`);
    p.note = { text: n.text, by: n.by, at: new Date(n.at).toISOString() };
  }
  if (o.alerts !== undefined) {
    const a = obj(o.alerts, `${at} alerts`);
    p.alerts = { ...(a.off === true ? { off: true } : {}), ...(a.osOff === true ? { osOff: true } : {}) };
  }
  const sites = list(o.sites, `${at} sites`, 50);
  if (sites.length) p.sites = sites.map((s, n) => cleanSite(s, `${at} site ${n + 1}`));
  return p;
}

/** A dx state file, read strictly: its format and version, known fields only, every value checked as dx checks its own. */
export function readState(input: unknown): DxState {
  let raw = input;
  if (typeof raw === "string") {
    if (raw.length > STATE_MAX) throw new StateError("A dx state file can be at most 25 MB.", 413);
    try {
      raw = JSON.parse(stripBom(raw));
    } catch {
      throw new StateError("That file isn't JSON. Choose a file dx made with Export.");
    }
  }
  const o = obj(raw, "The file");
  if (o.format !== "dx-state") throw new StateError("That isn't a dx state file. Choose a file dx made with Export.");
  if (o.version !== 1) throw new StateError("That dx state file is from a newer dx. Update dx here first (dx update).");
  only(o, TOP, "The file");
  const journal = list(o.journal, "The journal", 100_000).map((e) => {
    const j = obj(e, "A journal entry");
    if (typeof j.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(j.date) || typeof j.time !== "string" || !/^(\d{2}:\d{2})?$/.test(j.time) || typeof j.text !== "string" || !j.text.trim() || j.text.length > 2000 || /[\r\n]/.test(j.text)) throw new StateError("A journal entry isn't right.");
    return { date: j.date, time: j.time, text: j.text.trim() };
  });
  const summaries = list(o.summaries, "Summaries", 2000).map((s) => {
    const x = obj(s, "A summary");
    if (typeof x.name !== "string" || !SUMMARY_NAME.test(x.name) || typeof x.text !== "string" || x.text.length > 1024 * 1024) throw new StateError("A saved summary isn't right.");
    return { name: x.name, text: x.text };
  });
  let templateBytes = 0;
  const templates = list(o.templates, "Templates", 200).map((t) => {
    const x = obj(t, "A template");
    if (typeof x.name !== "string" || !isValidProjectName(x.name) || x.name.startsWith(".")) throw new StateError("A template's name isn't right.");
    const files = list(x.files, `The template "${x.name}"`, 20_000).map((f) => {
      const y = obj(f, `A file of the template "${x.name}"`);
      const p = y.path;
      if (typeof p !== "string" || p.length > 500 || p.startsWith("/") || /^[a-zA-Z]:/.test(p) || p.split("/").some((s) => !s || s === "." || s === ".." || s === ".git" || s === "node_modules" || /[\\<>:"|?*\0-\x1f]/.test(s))) throw new StateError(`A file of the template "${x.name}" has a path dx won't write.`);
      if (typeof y.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(y.data)) throw new StateError(`A file of the template "${x.name}" isn't right.`);
      const size = Math.floor((y.data.length * 3) / 4);
      if (size > TEMPLATE_FILE_MAX) throw new StateError(`A file of the template "${x.name}" is over 2 MB.`);
      templateBytes += size;
      return { path: p, data: y.data };
    });
    return { name: x.name, files };
  });
  if (templateBytes > TEMPLATES_MAX + 1024 * 1024) throw new StateError("The templates take more than 10 MB.");
  const projects = list(o.projects, "Projects", 2000).map(cleanProject);
  return {
    format: "dx-state",
    version: 1,
    exportedAt: typeof o.exportedAt === "string" && !Number.isNaN(Date.parse(o.exportedAt)) ? new Date(o.exportedAt).toISOString() : "",
    settings: cleanSettings(o.settings),
    sites: list(o.sites, "Sites", 200).map((s, n) => cleanSite(s, `Site ${n + 1}`)),
    journal,
    summaries,
    templates,
    ...(o.page !== undefined ? { page: cleanPage(o.page) } : {}),
    projects,
    left: list(o.left, "left", 500).filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 300)),
  };
}

// ------------------------------------------------------------------ what an import would do

export interface StatePlanProject {
  index: number;
  name: string;
  remote?: string;
  /** What it brings: tools 3, mocks 12, rules 1, spec 1, chaos 1, scenes 2, note 1, alerts 1, sites 1. */
  has: Record<string, number>;
  /** The project here it goes to, and how it was found. */
  match?: { dir: string; name: string; by: "remote" | "name" };
}

export interface StatePlan {
  exportedAt: string;
  /** Settings that would change: the key, its name in words, and both values as text. */
  settings: { key: string; name: string; from: string; to: string }[];
  /** Projects folders it adds (they exist here). */
  roots: string[];
  sites: number;
  journal: { entries: number; adds: number };
  summaries: { adds: number; changes: number };
  templates: { name: string; status: "new" | "changes" | "same" }[];
  page: number;
  projects: StatePlanProject[];
  /** Projects here, for choosing another match. */
  local: { dir: string; name: string }[];
  left: string[];
}

const show = (v: unknown) => (v === undefined ? "the default" : typeof v === "boolean" ? (v ? "on" : "off") : Array.isArray(v) ? v.join(", ") : String(v));
/** Settings in words, as the Settings page and `dx config` name them. */
const SETTING_NAMES: Record<string, string> = {
  editor: "Editor",
  scanDepth: "How deep to look for projects",
  ignore: "Folders never scanned",
  devServerTimeout: "Seconds to wait for a dev server",
  githubUser: "GitHub username",
  autoConnectAi: "Connect new AI tools",
  localDomains: "name.localhost addresses",
  localDomainsPort: "Port for name.localhost",
  activity: "Activity history",
  activityDays: "Days of activity history",
  activityMaxMB: "Most space for activity history (MB)",
  localhostRecording: "Record apps at localhost:<port>",
  visualDiff: "Visual diffs",
  visualMobile: "Visual diffs at phone size",
  envAlerts: ".env alerts",
  terminal: "Terminal",
  aiCli: "AI coding tool",
  floppyColourway: "Floppy's colours",
};

function settingsChanges(state: DxState, config: DxConfig): StatePlan["settings"] {
  const out: StatePlan["settings"] = [];
  for (const k of PORTABLE) {
    const to = state.settings[k];
    if (to === undefined) continue;
    const from = config[k];
    if (JSON.stringify(from) !== JSON.stringify(to)) out.push({ key: k, name: SETTING_NAMES[k] ?? k, from: show(from), to: show(to) });
  }
  if (state.settings.floppyColourway && state.settings.floppyColourway !== (config.floppy?.colourway ?? "navy")) out.push({ key: "floppyColourway", name: SETTING_NAMES.floppyColourway, from: config.floppy?.colourway ?? "navy", to: state.settings.floppyColourway });
  return out;
}

function rootsToAdd(state: DxState, config: DxConfig): string[] {
  return (state.settings.projectsRoots ?? []).flatMap((r) => {
    const dir = fromHome(r)!;
    try {
      if (!fs.statSync(dir).isDirectory() || config.projectsRoots.some((x) => same(x, dir))) return [];
    } catch {
      return [];
    }
    return [dir];
  });
}

function hasOf(p: StateProject): Record<string, number> {
  const has: Record<string, number> = {};
  if (p.tools?.length) has.tools = p.tools.length;
  if (p.mocks?.endpoints.length) has.mocks = p.mocks.endpoints.length;
  if (p.rules?.length) has.rules = p.rules.length;
  if (p.specs?.length) has.specs = p.specs.length;
  else if (p.specsOff) has.specs = 0;
  if (p.chaos) has.chaos = 1;
  if (p.scenes?.length) has.scenes = p.scenes.length;
  if (p.note) has.note = 1;
  if (p.alerts) has.alerts = 1;
  if (p.sites?.length) has.sites = p.sites.length;
  return has;
}

/**
 * Each project in the file matched to one here, each project here taken once: the same repository
 * and folder name first; then the same repository when it's the only clone here of it left; then
 * the same folder name when the remotes don't disagree. Two clones of one repository on the other
 * computer never both land on the one here.
 */
export function matchProjects(state: DxState, projects: Project[], remotes: Map<string, string>): (StatePlanProject["match"] | undefined)[] {
  const taken = new Set<string>();
  const out: (StatePlanProject["match"] | undefined)[] = state.projects.map(() => undefined);
  const free = (p: Project) => !taken.has(p.dir);
  const named = (sp: StateProject) => (p: Project) => p.name.toLowerCase() === sp.name.toLowerCase();
  const take = (i: number, p: Project | undefined, by: "remote" | "name") => {
    if (!p) return;
    taken.add(p.dir);
    out[i] = { dir: p.dir, name: p.name, by };
  };
  state.projects.forEach((sp, i) => sp.remote && take(i, projects.find((p) => free(p) && remotes.get(p.dir) === sp.remote && named(sp)(p)), "remote"));
  state.projects.forEach((sp, i) => {
    if (out[i] || !sp.remote) return;
    const clones = projects.filter((p) => free(p) && remotes.get(p.dir) === sp.remote);
    const sameRepo = state.projects.filter((x) => x.remote === sp.remote && x !== sp);
    // Another project in the file with this clone's name will want it.
    if (clones.length === 1 && !sameRepo.some((x) => named(x)(clones[0]))) take(i, clones[0], "remote");
  });
  state.projects.forEach((sp, i) => !out[i] && take(i, projects.find((p) => free(p) && named(sp)(p) && (!sp.remote || !remotes.get(p.dir))), "name"));
  return out;
}

export async function planStateImport(state: DxState, projects: Project[], config: DxConfig = loadConfig()): Promise<StatePlan> {
  const matches = matchProjects(state, projects, await projectRemotes(projects));
  let journalText = "";
  try {
    journalText = stripBom(fs.readFileSync(journalPath(), "utf8"));
  } catch {
    // none yet
  }
  const summaries = { adds: 0, changes: 0 };
  for (const s of state.summaries) {
    try {
      if (fs.readFileSync(path.join(summariesDir(), s.name), "utf8") !== s.text) summaries.changes++;
    } catch {
      summaries.adds++;
    }
  }
  const tdir = templatesDir(config);
  return {
    exportedAt: state.exportedAt,
    settings: settingsChanges(state, config),
    roots: rootsToAdd(state, config),
    sites: state.sites.length + state.projects.reduce((n, p) => n + (p.sites?.length ?? 0), 0),
    journal: { entries: state.journal.length, adds: mergeJournalText(journalText, state.journal).added },
    summaries,
    templates: state.templates.map((t) => {
      const dir = path.join(tdir, t.name);
      if (!fs.existsSync(dir)) return { name: t.name, status: "new" as const };
      const differs = t.files.some((f) => {
        try {
          return !fs.readFileSync(path.join(dir, ...f.path.split("/"))).equals(Buffer.from(f.data, "base64"));
        } catch {
          return true;
        }
      });
      return { name: t.name, status: differs ? ("changes" as const) : ("same" as const) };
    }),
    page: Object.keys(state.page ?? {}).length,
    projects: state.projects.map((p, index) => ({ index, name: p.name, ...(p.remote ? { remote: p.remote } : {}), has: hasOf(p), ...(matches[index] ? { match: matches[index] } : {}) })),
    local: projects.map((p) => ({ dir: p.dir, name: p.name })).sort((a, b) => a.name.localeCompare(b.name)),
    left: state.left ?? [],
  };
}

// ------------------------------------------------------------------ importing, with a way back

interface Backup {
  format: "dx-state-backup";
  version: 1;
  at: string;
  /** The folders the files are relative to, as they were for this import. */
  bases: { home: string; templates: string };
  files: BackupFile[];
}

interface BackupFile {
  base: "home" | "templates";
  rel: string;
  /** The file as it was (base64), or null when it wasn't there. */
  data: string | null;
}

/** Remembers each file as it was before the import first writes it. */
class Before {
  files = new Map<string, BackupFile>();
  constructor(private templates: string) {}

  touch(file: string): void {
    const full = path.resolve(file);
    if (this.files.has(full)) return;
    const inside = (base: string) => {
      const rel = path.relative(path.resolve(base), full);
      return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : undefined;
    };
    const home = inside(dxHome());
    const tpl = home === undefined ? inside(this.templates) : undefined;
    if (home === undefined && tpl === undefined) throw new StateError("dx only writes inside its own folder and the templates folder.");
    let data: string | null = null;
    try {
      data = fs.readFileSync(full).toString("base64");
    } catch {
      // wasn't there
    }
    this.files.set(full, { base: home !== undefined ? "home" : "templates", rel: (home ?? tpl)!.split(path.sep).join("/"), data });
  }

  put(file: string, content: string | Buffer): void {
    this.touch(file);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}

export interface StateImportResult {
  /** The backup the import can be undone from. */
  backup: string;
  projects: { name: string; dir: string; brought: Record<string, number> }[];
  skipped: string[];
  settings: number;
  roots: number;
  sites: number;
  journal: number;
  summaries: number;
  templates: number;
  page?: Record<string, string>;
  notes: string[];
}

function backupsDir(): string {
  return dxPath("state-backups");
}

/**
 * Brings a state file's contents in. Where both have something, the file's wins; nothing here is
 * deleted; mock mode and Chaos mode stay switched as they are here. Every file is backed up first,
 * so `undoStateImport` puts it all back. `map` picks the project here for each project in the file
 * (by index; null leaves it out), else the match `planStateImport` found.
 */
export async function importState(state: DxState, options: { projects: Project[]; map?: Record<string, string | null>; settings?: boolean; config?: DxConfig }): Promise<StateImportResult> {
  const config = options.config ?? loadConfig();
  // Templates always go into this computer's own templates folder: a file never says where dx writes.
  const tdir = path.resolve(templatesDir(config));
  const before = new Before(tdir);
  const result: StateImportResult = { backup: "", projects: [], skipped: [], settings: 0, roots: 0, sites: 0, journal: 0, summaries: 0, templates: 0, notes: [] };
  const matches = matchProjects(state, options.projects, await projectRemotes(options.projects));
  let configChanged = false;

  // Settings, folders and sites that belong to no project.
  if (options.settings !== false) {
    const changes = settingsChanges(state, config);
    for (const k of PORTABLE) if (state.settings[k] !== undefined && changes.some((c) => c.key === k)) (config as unknown as Record<string, unknown>)[k] = state.settings[k];
    if (changes.some((c) => c.key === "floppyColourway")) config.floppy = { ...config.floppy, colourway: state.settings.floppyColourway };
    result.settings = changes.length;
    const roots = rootsToAdd(state, config);
    config.projectsRoots = [...config.projectsRoots, ...roots];
    result.roots = roots.length;
    configChanged = changes.length > 0 || roots.length > 0;
  }
  const putSite = (site: SiteConfig) => {
    config.sites = [...(config.sites ?? []).filter((s) => s.host !== site.host), site];
    result.sites++;
    configChanged = true;
  };
  for (const s of state.sites) putSite(s);

  try {
  // Per project.
  for (const [index, sp] of state.projects.entries()) {
    const chosen = options.map && Object.hasOwn(options.map, String(index)) ? options.map[String(index)] : matches[index]?.dir;
    const project = chosen ? options.projects.find((p) => same(p.dir, chosen)) : undefined;
    if (!project) {
      result.skipped.push(sp.name);
      continue;
    }
    const brought: Record<string, number> = {};
    const dir = project.dir;
    if (sp.tools?.length) {
      before.touch(toolsFile(dir));
      try {
        const r = importTools(dir, sp.tools.map((t) => cleanTool(t)), { replace: true });
        brought.tools = r.added + r.replaced;
      } catch (err) {
        result.notes.push(`${project.name}: ${(err as Error).message}`);
      }
    }
    if (sp.mocks?.endpoints.length) {
      before.touch(mockFile(dir));
      const set = loadMocks(dir, project.name);
      const byId = new Map(set.endpoints.map((e) => [e.id, e]));
      for (const e of sp.mocks.endpoints) byId.set(e.id, e);
      set.endpoints = [...byId.values()].slice(0, MOCK_ENDPOINTS_MAX);
      saveMocks(set);
      brought.mocks = sp.mocks.endpoints.length;
    }
    if (sp.rules?.length) {
      before.touch(rulesFile(dir));
      const set = loadRules(dir, project.name);
      const byId = new Map(set.rules.map((r) => [r.id, r]));
      for (const r of sp.rules) byId.set(r.id, r);
      set.rules = [...byId.values()].slice(0, RULES_MAX);
      saveRules(set);
      brought.rules = sp.rules.length;
    }
    if (sp.specs?.length || sp.specsOff) {
      before.touch(specFile(dir));
      if (sp.specs?.length) {
        // Each API replaces the one with its id here, or the one from the same file; the others stay.
        for (const x of sp.specs) {
          try {
            saveSpec(dir, x.source, x.doc, { id: x.id, name: x.name, service: x.service, mount: x.mount });
          } catch (err) {
            result.notes.push(`${project.name}: ${(err as Error).message}`);
          }
        }
        brought.specs = sp.specs.length;
      } else {
        forgetSpec(dir);
        brought.specs = 0;
      }
    }
    if (sp.chaos) {
      before.touch(chaosFile(dir));
      const c = loadChaos(dir, project.name);
      saveChaos({ ...c, ...sp.chaos, on: c.on });
      brought.chaos = 1;
    }
    if (sp.scenes?.length) {
      for (const s of sp.scenes) before.put(path.join(scenesFolder(dir), `${sceneSlug(s.name)}.json`), JSON.stringify(s));
      brought.scenes = sp.scenes.length;
    }
    if (sp.note) {
      before.touch(dxPath("sessions.json"));
      if (importNote(dir, project.name, sp.note)) brought.note = 1;
    }
    if (sp.alerts) {
      const key = alertKey(dir);
      const next = { ...(sp.alerts.off ? { off: true } : {}), ...(sp.alerts.osOff ? { osOff: true } : {}) };
      config.projectAlerts = { ...config.projectAlerts, [key]: next };
      if (!Object.keys(next).length) delete config.projectAlerts[key];
      configChanged = true;
      brought.alerts = 1;
    }
    for (const s of sp.sites ?? []) {
      putSite({ ...s, project: dir });
      brought.sites = (brought.sites ?? 0) + 1;
    }
    result.projects.push({ name: project.name, dir, brought });
  }

  // The journal, saved summaries and templates.
  let journalText = "";
  try {
    journalText = stripBom(fs.readFileSync(journalPath(), "utf8"));
  } catch {
    // none yet
  }
  const merged = mergeJournalText(journalText, state.journal);
  if (merged.added) {
    before.put(journalPath(), merged.text);
    result.journal = merged.added;
  }
  for (const s of state.summaries) {
    const file = path.join(summariesDir(), s.name);
    let cur: string | undefined;
    try {
      cur = fs.readFileSync(file, "utf8");
    } catch {
      // new
    }
    if (cur === s.text) continue;
    before.put(file, s.text);
    result.summaries++;
  }
  for (const t of state.templates) {
    let changed = false;
    for (const f of t.files) {
      const file = path.join(tdir, t.name, ...f.path.split("/"));
      const data = Buffer.from(f.data, "base64");
      try {
        if (fs.readFileSync(file).equals(data)) continue;
      } catch {
        // new
      }
      before.put(file, data);
      changed = true;
    }
    if (changed) result.templates++;
  }

  if (configChanged) {
    before.touch(configPath());
    saveConfig(config);
  }
  } catch (err) {
    // Stopped part-way: what it wrote goes back, so an import is all or nothing.
    writeBackup(before, tdir);
    undoStateImport(config);
    throw new StateError(`Nothing was imported: ${(err as Error).message}`, err instanceof StateError ? err.status : 500);
  }
  if (state.page && options.settings !== false) result.page = state.page;
  result.backup = writeBackup(before, tdir);
  return result;
}

/** The backup of an import: every file as it was before, and the folders they're in. */
function writeBackup(before: Before, templates: string): string {
  fs.mkdirSync(backupsDir(), { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${stamp}-${crypto.randomBytes(3).toString("hex")}.json`;
  const backup: Backup = { format: "dx-state-backup", version: 1, at: new Date().toISOString(), bases: { home: path.resolve(dxHome()), templates }, files: [...before.files.values()] };
  fs.writeFileSync(path.join(backupsDir(), name), JSON.stringify(backup), { mode: 0o600 });
  for (const old of listBackups().slice(BACKUPS_KEPT)) fs.rmSync(path.join(backupsDir(), old.name), { force: true });
  return name;
}

function listBackups(): { name: string; at: string }[] {
  try {
    return fs
      .readdirSync(backupsDir())
      .filter((f) => /^[\w-]+\.json$/.test(f))
      .map((f) => ({ name: f, at: (readJsonFile(path.join(backupsDir(), f))?.at as string) ?? "" }))
      .filter((b) => b.at)
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch {
    return [];
  }
}

/** The last import that can be undone, if any. */
export function lastStateImport(): { name: string; at: string } | undefined {
  return listBackups()[0];
}

/** Puts back every file the last import changed (and removes the ones it made), then forgets that backup. */
export function undoStateImport(config: DxConfig = loadConfig()): { at: string; files: number } {
  const last = listBackups()[0];
  if (!last) throw new StateError("There's no import to undo.", 404);
  const backup = readJsonFile(path.join(backupsDir(), last.name)) as Partial<Backup> | undefined;
  if (!backup || backup.format !== "dx-state-backup" || !Array.isArray(backup.files)) throw new StateError("That backup can't be read.");
  // dx's own folder is always this one; the templates folder is the one the import wrote to (the setting may have changed since).
  const recorded = typeof backup.bases?.templates === "string" && path.isAbsolute(backup.bases.templates) ? backup.bases.templates : undefined;
  const bases = { home: path.resolve(dxHome()), templates: path.resolve(recorded ?? templatesDir(config)) };
  const files: { full: string; data: string | null }[] = [];
  for (const f of backup.files as BackupFile[]) {
    if (!f || (f.base !== "home" && f.base !== "templates") || typeof f.rel !== "string" || (f.data !== null && typeof f.data !== "string")) throw new StateError("That backup isn't one dx wrote.");
    const base = bases[f.base];
    const full = path.resolve(base, ...f.rel.split("/"));
    const rel = path.relative(base, full);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new StateError("That backup names a file outside dx's folders.");
    files.push({ full, data: f.data });
  }
  for (const f of files) {
    if (f.data === null) fs.rmSync(f.full, { force: true });
    else {
      fs.mkdirSync(path.dirname(f.full), { recursive: true, mode: 0o700 });
      const tmp = `${f.full}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, Buffer.from(f.data, "base64"), { mode: 0o600 });
      fs.renameSync(tmp, f.full);
    }
  }
  fs.rmSync(path.join(backupsDir(), last.name), { force: true });
  return { at: last.at, files: files.length };
}

/** What a state file holds, in a line: for the CLI and the run log. */
export function stateSummary(s: DxState): string {
  const n = (k: keyof StateProject) => s.projects.reduce((t, p) => t + (Array.isArray(p[k]) ? (p[k] as unknown[]).length : k === "mocks" ? (p.mocks?.endpoints.length ?? 0) : p[k] ? 1 : 0), 0);
  const parts = [
    `${s.projects.length} project${s.projects.length === 1 ? "" : "s"}`,
    n("tools") && `${n("tools")} tools`,
    n("mocks") && `${n("mocks")} mocks`,
    n("rules") && `${n("rules")} rules`,
    n("specs") && `${n("specs")} API specs`,
    n("chaos") && `${n("chaos")} chaos settings`,
    n("scenes") && `${n("scenes")} data scenes`,
    n("note") && `${n("note")} notes`,
    s.journal.length && `${s.journal.length} journal entries`,
    s.summaries.length && `${s.summaries.length} saved summaries`,
    s.templates.length && `${s.templates.length} templates`,
  ].filter(Boolean);
  return parts.join(", ");
}
