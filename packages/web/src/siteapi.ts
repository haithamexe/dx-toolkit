import {
  addSite,
  auditSitePage,
  setSiteApplies,
  siteApplies,
  checkSitePage,
  lastSiteChecks,
  listSites,
  projectSites,
  recordSiteCheck,
  recordRun,
  removeSite,
  siteStatus,
  type PageCheck,
  type SiteConfig,
} from "@dx/core";
import { HttpError, knownProject, type ApiRequest } from "./api.js";
import { forgetSites } from "./dxbrowser.js";

/**
 * A project's sites (`GET /api/project/sites`, add, remove, check): the deployed addresses a person
 * adds to a project so what dx does for a local app works for them too. Every route takes a known
 * project's `dir`; a check goes only to a site linked to that project, to the address dx kept for it
 * plus an optional path on the same host, never to an address from the request (core/sitecheck.ts
 * has the rules for the connection itself). What dx records of a check is the host, never the address.
 */

export interface SiteView {
  host: string;
  url: string;
  env: string;
  label?: string;
  /** Whether the project's mocks, rules and Chaos apply to this site's calls in the dx browser. */
  apply: boolean;
}

const view = (s: SiteConfig): SiteView => ({ host: s.host, url: s.url ?? `https://${s.host.replace(/^\*\./, "")}`, env: s.env ?? "production", label: s.label, apply: siteApplies({ apply: s.apply, env: s.env ?? "production" }) });

/** A path on the site, from the request: one `/`-started path with no host in it. */
function pathOn(site: SiteView, raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return site.url;
  const text = String(raw);
  // eslint-disable-next-line no-control-regex
  if (!text.startsWith("/") || text.startsWith("//") || text.includes("\\") || /[\u0000-\u001f\u007f]/.test(text) || text.length > 200) throw new HttpError(400, "A path on the site starts with one / and is at most 200 characters, like /pricing.");
  const base = new URL(site.url);
  const target = new URL(text, base.origin);
  if (target.host !== base.host) throw new HttpError(400, "A path stays on the site.");
  return `${target.origin}${target.pathname}`;
}

const running = new Set<string>();

function projectSite(dir: unknown, host: unknown): { project: ReturnType<typeof knownProject>; site: SiteConfig; sites: SiteConfig[] } {
  const project = knownProject(dir, { site: true });
  const sites = projectSites(project.dir);
  const wanted = String(host ?? "").toLowerCase();
  const site = sites.find((s) => s.host.toLowerCase() === wanted);
  if (!site) throw new HttpError(404, "That site isn't one of this project's. Add it first.");
  return { project, site, sites };
}

/** A page check without the screenshot path, which the page doesn't need. */
const pageResult = ({ screenshot: _s, ...rest }: PageCheck) => rest;

export const siteRoutes: Record<string, (req: ApiRequest) => unknown> = {
  "GET /api/project/sites": (req) => {
    const dir = knownProject(req.query.get("dir"), { site: true }).dir;
    return { sites: projectSites(dir).map((s) => ({ ...view(s), last: lastSiteChecks(dir, s.host) })) };
  },
  "POST /api/project/sites/add": (req) => {
    const project = knownProject(req.body.dir, { site: true });
    try {
      const probe = addSiteProbe(req.body.url);
      const other = listSites().find((s) => s.host === probe && s.project && s.project.toLowerCase() !== project.dir.toLowerCase());
      if (other) throw new Error(`${probe} is already a site of another project. Remove it there first.`);
      const site = addSite({ url: String(req.body.url ?? ""), project: project.dir, env: typeof req.body.env === "string" ? req.body.env : undefined, label: typeof req.body.label === "string" ? req.body.label : undefined });
      forgetSites();
      recordRun("sites", true, `${project.name}: added ${site.host} (${site.env})`, "web", { project: project.name });
      return view(site);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  },
  // Mocks, rules and Chaos for this site's calls, on or off (production starts off).
  "POST /api/project/sites/update": (req) => {
    const { project, site } = projectSite(req.body.dir, req.body.host);
    if (typeof req.body.apply !== "boolean") throw new HttpError(400, "apply is true or false.");
    const changed = setSiteApplies(site.host, req.body.apply);
    forgetSites();
    recordRun("sites", true, `${project.name}: mocks, rules and chaos ${req.body.apply ? "on" : "off"} for ${site.host}`, "web", { project: project.name });
    return view(changed ?? site);
  },
  "POST /api/project/sites/remove": (req) => {
    const { project, site } = projectSite(req.body.dir, req.body.host);
    removeSite(site.host);
    forgetSites();
    recordRun("sites", true, `${project.name}: removed ${site.host}`, "web", { project: project.name });
    return { ok: true, host: site.host };
  },
  // status: one look at the headers; page: the page in a headless browser; audit: speed and accessibility.
  "POST /api/project/sites/check": async (req) => {
    const { project, site, sites } = projectSite(req.body.dir, req.body.host);
    const what = req.body.what;
    if (what !== "status" && what !== "page" && what !== "audit") throw new HttpError(400, "What to check: status, page or audit.");
    const target = pathOn(view(site), req.body.path);
    const key = `${site.host}|${what}${req.body.phone === true ? "|phone" : ""}`;
    if (running.has(key)) throw new HttpError(409, "That check is already running.");
    running.add(key);
    try {
      let ok = true;
      let body: unknown;
      if (what === "status") {
        const r = await siteStatus(target, sites);
        ok = r.ok && !r.findings.some((f) => f.level === "bad");
        body = { what, ...r };
        recordSiteCheck(project.dir, site.host, { what, ok, status: r.status, ms: r.ms, bad: r.findings.filter((f) => f.level === "bad").length, warn: r.findings.filter((f) => f.level === "warn").length, commit: r.deployment?.commit });
      } else if (what === "page") {
        const r = await checkSitePage(target, sites, { phone: req.body.phone === true });
        ok = r.ok;
        body = { what, ...pageResult(r) };
        recordSiteCheck(project.dir, site.host, { what, ok, status: r.status, ms: r.ms, problems: r.exceptions.length + r.consoleErrors.length + r.failedRequests.length, requests: r.requests?.length });
      } else {
        const r = await auditSitePage(target, sites);
        ok = !r.error;
        body = { what, ...r };
        if (!r.error) recordSiteCheck(project.dir, site.host, { what, ok, status: r.status, loadMs: r.perf?.loadMs, lcpMs: r.perf?.lcpMs, tbtMs: r.perf?.tbtMs, cls: r.perf?.cls, jsBytes: r.perf?.jsBytes, a11y: r.a11y.length });
      }
      recordRun("site-check", ok, `${project.name}: ${what} of ${site.host}`, "web", { project: project.name });
      return body;
    } catch (err) {
      recordRun("site-check", false, `${project.name}: ${what} of ${site.host} didn't run`, "web", { project: project.name });
      throw new HttpError(400, (err as Error).message);
    } finally {
      running.delete(key);
    }
  },
};

/** The host an address would be kept under, to look for a clash before anything is written. */
function addSiteProbe(url: unknown): string {
  const { host } = normalize(String(url ?? ""));
  return host;
}

import { normalizeSiteUrl as normalize } from "@dx/core";
