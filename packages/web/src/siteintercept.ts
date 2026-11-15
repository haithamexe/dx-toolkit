import type http from "node:http";
import { editHeaders, foldPath, matchMock, mockNeedsBody, siteApplies, siteForUrl, type PausedRequest, type SiteAction, type SiteConfig } from "@dx/core";
import { rulePlanFor } from "./apilab.js";
import { chaosFor } from "./chaos.js";
import type { LocalRoute } from "./dev.js";
import { activeMocks, looksLikeApi, wantedOf } from "./mocks.js";

/**
 * What a project's mocks, rules and Chaos mode do to the API calls of a page on one of its sites
 * (open in the dx browser). The same decisions the proxy makes for a dev server dx runs, taken
 * from the same stores, and applied by the browser itself (DevTools Fetch), since dx isn't in the
 * path of a deployed site's traffic. Only fetch and XHR calls to one of the project's own sites
 * are touched: a third party's calls, page loads, scripts and styles go as they would without dx.
 *
 * What a site can't have, said on the page: edits to the answer, holding a call in Intercept, and
 * Chaos's bad data and out-of-order answers (they need the answer's body, which the browser hands
 * dx only after the page has it). Request headers can be edited; a request body can't.
 */

const FAIL_TEXT = {
  logout: [401, "Unauthorized: your session has expired (dx chaos mode)", { "www-authenticate": 'Bearer error="invalid_token"' }],
  ratelimit: [429, "Too Many Requests (dx chaos mode)", { "retry-after": "5" }],
  flaky: [500, "Internal Server Error (dx chaos mode)", {}],
} as const;

const HANG_MS = 30_000;

const json = (status: number, message: string, extra: Record<string, string> = {}, tags?: SiteAction["tags"], delayMs?: number): SiteAction => ({
  kind: "fulfill",
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  body: JSON.stringify({ error: message }),
  tags,
  delayMs,
});

/** The decision for one held call; undefined lets it go on untouched. `sites` is the project's own list. */
export function decideSite(req: PausedRequest, sites: SiteConfig[]): SiteAction | undefined {
  const dir = req.target.dir;
  if (dir.startsWith("site:")) return undefined; // a site that isn't any project's has no mocks, rules or chaos
  const own = sites.filter((s) => s.project?.toLowerCase() === dir.toLowerCase());
  // Only calls to the project's own sites: a third party's API is never answered by dx.
  // And only a site the person left it on for: production is off until turned on.
  const site = siteForUrl(req.url, own);
  if (!site || !siteApplies(site)) return undefined;
  let u: URL;
  try {
    u = new URL(req.url);
  } catch {
    return undefined;
  }
  const path = u.pathname + u.search;
  const method = req.method;
  const headers = req.headers as http.IncomingHttpHeaders;
  const fake = { url: path, method, headers } as unknown as http.IncomingMessage;
  const route = { dir, project: req.target.project, service: undefined, name: req.target.project } as unknown as LocalRoute;

  // 1. Mocks answer first, and a mocked call isn't broken or slowed by anything else.
  const set = activeMocks(dir);
  if (set?.endpoints.length && !(method === "GET" && /text\/html/i.test(String(headers.accept ?? "")))) {
    const want = wantedOf(headers);
    let ep: { status: number; contentType: string; body: string; delayMs: number; offline?: boolean } | undefined = matchMock(set, { method, url: path }, want);
    if (ep && mockNeedsBody(set, method, path)) ep = matchMock(set, { method, url: path, body: req.postData ?? "", contentType: String(headers["content-type"] ?? "") }, want) ?? ep;
    if (!ep && set.strict && looksLikeApi(method, path, headers)) {
      return json(404, `No mock for ${method} ${foldPath(path)} (dx mock mode is strict)`, {}, { mocked: true });
    }
    if (ep) {
      const tags = { mocked: true };
      if (ep.offline) return { kind: "fail", reason: "ConnectionClosed", tags };
      const out: Record<string, string> = { "content-type": ep.contentType, "cache-control": "no-store", "x-dx-mock": "1" };
      // A call to another origin (the site's own API host) needs the page's origin allowed.
      const origin = headers.origin;
      if (origin) Object.assign(out, { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "origin" });
      const empty = method === "HEAD" || ep.status === 204 || ep.status === 304;
      return { kind: "fulfill", status: ep.status, headers: out, body: empty ? "" : ep.body, delayMs: ep.delayMs, tags };
    }
  }

  // 2. Rules, then 3. Chaos, as the proxy applies them.
  const plan = rulePlanFor(fake, route);
  const chaos = chaosFor(fake, route);
  const names = (plan?.rules ?? []).map((r) => r.name);
  const delay = Math.min(HANG_MS, (plan?.delayMs ?? 0) + (chaos?.fault === "slow" ? (chaos.delayMs ?? 0) : 0));
  const touched = chaos && chaos.fault !== "baddata" && chaos.fault !== "reorder" ? chaos : undefined;
  const rules = [...names, ...(touched ? [touched.label] : [])];
  const tags = rules.length ? { rules } : undefined;

  const fail = plan?.fail;
  if (fail === "500") return json(500, "Internal Server Error (dx rule)", {}, tags, delay || undefined);
  if (fail === "timeout") return { kind: "fail", reason: "TimedOut", delayMs: HANG_MS, tags };
  if (fail === "drop") return { kind: "fail", reason: "ConnectionReset", delayMs: delay || undefined, tags };
  if (touched?.fault === "logout" || touched?.fault === "ratelimit" || touched?.fault === "flaky") {
    const [status, message, extra] = FAIL_TEXT[touched.fault];
    return json(status, message, { "x-dx-chaos": touched.fault, ...extra }, tags, delay || undefined);
  }
  if (touched?.fault === "timeout") return { kind: "fail", reason: "TimedOut", delayMs: HANG_MS, tags };
  if (touched?.fault === "drop") return { kind: "fail", reason: "ConnectionReset", delayMs: delay || undefined, tags };

  // Changed request headers: the whole set goes on, as DevTools asks for.
  const edits = plan?.request.filter((e) => e.setHeaders || e.removeHeaders?.length) ?? [];
  let out: Record<string, string> | undefined;
  if (edits.length) {
    let h: Record<string, string | string[] | undefined> = { ...req.headers };
    for (const e of edits) h = editHeaders(h, e);
    out = {};
    for (const [k, v] of Object.entries(h)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  if (delay || out || tags) return { kind: "continue", headers: out, delayMs: delay || undefined, tags };
  return undefined;
}
