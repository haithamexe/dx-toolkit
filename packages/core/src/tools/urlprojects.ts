import { loadConfig, saveConfig, type DxConfig } from "../config.js";
import { type Project, scanProjects } from "./projects.js";
import { addSite, listSites, normalizeSiteUrl, removeSite } from "./sites.js";

/**
 * A project that is a website: an address (https://staging.shop-website.dev) with no folder of code on this
 * computer. Everything that works on an address works for it (checks, the dx browser's recording, mocks, rules
 * and Chaos mode on its API calls, the API spec, its activity); what needs the code (git, search, .env files,
 * running it) doesn't, and says so.
 *
 * It is kept in the config as a name, an address and an environment; its sites (the addresses dx records and
 * checks) are the config's `sites` linked to it. Its folder-shaped key is `site:<host>`, the same key the
 * activity history already uses for a site that belongs to no project, so what was recorded before it became a
 * project is still its history. No folder is ever read or written for it.
 */

export interface UrlProjectConfig {
  name: string;
  url: string;
  env?: string;
  /** When it was added (ISO). */
  added: string;
}

/** The key a website project is known by, in the place a folder would be. */
export const urlProjectDir = (host: string): string => `site:${host.toLowerCase()}`;

function toProject(c: UrlProjectConfig): Project {
  const { host } = normalizeSiteUrl(c.url);
  return { name: c.name, dir: urlProjectDir(host), root: "", kind: "website", scripts: [], hasGit: false, lastActive: Date.parse(c.added) || 0, url: c.url };
}

/** The websites added as projects. */
export function listUrlProjects(config: DxConfig = loadConfig()): Project[] {
  const out: Project[] = [];
  for (const c of config.urlProjects ?? []) {
    try {
      out.push(toProject(c));
    } catch {
      // an entry that is no longer an address dx keeps is left out
    }
  }
  return out;
}

export function findUrlProject(dir: string, config: DxConfig = loadConfig()): Project | undefined {
  const wanted = dir.toLowerCase();
  return listUrlProjects(config).find((p) => p.dir.toLowerCase() === wanted);
}

export class UrlProjectError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** A name for a site that has none: its host without a leading www. */
const nameOf = (host: string) => host.replace(/^www\./, "").replace(/:\d+$/, "");

/** Adds a website as a project, with its address as the first site. Refuses a name or address that is already a project's. */
export function addUrlProject(input: { url: string; name?: string; env?: string }, config: DxConfig = loadConfig()): Project {
  let norm: { url: string; host: string };
  try {
    norm = normalizeSiteUrl(String(input.url ?? ""));
  } catch (err) {
    throw new UrlProjectError((err as Error).message);
  }
  const dir = urlProjectDir(norm.host);
  const name = (typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "") || nameOf(norm.host);
  if (name.length > 60) throw new UrlProjectError("A project's name is at most 60 characters.");
  if (/[\\/:*?"<>|\0]/.test(name)) throw new UrlProjectError("A project's name can't have any of \\ / : * ? \" < > |.");
  const existing = config.urlProjects ?? [];
  if (existing.some((p) => toProjectSafe(p)?.dir === dir)) throw new UrlProjectError(`${norm.host} is already a project here.`, 409);
  const lower = name.toLowerCase();
  if (existing.some((p) => p.name.toLowerCase() === lower) || scanProjects(config).some((p) => p.name.toLowerCase() === lower)) throw new UrlProjectError(`There's already a project called ${name}. Give this one another name.`, 409);
  // An address that belongs to another project's sites stays there.
  const owner = listSites(config).find((s) => s.host === norm.host && s.project && s.project.toLowerCase() !== dir);
  if (owner) throw new UrlProjectError(`${norm.host} is already a site of another project. Remove it there first.`, 409);
  const entry: UrlProjectConfig = { name, url: norm.url, ...(input.env ? { env: String(input.env).trim().toLowerCase() } : {}), added: new Date().toISOString() };
  let site;
  try {
    site = addSite({ url: norm.url, project: dir, env: entry.env }, config);
  } catch (err) {
    throw new UrlProjectError((err as Error).message);
  }
  entry.env = site.env;
  // addSite saved the config; read it again so the project is added to what is on disk.
  const fresh = loadConfig();
  fresh.urlProjects = [...(fresh.urlProjects ?? []), entry];
  saveConfig(fresh);
  return toProject(entry);
}

const toProjectSafe = (c: UrlProjectConfig): Project | undefined => {
  try {
    return toProject(c);
  } catch {
    return undefined;
  }
};

/** Removes a website project and its sites. What was recorded stays in the history until it is cleared or gets old. */
export function removeUrlProject(dir: string, config: DxConfig = loadConfig()): Project | undefined {
  const project = findUrlProject(dir, config);
  if (!project) return undefined;
  for (const s of listSites(config).filter((x) => x.project?.toLowerCase() === project.dir.toLowerCase())) removeSite(s.host);
  const fresh = loadConfig();
  fresh.urlProjects = (fresh.urlProjects ?? []).filter((p) => toProjectSafe(p)?.dir !== project.dir);
  saveConfig(fresh);
  return project;
}
