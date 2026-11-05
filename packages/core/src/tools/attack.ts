import crypto from "node:crypto";
import type { ActivityEvent } from "./activity.js";
import { isLoopbackUrl, withBrowser } from "./browser.js";
import { declaredRoutes, routeFits } from "./graveyard.js";
import { MASK } from "./mask.js";
import { foldPath } from "./mocks.js";

/**
 * Attack my app: a friendly security pass on a project's own app, on this computer only. It
 * takes the requests and pages the history recorded and tries the usual weaknesses against the
 * project's dev server: script that comes back unescaped (reflected and stored), records another
 * id opens, calls that work without signing in or from another site (CSRF), CORS that lets any
 * site read answers, cookies without HttpOnly/Secure/SameSite, missing security headers, stack
 * traces and SQL errors in answers, and logins with no rate limit. Every request goes to the
 * project's own dev server; each finding has the request that shows it, and the route's file
 * and line when dx can find it.
 *
 * Some checks send requests that change data (they replay recorded POSTs with test values, and
 * try wrong passwords): it's for the project's development database, which is what dx runs.
 */

export type Severity = "high" | "medium" | "low";

export type AttackCheck = "xss-reflected" | "xss-stored" | "idor" | "no-auth" | "csrf" | "cors" | "cookie" | "headers" | "stack-trace" | "sql-error" | "login-rate";

export interface AttackFinding {
  check: AttackCheck;
  severity: Severity;
  title: string;
  /** Why it matters and what to do, in a sentence or two. */
  fix: string;
  /** The request that shows it: "GET /api/orders/43 → 200". */
  proof: string;
  /** Where the route is declared, when dx found it: "server/routes.ts:42". */
  where?: string;
}

export interface AttackOptions {
  /** The project's dev server on this computer. */
  baseUrl: string;
  dir: string;
  /** Recorded requests and pages (the activity history). */
  events: ActivityEvent[];
  /** A Cookie or Authorization value to test signed-in calls with; used for this run only. */
  session?: { cookie?: string; authorization?: string };
  /** Skip the checks that change data (stored script, CSRF, the login attempts). */
  readOnly?: boolean;
  /** Use a headless browser for script that runs in the page (default: when one is found). */
  browser?: boolean;
  progress?: (step: string) => void;
  signal?: AbortSignal;
}

export interface AttackReport {
  findings: AttackFinding[];
  /** What was tried, and how often: "CORS on 6 endpoints". */
  tried: string[];
  /** What couldn't be tried, and why. */
  skipped: string[];
  requests: number;
  ms: number;
}

const EVIL = "https://evil.example";
const LOGIN = /\/(login|log-in|signin|sign-in|session|sessions|authenticate|auth\/(token|login|signin|callback\/credentials)|oauth\/token|token)\b/i;
const STACK = [/\n\s+at [^\n]+\([^\n)]+:\d+:\d+\)/, /Traceback \(most recent call last\)/, /\bFile "[^"]+", line \d+/, /[\\/]node_modules[\\/]/, /\bat [\w.<>]+ \((?:file:\/\/)?[A-Za-z]?:?[\\/][^)]+\)/, /Exception in thread|java\.lang\.|System\.\w+Exception/];
const SQL = /SQLSTATE|syntax error at or near|SQLITE_ERROR|ER_PARSE_ERROR|You have an error in your SQL syntax|unterminated quoted string|PrismaClientKnownRequestError|QueryFailedError/i;

interface Sent {
  status: number;
  headers: Headers;
  body: string;
  ms: number;
}

export async function attackApp(o: AttackOptions): Promise<AttackReport> {
  const t0 = Date.now();
  if (!isLoopbackUrl(o.baseUrl)) throw new Error("Only the project's own dev server on this computer is attacked.");
  const base = new URL(o.baseUrl);
  const report: AttackReport = { findings: [], tried: [], skipped: [], requests: 0, ms: 0 };
  const routes = declaredRoutes(o.dir).endpoints;
  const where = (method: string, p: string) => routes.find((r) => (!r.method || r.method === method) && routeFits(r.path, p))?.from;
  const found = new Set<string>();
  const add = (f: AttackFinding) => {
    const k = `${f.check} ${f.title}`;
    if (found.has(k) || report.findings.length >= 100) return;
    found.add(k);
    report.findings.push(f);
  };
  const sessionHeaders = (): Record<string, string> => ({ ...(o.session?.cookie ? { cookie: o.session.cookie } : {}), ...(o.session?.authorization ? { authorization: o.session.authorization } : {}) });

  const send = async (method: string, pathAndQuery: string, init: { headers?: Record<string, string>; body?: string } = {}): Promise<Sent | undefined> => {
    if (o.signal?.aborted) return undefined;
    const url = new URL(pathAndQuery, base);
    if (url.origin !== base.origin) return undefined;
    report.requests++;
    const started = Date.now();
    try {
      const res = await fetch(url, { method, headers: { "user-agent": "dx-attack", ...init.headers }, body: init.body, redirect: "manual", signal: AbortSignal.timeout(15_000) });
      const body = (await res.text()).slice(0, 256 * 1024);
      return { status: res.status, headers: res.headers, body, ms: Date.now() - started };
    } catch {
      return undefined;
    }
  };

  // What the history has: API calls (by method and folded path, the newest of each) and pages.
  const pathOf = (u: string) => {
    try {
      const x = new URL(u, base);
      return x.pathname + x.search;
    } catch {
      return u;
    }
  };
  const calls = new Map<string, ActivityEvent>();
  const pages: string[] = [];
  for (const e of [...o.events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) {
    // Only what went through dx's proxy to this dev server (a path); calls the page made to other
    // addresses (another service, another site) aren't this server's.
    if (e.site || !e.url || e.mocked || /^[a-z]+:/i.test(e.url)) continue;
    const p = pathOf(e.url);
    if (p.startsWith("/__dx/")) continue;
    if (e.type === "request" && (e.status ?? 0) < 500) {
      const k = `${e.method ?? "GET"} ${foldPath(p)}`;
      if (!calls.has(k)) calls.set(k, e);
    } else if (e.type === "page" && !pages.includes(p) && pages.length < 8) pages.push(p);
  }
  if (!pages.length) pages.push("/");
  const api = [...calls.values()].slice(0, 40);
  const reads = api.filter((e) => (e.method ?? "GET") === "GET");
  const writes = api.filter((e) => ["POST", "PUT", "PATCH"].includes(e.method ?? "") && !LOGIN.test(pathOf(e.url!)));
  const signedIn = (e: ActivityEvent) => !!(e.requestHeaders?.cookie || e.requestHeaders?.authorization);
  const hasSession = !!(o.session?.cookie || o.session?.authorization);

  // ---- security headers, on the first page
  o.progress?.("Security headers");
  const home = await send("GET", pages[0], { headers: { accept: "text/html" } });
  if (home) {
    report.tried.push(`security headers on ${pages[0]}`);
    const h = home.headers;
    const csp = h.get("content-security-policy") ?? "";
    const missing: string[] = [];
    if (!csp) missing.push("Content-Security-Policy (limits where scripts can come from, the main defence against injected script)");
    if (!/frame-ancestors/i.test(csp) && !h.get("x-frame-options")) missing.push("X-Frame-Options or frame-ancestors (stops other sites framing the app to trick clicks)");
    if ((h.get("x-content-type-options") ?? "").toLowerCase() !== "nosniff") missing.push("X-Content-Type-Options: nosniff");
    if (!h.get("referrer-policy")) missing.push("Referrer-Policy");
    if (missing.length)
      add({ check: "headers", severity: "low", title: `${missing.length} security header${missing.length === 1 ? "" : "s"} missing`, fix: `Add ${missing.join("; ")}. In Express, helmet() sets them; in Next.js, headers() in next.config. Many apps add them only in production: check that it does.`, proof: `GET ${pages[0]} → ${home.status}, without ${missing.map((m) => m.split(" ")[0]).join(", ")}` });
  }

  // ---- cookies the app sets: their flags, from the history (values are never kept)
  const cookies = new Map<string, string>();
  for (const e of o.events) {
    const sc = e.responseHeaders?.["set-cookie"];
    if (!sc) continue;
    for (const c of sc.split(/,\s*(?=[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/)) {
      const name = c.split("=")[0].trim();
      if (name && !cookies.has(name)) cookies.set(name, c);
    }
  }
  if (cookies.size) report.tried.push(`flags of ${cookies.size} cookie${cookies.size === 1 ? "" : "s"}`);
  for (const [name, c] of cookies) {
    if (c === MASK) continue;
    const lacks = [!/;\s*httponly/i.test(c) && /sess|sid|auth|token|jwt|login/i.test(name) ? "HttpOnly (page scripts, and injected ones, can read it)" : "", !/;\s*samesite=(lax|strict)/i.test(c) ? "SameSite=Lax (other sites can send it along)" : ""].filter(Boolean);
    if (lacks.length) add({ check: "cookie", severity: /HttpOnly/.test(lacks[0]) ? "medium" : "low", title: `The ${name} cookie has no ${lacks.map((l) => l.split(" ")[0]).join(" or ")}`, fix: `Set it with ${lacks.join(" and ")}, and Secure in production.`, proof: `Set-Cookie: ${c}` });
  }

  // ---- CORS: what another site's page is allowed to read
  o.progress?.("CORS");
  let corsTried = 0;
  for (const e of reads.slice(0, 6)) {
    const p = pathOf(e.url!);
    const r = await send("GET", p, { headers: { origin: EVIL, accept: "application/json", ...sessionHeaders() } });
    if (!r) continue;
    corsTried++;
    const allow = r.headers.get("access-control-allow-origin");
    const creds = (r.headers.get("access-control-allow-credentials") ?? "").toLowerCase() === "true";
    if (allow === EVIL && creds) add({ check: "cors", severity: "high", title: `Any site can read ${foldPath(p.split("?")[0])} with the user's cookies`, fix: "The server copies the Origin header into Access-Control-Allow-Origin and allows credentials. Allow only your own front end's origins, from a fixed list.", proof: `GET ${p} with Origin: ${EVIL} → Access-Control-Allow-Origin: ${allow}, Allow-Credentials: true`, where: where("GET", p) });
    else if (allow === EVIL) add({ check: "cors", severity: "medium", title: "CORS allows whichever site asks", fix: "Access-Control-Allow-Origin echoes the Origin header. List the origins allowed instead.", proof: `GET ${p} with Origin: ${EVIL} → Access-Control-Allow-Origin: ${allow}`, where: where("GET", p) });
    else if (allow === "*" && signedIn(e)) add({ check: "cors", severity: "low", title: `${foldPath(p.split("?")[0])} allows every origin`, fix: "It's signed in, but answers say Access-Control-Allow-Origin: *. Browsers won't send cookies with that, but tokens in headers would be readable; list the origins allowed.", proof: `GET ${p} → Access-Control-Allow-Origin: *`, where: where("GET", p) });
  }
  if (corsTried) report.tried.push(`CORS on ${corsTried} endpoint${corsTried === 1 ? "" : "s"}`);

  // ---- signed-in reads that work without signing in, and other ids (IDOR)
  o.progress?.("Signed-in calls without the session, and other ids");
  let authTried = 0;
  for (const e of reads.filter(signedIn).slice(0, 8)) {
    const p = pathOf(e.url!);
    const r = await send("GET", p, { headers: { accept: "application/json" } });
    if (!r) continue;
    authTried++;
    if (r.status >= 200 && r.status < 300 && r.body.length > 2 && !/^\s*(\[\]|\{\}|null)\s*$/.test(r.body))
      add({ check: "no-auth", severity: "high", title: `${foldPath(p.split("?")[0])} answers without signing in`, fix: "It was called signed in, and answers the same without a cookie or token. Check the route requires a session (a middleware it skips, or one that lets unknown users through).", proof: `GET ${p} without Cookie or Authorization → ${r.status}`, where: where("GET", p) });
  }
  if (authTried) report.tried.push(`${authTried} signed-in endpoint${authTried === 1 ? "" : "s"} without the session`);
  if (hasSession) {
    let idTried = 0;
    for (const e of reads.filter((x) => /\/\d+(?=\/|$|\?)/.test(pathOf(x.url!))).slice(0, 6)) {
      const p = pathOf(e.url!);
      const m = /\/(\d+)(?=\/|$|\?)/.exec(p)!;
      const own = await send("GET", p, { headers: { accept: "application/json", ...sessionHeaders() } });
      for (const other of [Number(m[1]) + 1, Number(m[1]) - 1].filter((n) => n > 0)) {
        const q = p.replace(`/${m[1]}`, `/${other}`);
        const r = await send("GET", q, { headers: { accept: "application/json", ...sessionHeaders() } });
        if (!r || !own) continue;
        idTried++;
        if (r.status >= 200 && r.status < 300 && r.body !== own.body && r.body.length > 2) {
          add({ check: "idor", severity: "medium", title: `Changing the id in ${foldPath(p.split("?")[0])} opens another record`, fix: `With your session, ${q} answers too. If that record belongs to someone else, the route must check it's the signed-in user's (where owner = session user), not only that the id exists.`, proof: `GET ${q} with your session → ${r.status}`, where: where("GET", p) });
          break;
        }
      }
    }
    if (idTried) report.tried.push(`other ids on ${idTried} call${idTried === 1 ? "" : "s"}`);
  } else report.skipped.push("other users' records (IDOR) and CSRF: give a session (a Cookie or Authorization value from your browser) to test signed-in calls");

  // ---- stack traces and SQL errors in answers to malformed requests
  o.progress?.("Error answers");
  let errTried = 0;
  for (const e of api.slice(0, 10)) {
    const method = e.method ?? "GET";
    const p = pathOf(e.url!);
    const probes: Array<[string, string, string | undefined]> = [];
    if (method === "GET") {
      const withQuote = /\/\d+(?=\/|$|\?)/.test(p) ? p.replace(/\/(\d+)(?=\/|$|\?)/, "/1'") : p.includes("?") ? p.replace(/=([^&]*)/, "=$1'") : undefined;
      if (withQuote) probes.push(["GET", withQuote, undefined]);
    } else if (method !== "DELETE") probes.push([method, p, '{"dx": ']);
    for (const [m, q, body] of probes) {
      const r = await send(m, q, { headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...sessionHeaders() }, body });
      if (!r) continue;
      errTried++;
      if (SQL.test(r.body))
        add({ check: "sql-error", severity: "high", title: `A quote in ${foldPath(p.split("?")[0])} reaches the database as SQL`, fix: "The answer shows a SQL error after one quote, so the value is put into the query text. Use the driver's parameters (or the ORM) for every value, never string building.", proof: `${m} ${q} → ${r.status}: ${(SQL.exec(r.body)?.[0] ?? "").slice(0, 80)}`, where: where(method, p) });
      else if (STACK.some((x) => x.test(r.body)))
        add({ check: "stack-trace", severity: "medium", title: `${foldPath(p.split("?")[0])} answers an error with its stack trace`, fix: "Files, lines and libraries tell an attacker how the server is built. Answer a short message and log the details; check NODE_ENV=production (or DEBUG=False) hides them.", proof: `${m} ${q}${body ? ` with ${body}` : ""} → ${r.status}, with a stack trace`, where: where(method, p) });
    }
  }
  if (errTried) report.tried.push(`malformed input on ${errTried} call${errTried === 1 ? "" : "s"}`);

  // ---- script that comes back unescaped
  const marker = `dx${crypto.randomBytes(4).toString("hex")}`;
  const tag = `<${marker} data-dx-xss="1"></${marker}>`;
  const payload = `"'>${tag}`;
  const reflectPages = pages
    .map((p) => {
      const u = new URL(p, base);
      if (![...u.searchParams.keys()].length) u.searchParams.set("q", "x");
      for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, payload);
      return u.pathname + u.search;
    })
    .slice(0, 4);
  o.progress?.("Script in the address");
  for (const p of reflectPages) {
    const r = await send("GET", p, { headers: { accept: "text/html", ...sessionHeaders() } });
    if (r && /text\/html/i.test(r.headers.get("content-type") ?? "") && r.body.includes(tag))
      add({ check: "xss-reflected", severity: "high", title: `${p.split("?")[0]} puts the address into the page unescaped`, fix: "A value from the query string comes back as HTML, so a link can run script on the app. Escape it (your template engine's default output, not its raw one).", proof: `GET ${p} → the page contains ${tag}` });
  }
  report.tried.push(`script in the address on ${reflectPages.length} page${reflectPages.length === 1 ? "" : "s"}`);

  // Stored: a recorded write sent again with the marker in its text fields, then the pages loaded.
  let stored = 0;
  if (!o.readOnly) {
    o.progress?.("Script saved through the app's own forms");
    for (const e of writes.slice(0, 4)) {
      if (!e.requestBody || e.requestBody.includes(MASK)) continue;
      let doc: unknown;
      try {
        doc = JSON.parse(e.requestBody);
      } catch {
        continue;
      }
      let changed = 0;
      const mark = (v: unknown): unknown => {
        if (typeof v === "string" && changed < 3 && !/^\d|@|^https?:/.test(v)) {
          changed++;
          return `${v} ${tag}`;
        }
        if (Array.isArray(v)) return v.map(mark);
        if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mark(x)]));
        return v;
      };
      const body = JSON.stringify(mark(doc));
      if (!changed) continue;
      const r = await send(e.method!, pathOf(e.url!), { headers: { "content-type": "application/json", accept: "application/json", ...sessionHeaders() }, body });
      if (r && r.status < 400) stored++;
    }
    if (stored) report.tried.push(`script saved through ${stored} form${stored === 1 ? "" : "s"}`);
  } else report.skipped.push("script saved through forms, CSRF and login attempts: read-only run");

  // Both kinds in a real browser: did the marker become an element (script would have run)?
  if ((o.browser ?? true) && (stored || reflectPages.length)) {
    o.progress?.("Loading the pages in a headless browser");
    try {
      await withBrowser(async (session) => {
        const page = await session.newPage();
        if (o.session?.cookie) {
          for (const part of o.session.cookie.split(/;\s*/)) {
            const i = part.indexOf("=");
            if (i > 0) await page.send("Network.setCookie", { name: part.slice(0, i), value: part.slice(i + 1), url: base.origin }).catch(() => undefined);
          }
        }
        const targets = [...(stored ? pages.slice(0, 4) : []), ...reflectPages.map((p) => `reflect:${p}`)];
        for (const t of targets) {
          if (o.signal?.aborted) break;
          const p = t.startsWith("reflect:") ? t.slice(8) : t;
          await page.navigate(new URL(p, base).href, { timeoutMs: 30_000, settleMs: 1200 }).catch(() => undefined);
          const hit = await page.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(`${marker}[data-dx-xss]`)})`).catch(() => false);
          if (!hit) continue;
          if (t.startsWith("reflect:"))
            add({ check: "xss-reflected", severity: "high", title: `${p.split("?")[0]} turns the address into HTML in the browser`, fix: "The page's own script puts a value from the address into the page as HTML (innerHTML, dangerouslySetInnerHTML, v-html). Set it as text instead.", proof: `${p} → the page has an element <${marker}> made from the address` });
          else
            add({ check: "xss-stored", severity: "high", title: `Text saved through the app shows up as HTML on ${p}`, fix: "A value saved with a form comes back as markup, so one user can run script in another's browser. Render it as text (no innerHTML / dangerouslySetInnerHTML / v-html / |safe), or sanitise it.", proof: `${writes.map((w) => `${w.method} ${pathOf(w.url!)}`).slice(0, 2).join(", ")} with ${tag}, then ${p} has that element` });
        }
      });
    } catch (err) {
      report.skipped.push(`script in the page: ${(err as Error).message.split("\n")[0]}`);
    }
  }

  // ---- CSRF: a signed-in write sent as another site would
  if (!o.readOnly && o.session?.cookie) {
    o.progress?.("Writes from another site (CSRF)");
    let csrfTried = 0;
    for (const e of writes.filter((w) => w.requestHeaders?.cookie).slice(0, 3)) {
      if (!e.requestBody || e.requestBody.includes(MASK)) continue;
      const r = await send(e.method!, pathOf(e.url!), { headers: { "content-type": e.requestHeaders?.["content-type"] ?? "application/json", origin: EVIL, referer: `${EVIL}/`, cookie: o.session.cookie }, body: e.requestBody });
      if (!r) continue;
      csrfTried++;
      if (r.status >= 200 && r.status < 300)
        add({ check: "csrf", severity: "high", title: `${e.method} ${foldPath(pathOf(e.url!).split("?")[0])} accepts a request from another site`, fix: "With the user's cookie and Origin: another site, it still did what it was asked. Check the Origin header, require a CSRF token, or set the session cookie SameSite=Lax/Strict.", proof: `${e.method} ${pathOf(e.url!)} with Origin: ${EVIL} and your cookie, no CSRF token → ${r.status}`, where: where(e.method!, pathOf(e.url!)) });
    }
    if (csrfTried) report.tried.push(`CSRF on ${csrfTried} write${csrfTried === 1 ? "" : "s"}`);
  }

  // ---- logins with no rate limit
  const login = api.find((e) => e.method === "POST" && LOGIN.test(pathOf(e.url!)));
  if (login && !o.readOnly) {
    o.progress?.("Wrong passwords in a row");
    const p = pathOf(login.url!);
    let body = login.requestBody ?? "";
    const wrong = () => `dx-wrong-${crypto.randomBytes(6).toString("hex")}`;
    body = body.includes(MASK) ? body.split(MASK).join(wrong()) : JSON.stringify({ email: "nobody@example.com", password: wrong() });
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await send("POST", p, { headers: { "content-type": login.requestHeaders?.["content-type"] ?? "application/json", accept: "application/json" }, body: body.split(/dx-wrong-[0-9a-f]+/).join(wrong()) });
      if (!r) break;
      statuses.push(r.status);
      if (r.status === 429 || r.status === 423 || r.headers.get("retry-after")) break;
    }
    report.tried.push(`${statuses.length} wrong passwords on ${p}`);
    if (statuses.length >= 20 && !statuses.some((s) => s === 429 || s === 423))
      add({ check: "login-rate", severity: "medium", title: `${p} took 20 wrong passwords in a row`, fix: "Nothing slowed it down or locked it, so passwords can be guessed by trying. Limit attempts per account and per address (express-rate-limit, a 429 with Retry-After), and add a delay or lockout.", proof: `20 × POST ${p} with wrong passwords → ${[...new Set(statuses)].join(", ")}, no 429`, where: where("POST", p) });
  } else if (!login) report.skipped.push("logins: no sign-in request in the history");

  if (!api.length) report.skipped.push("API checks: no API calls in the history yet; use the app at its .localhost address first");
  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  report.findings.sort((a, b) => order[a.severity] - order[b.severity]);
  report.ms = Date.now() - t0;
  return report;
}
