import path from "node:path";
import { loadConfig, saveConfig, type DxConfig } from "../config.js";
import { siteDir, type Deployment } from "./activity.js";

/**
 * Recorded sites: the hosts the dx browser records, besides addresses on this computer. A site
 * can be linked to one of your projects (its activity then shows under that project, labelled by
 * environment), and says which environment it is: staging, production or a label of your own.
 */

export interface SiteConfig {
  /** A host name, or host:port; "*.shop-website.dev" for every subdomain. */
  host: string;
  /** The project it belongs to, by folder. */
  project?: string;
  /** local, staging, production, or a label of your own. */
  env?: string;
  /** A name to show instead of the host. */
  label?: string;
}

export interface SiteTarget {
  /** The folder its events go under: the linked project, or site:<host>. */
  dir: string;
  project: string;
  site: string;
  env: string;
  service?: string;
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|[\w.-]+\.localhost)$/i;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * A host as dx keeps it: lowercase, host or host:port, no scheme, path, user or wildcard other
 * than a leading "*.". An address pasted whole (https://staging.shop-website.dev/cart) gives its host.
 */
export function normalizeSiteHost(raw: string): string {
  let s = String(raw ?? "").trim().toLowerCase();
  if (!s) throw new Error("Which site? Give its host, e.g. staging.shop-website.dev.");
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      throw new Error(`${raw} isn't an address dx can read.`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http and https sites can be recorded.");
    s = u.host;
  } else if (/[/?#@\\\s]/.test(s)) {
    throw new Error("Give only the host (staging.shop-website.dev or localhost:3000): no path, no user name.");
  }
  s = s.replace(/\.$/, "");
  const wildcard = s.startsWith("*.");
  const body = wildcard ? s.slice(2) : s;
  const m = /^(\[[0-9a-f:]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(body);
  if (!m) throw new Error(`${raw} isn't a host name.`);
  const [, name, port] = m;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) throw new Error(`${port} isn't a port.`);
  if (name.includes("*")) throw new Error('Only a leading "*." is allowed, for every subdomain: *.shop-website.dev.');
  const isIp6 = name.startsWith("[");
  const labels = name.split(".");
  if (!isIp6 && (!labels.every((l) => LABEL.test(l)) || name.length > 253)) throw new Error(`${raw} isn't a host name.`);
  if (wildcard && (isIp6 || labels.length < 2 || /^\d+$/.test(labels[labels.length - 1]))) throw new Error("A wildcard needs a domain under it: *.shop-website.dev.");
  return `${wildcard ? "*." : ""}${name}${port ? `:${port}` : ""}`;
}

/** The environment a host probably is, when the site doesn't say. */
export function guessEnv(host: string): string {
  const name = host.replace(/^\*\./, "").split(":")[0];
  if (LOOPBACK.test(name) || name.endsWith(".test") || name.endsWith(".local")) return "local";
  // The words of the name, without the top-level domain: shop-website.dev isn't a dev site.
  const labels = name.split(".").slice(0, -1).join(".").split(/[.-]/);
  if (labels.some((l) => l === "staging" || l === "stage" || l === "stg")) return "staging";
  for (const env of ["preview", "dev", "qa", "uat", "test", "sandbox", "demo"]) if (labels.includes(env)) return env;
  return "production";
}

/** An environment name as dx keeps it: lowercase letters, digits, - and _, at most 24. */
export function normalizeEnv(raw: unknown, host: string): string {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!s) return guessEnv(host);
  if (!/^[a-z0-9][a-z0-9_-]{0,23}$/.test(s)) throw new Error("Name the environment with letters, digits, - or _ (staging, production, qa…).");
  return s;
}

/** Whether a host from an address matches a recorded site's host. */
export function hostMatches(siteHost: string, host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const [name, port] = splitHost(h);
  const wildcard = siteHost.startsWith("*.");
  const [sName, sPort] = splitHost(wildcard ? siteHost.slice(2) : siteHost);
  if (sPort && sPort !== port) return false;
  return wildcard ? name.endsWith(`.${sName}`) : name === sName;
}

function splitHost(h: string): [string, string | undefined] {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(h);
  return m ? [m[1], m[2]] : [h, undefined];
}

export function listSites(config: DxConfig = loadConfig()): SiteConfig[] {
  return Array.isArray(config.sites) ? config.sites.filter((s) => s && typeof s.host === "string") : [];
}

/** The recorded site an address belongs to: the most specific match (an exact host before a wildcard, one with a port before one without). */
export function siteForUrl(url: string, sites: SiteConfig[]): SiteConfig | undefined {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    host = u.host;
  } catch {
    return undefined;
  }
  const score = (s: SiteConfig) => (s.host.startsWith("*.") ? 0 : 2) + (s.host.includes(":") && !s.host.startsWith("[") ? 1 : 0) + s.host.length / 1000;
  return sites.filter((s) => hostMatches(s.host, host)).sort((a, b) => score(b) - score(a))[0];
}

/** Where events on an address go, for a recorded site or an address on this computer; undefined for anything else. */
export function siteTarget(url: string, sites: SiteConfig[]): SiteTarget | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  const site = siteForUrl(url, sites);
  if (site) {
    const env = site.env || guessEnv(site.host);
    if (site.project) return { dir: site.project, project: path.basename(site.project), site: u.host, env };
    return { dir: siteDir(site.host), project: site.label || site.host, site: u.host, env };
  }
  if (LOOPBACK.test(u.hostname)) return { dir: siteDir(u.host), project: u.host, site: u.host, env: "local" };
  return undefined;
}

export interface SiteInput {
  host: string;
  project?: string;
  env?: string;
  label?: string;
}

/** Adds a site, or changes it when its host is already there. Returns it as kept. */
export function addSite(input: SiteInput, config: DxConfig = loadConfig()): SiteConfig {
  const host = normalizeSiteHost(input.host);
  const env = normalizeEnv(input.env, host);
  const label = typeof input.label === "string" ? input.label.trim().slice(0, 60) || undefined : undefined;
  const site: SiteConfig = { host, ...(input.project ? { project: input.project } : {}), env, ...(label ? { label } : {}) };
  const sites = listSites(config).filter((s) => s.host !== host);
  sites.push(site);
  config.sites = sites;
  saveConfig(config);
  return site;
}

/** Removes a site; its recorded history stays until it's cleared or gets old. */
export function removeSite(host: string, config: DxConfig = loadConfig()): SiteConfig | undefined {
  const h = normalizeSiteHost(host);
  const sites = listSites(config);
  const found = sites.find((s) => s.host === h);
  if (!found) return undefined;
  config.sites = sites.filter((s) => s.host !== h);
  saveConfig(config);
  return found;
}

// ------------------------------------------------------------------ deployments

const COMMIT_HEADERS = ["x-commit", "x-git-commit", "x-commit-sha", "x-git-sha", "x-commit-hash", "x-revision", "x-git-revision", "x-sha"];
const VERSION_HEADERS = ["x-version", "x-app-version", "x-build", "x-build-id", "x-release", "x-app-build"];
const META_NAMES = ["commit", "git-commit", "revision", "version", "app-version", "build", "build-id", "release"];
const HASH = /^[0-9a-f]{7,40}$/i;

/** Text from a site, kept short and printable. */
function clean(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100);
  return s || undefined;
}

/** A commit hash inside a version ("1.4.0+abc1234", "build-3f2c9e1"): hex with a letter and a digit, 7 to 40 long. */
function hashIn(text: string): string | undefined {
  for (const token of text.split(/[^0-9a-z]+/i)) {
    if (HASH.test(token) && /[a-f]/i.test(token) && /\d/.test(token)) return token.toLowerCase();
  }
  return undefined;
}

/**
 * Which deployment answered, from what the site already sent: its response headers (x-commit,
 * x-version, x-vercel-deployment-url, server…) and, when given, its meta tags (version, commit,
 * build). Nothing is fetched for it.
 */
export function deploymentFrom(headers: Record<string, string> | undefined, meta: Record<string, string> = {}): Deployment | undefined {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) h[k.toLowerCase()] = v;
  const d: Deployment = { from: "" };
  const from: string[] = [];
  for (const name of COMMIT_HEADERS) {
    const v = clean(h[name]);
    if (!v) continue;
    if (HASH.test(v)) d.commit = v.toLowerCase();
    else d.version ??= v;
    from.push(`${name} header`);
    break;
  }
  for (const name of VERSION_HEADERS) {
    const v = clean(h[name]);
    if (!v || d.version) continue;
    d.version = v;
    from.push(`${name} header`);
    break;
  }
  const deployment = clean(h["x-vercel-deployment-url"]) ?? clean(h["x-nf-deploy-id"]) ?? clean(h["x-deployment-id"]);
  if (deployment) {
    d.id = deployment;
    from.push(h["x-vercel-deployment-url"] ? "x-vercel-deployment-url header" : "deployment header");
  } else if (clean(h["x-vercel-id"])) {
    d.id = clean(h["x-vercel-id"]);
    from.push("x-vercel-id header");
  }
  const metaLower: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) metaLower[k.toLowerCase()] = v;
  for (const name of META_NAMES) {
    const v = clean(metaLower[name]);
    if (!v) continue;
    if (!d.commit && HASH.test(v) && /commit|revision/.test(name)) d.commit = v.toLowerCase();
    else if (!d.version && !/commit|revision/.test(name)) d.version = v;
    else if (!d.commit && HASH.test(v)) d.commit = v.toLowerCase();
    else continue;
    from.push(`meta ${name}`);
  }
  if (!d.commit && d.version) {
    const inside = hashIn(d.version);
    if (inside) d.commit = inside;
  }
  if (!d.commit && d.id) {
    const inside = /^[0-9a-f]{7,40}$/i.test(d.id) ? d.id.toLowerCase() : undefined;
    if (inside) d.commit = inside;
  }
  if (!d.commit && !d.version && !d.id) return undefined;
  const server = clean(h.server);
  if (server) d.server = server;
  d.from = from.join(", ");
  return d;
}
