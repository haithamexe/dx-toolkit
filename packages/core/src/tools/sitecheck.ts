import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { checkPage, withBrowser, type PageCheck } from "./browser.js";
import { A11Y_AUDIT, PERF_INIT, PERF_READ, type A11yIssue, type PagePerf } from "./pagehealth.js";
import type { Deployment } from "./activity.js";
import { deploymentFrom, siteForUrl, type SiteConfig } from "./sites.js";

/**
 * Checks on a site a person added to a project: its status and headers, the page loaded in a headless
 * browser, and its speed and accessibility. What local projects get from dx, for a deployed site.
 *
 * The rules, since this is the one place dx goes beyond this computer on its own:
 *  - only an address that belongs to a site added to the project (`siteForUrl`), from the site's own
 *    record, never an address from a request;
 *  - a redirect is followed only to another host that was added too, otherwise it stops and says so;
 *  - the connection refuses an address that is this computer, link-local or the cloud metadata
 *    address, judged at the moment of connecting (a name that resolves there is refused);
 *  - the browser never runs without its sandbox for a site, and its top-level navigation can't leave
 *    the added hosts;
 *  - one GET with a short body: nothing is sent to the site beyond what a browser sends to load it,
 *    nothing is tried against it (no attack checks), and cookies are read for their flags, never values.
 */

export const siteAllows = (sites: SiteConfig[]) => (url: string) => !!siteForUrl(url, sites);

/** An address a connection must not be made to, whatever name led there. */
export function refusedAddress(address: string, allowLoopback = false): boolean {
  const a = address.toLowerCase();
  if (net.isIPv6(a)) {
    if (a === "::" || a === "::1") return a === "::" || !allowLoopback;
    if (/^fe[89ab]/.test(a)) return true; // link-local
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    return mapped ? refusedAddress(mapped[1], allowLoopback) : false;
  }
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(a);
  if (!m) return true; // not an address at all
  const [o1, o2] = [Number(m[1]), Number(m[2])];
  if (o1 === 0) return true;
  if (o1 === 127) return !allowLoopback;
  if (o1 === 169 && o2 === 254) return true; // link-local, including the cloud metadata address
  return false;
}

/** A connection error in words: what a person would say about it, not Node's code. */
function plainNetworkError(err: Error, host: string): string {
  const m = err.message;
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return `${host} doesn't resolve: check the address, or your connection.`;
  if (/ECONNREFUSED/.test(m)) return `${host} refused the connection: nothing is listening there.`;
  if (/ETIMEDOUT|timed? ?out/i.test(m)) return `${host} didn't answer in time.`;
  if (/CERT|SSL|TLS|self[- ]signed/i.test(m)) return `${host}'s certificate isn't valid (${m}).`;
  return m;
}

export interface SiteFinding {
  level: "ok" | "warn" | "bad" | "info";
  title: string;
  fix?: string;
}

export interface SiteStatus {
  url: string;
  ok: boolean;
  status?: number;
  /** The whole check, redirects included. */
  ms: number;
  finalUrl: string;
  redirects: { from: string; status: number; to: string }[];
  https: boolean;
  server?: string;
  contentType?: string;
  title?: string;
  deployment?: Deployment;
  /** Names and flags only, never values. */
  cookies: { name: string; secure: boolean; httpOnly: boolean; sameSite?: string }[];
  findings: SiteFinding[];
  /** A redirect that went to a host that isn't one of the project's sites: where dx stopped. */
  stoppedAt?: string;
  error?: string;
}

interface Hop {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function getOnce(u: URL, allowLoopback: boolean, timeoutMs: number): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const lookup = (host: string, o: dns.LookupOptions, cb: (...args: unknown[]) => void) => {
      dns.lookup(host, { ...o, all: true }, (err, addrs) => {
        if (err) return cb(err);
        const ok = (addrs as dns.LookupAddress[]).filter((x) => !refusedAddress(x.address, allowLoopback));
        if (!ok.length) return cb(new Error(`${host} resolves to ${(addrs as dns.LookupAddress[])[0]?.address}, an address dx won't connect to.`));
        if (o.all) return cb(null, ok);
        cb(null, ok[0].address, ok[0].family);
      });
    };
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, { method: "GET", headers: { "user-agent": "dx-site-check", accept: "text/html,*/*;q=0.8" }, timeout: timeoutMs, lookup: lookup as never }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        chunks.push(c);
        if (size > 64 * 1024) res.destroy(); // the head of the page is enough
      });
      const done = () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8", 0, 64 * 1024) });
      res.on("end", done);
      res.on("close", done);
      res.on("error", done);
    });
    req.on("timeout", () => req.destroy(new Error(`No answer within ${Math.round(timeoutMs / 1000)} seconds.`)));
    req.on("error", reject);
    req.end();
  });
}

const flat = (h: http.IncomingHttpHeaders): Record<string, string> => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")]));

function metaTags(html: string): { title?: string; meta: Record<string, string> } {
  const meta: Record<string, string> = {};
  for (const m of html.slice(0, 64 * 1024).matchAll(/<meta\s+[^>]*>/gi)) {
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1];
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(m[0])?.[1];
    if (name && content !== undefined) meta[name.toLowerCase()] = content;
  }
  const title = /<title[^>]*>([^<]{0,200})<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim();
  return { title: title || undefined, meta };
}

function cookiesOf(headers: http.IncomingHttpHeaders): SiteStatus["cookies"] {
  const list = headers["set-cookie"] ?? [];
  return list.slice(0, 20).map((c) => {
    const parts = c.split(";").map((x) => x.trim());
    const name = parts[0].split("=")[0].slice(0, 80);
    const flag = (f: string) => parts.some((p) => p.toLowerCase() === f);
    const same = parts.find((p) => p.toLowerCase().startsWith("samesite="))?.split("=")[1];
    return { name, secure: flag("secure"), httpOnly: flag("httponly"), sameSite: same };
  });
}

/** The findings on the final answer: what is there, and what is missing. Pure, so it's tested without a network. */
export function siteFindings(s: Pick<SiteStatus, "status" | "https" | "ms" | "cookies" | "server" | "redirects">, headers: Record<string, string>): SiteFinding[] {
  const out: SiteFinding[] = [];
  const status = s.status ?? 0;
  if (status >= 500) out.push({ level: "bad", title: `The site answered ${status}: it is failing` });
  else if (status === 401 || status === 403) out.push({ level: "info", title: `Answered ${status}: the front page needs a sign-in` });
  else if (status >= 400) out.push({ level: "warn", title: `Answered ${status}: that address isn't found` });
  else if (status) out.push({ level: "ok", title: `Answered ${status} in ${s.ms} ms` });
  if (s.ms > 2000) out.push({ level: "warn", title: `Slow to answer: ${(s.ms / 1000).toFixed(1)} s` });
  if (!s.https) out.push({ level: "warn", title: "Not served over https", fix: "Serve the site over https and redirect http to it" });
  else if (!headers["strict-transport-security"]) out.push({ level: "warn", title: "No Strict-Transport-Security header", fix: "Add Strict-Transport-Security: max-age=31536000; includeSubDomains" });
  const csp = headers["content-security-policy"] ?? "";
  if (!csp) out.push({ level: "warn", title: "No Content-Security-Policy header", fix: "Add a Content-Security-Policy that limits where scripts can come from" });
  if (!/nosniff/i.test(headers["x-content-type-options"] ?? "")) out.push({ level: "warn", title: "No X-Content-Type-Options: nosniff", fix: "Add X-Content-Type-Options: nosniff" });
  if (!headers["x-frame-options"] && !/frame-ancestors/i.test(csp)) out.push({ level: "warn", title: "The page can be put in a frame on another site", fix: "Add X-Frame-Options: DENY, or frame-ancestors in the Content-Security-Policy" });
  if (!headers["referrer-policy"]) out.push({ level: "info", title: "No Referrer-Policy header", fix: "Add Referrer-Policy: strict-origin-when-cross-origin" });
  for (const c of s.cookies) {
    if (s.https && !c.secure) out.push({ level: "warn", title: `The cookie ${c.name} isn't marked Secure`, fix: "Set the Secure flag on the cookie" });
    if (!c.httpOnly) out.push({ level: "warn", title: `The cookie ${c.name} can be read by scripts (no HttpOnly)`, fix: "Set HttpOnly unless a script needs it" });
    if (!c.sameSite) out.push({ level: "info", title: `The cookie ${c.name} has no SameSite`, fix: "Set SameSite=Lax (or Strict)" });
  }
  if (s.server && /\d+\.\d+/.test(s.server)) out.push({ level: "info", title: `The server header says its version (${s.server})`, fix: "Hide the version in the server's settings" });
  if (s.https && headers["strict-transport-security"] && csp && /nosniff/i.test(headers["x-content-type-options"] ?? "")) out.push({ level: "ok", title: "https, HSTS, a Content-Security-Policy and nosniff are in place" });
  return out;
}

/** One look at the site: status, redirects, headers, cookie flags, deployment, in one GET per hop. */
export async function siteStatus(url: string, sites: SiteConfig[], options: { allowLoopback?: boolean; timeoutMs?: number } = {}): Promise<SiteStatus> {
  if (!siteForUrl(url, sites)) throw new Error("That address isn't one of the project's sites. Add it first.");
  const started = Date.now();
  const timeout = options.timeoutMs ?? 15_000;
  const result: SiteStatus = { url, ok: false, ms: 0, finalUrl: url, redirects: [], https: url.startsWith("https:"), cookies: [], findings: [] };
  let current = new URL(url);
  try {
    for (let hop = 0; hop < 6; hop++) {
      const r = await getOnce(current, options.allowLoopback === true, timeout);
      const location = r.headers.location;
      if (r.status >= 300 && r.status < 400 && location) {
        const next = new URL(location, current);
        result.redirects.push({ from: current.href, status: r.status, to: next.href });
        if (!siteForUrl(next.href, sites)) {
          result.stoppedAt = next.host;
          result.finalUrl = next.href;
          result.findings.push({ level: "warn", title: `Redirects to ${next.host}, which isn't one of this project's sites: dx stopped there`, fix: "Add that host to the project if it is yours" });
          break;
        }
        current = next;
        continue;
      }
      const headers = flat(r.headers);
      const { title, meta } = metaTags(r.body);
      result.status = r.status;
      result.finalUrl = current.href;
      result.https = current.protocol === "https:";
      result.server = headers.server?.slice(0, 80) || undefined;
      result.contentType = headers["content-type"]?.split(";")[0];
      result.title = title;
      result.cookies = cookiesOf(r.headers);
      result.deployment = deploymentFrom(headers, meta);
      result.ms = Date.now() - started;
      result.findings.push(...siteFindings(result, headers));
      result.ok = r.status < 400;
      return result;
    }
    if (!result.stoppedAt) result.error = "Too many redirects.";
  } catch (err) {
    result.error = plainNetworkError(err as Error, current.host);
  }
  result.ms = Date.now() - started;
  return result;
}

/** The page loaded in a headless browser: errors, console, failed requests; its navigation can't leave the project's sites. */
export function checkSitePage(url: string, sites: SiteConfig[], options: { timeoutMs?: number; phone?: boolean } = {}): Promise<PageCheck> {
  return checkPage({ url, allow: siteAllows(sites), requests: true, timeoutMs: options.timeoutMs ?? 40_000, ...(options.phone ? { emulate: { phone: true } } : {}) });
}

export interface SiteAudit {
  url: string;
  status?: number;
  perf?: PagePerf;
  a11y: A11yIssue[];
  blocked: string[];
  error?: string;
}

/** Speed and accessibility, measured the way a commit's pages are, on the site's page. */
export async function auditSitePage(url: string, sites: SiteConfig[]): Promise<SiteAudit> {
  if (!siteForUrl(url, sites)) throw new Error("That address isn't one of the project's sites. Add it first.");
  const out: SiteAudit = { url, a11y: [], blocked: [] };
  try {
    await withBrowser(
      async (session) => {
        const page = await session.newPage();
        await page.send("Page.addScriptToEvaluateOnNewDocument", { source: PERF_INIT });
        try {
          out.status = await page.navigate(url, { timeoutMs: 45_000, settleMs: 2000 });
        } catch (err) {
          out.error = (err as Error).message;
        }
        if (!out.error) {
          out.perf = await page.evaluate<PagePerf>(PERF_READ, 5000).catch(() => undefined);
          out.a11y = (await page.evaluate<A11yIssue[]>(A11Y_AUDIT, 15_000).catch(() => undefined)) ?? [];
        }
        out.blocked = page.blocked();
        if (out.blocked.length && !out.error) out.error = `The page tried to go to ${out.blocked[0]}, which isn't one of this project's sites, so dx stopped there.`;
      },
      { allow: siteAllows(sites), remote: true },
    );
  } catch (err) {
    out.error ??= (err as Error).message;
  }
  return out;
}
