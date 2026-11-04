import fs from "node:fs";
import type http from "node:http";
import { fileURLToPath } from "node:url";
import { maskText, type ActivityEvent } from "@dx/core";
import { activitySettings, recordActivity, type NewActivity } from "./activity.js";
import type { LocalRoute } from "./dev.js";
import { maskBody, type TrafficEntry } from "./traffic.js";

/**
 * The browser half of the activity history. Pages served at name.localhost get one script tag,
 * added by the proxy right after <head>; the script reports route changes, clicks, console
 * output and errors to /__dx/events on the page's own origin, which the proxy answers itself.
 *
 * Under /node_modules/ so browser dev tools leave it out of stack traces and show the page's
 * own line for console.log, and with a source map saying the same for tools that read that.
 */
export const RECORDER_PATH = "/__dx/node_modules/dx-recorder.js";
export const EVENTS_PATH = "/__dx/events";
const TAG = Buffer.from(`<script src="${RECORDER_PATH}"></script>`);
const MAX_POST = 512 * 1024;
const MAX_EVENTS = 200;
const MAP = Buffer.from(JSON.stringify({ version: 3, file: "dx-recorder.js", sources: ["dx-recorder.js"], names: [], mappings: "", x_google_ignoreList: [0] })).toString("base64");

let script: Buffer | undefined;
function recorderScript(): Buffer {
  script ??= Buffer.concat([fs.readFileSync(fileURLToPath(new URL("../public/recorder.js", import.meta.url))), Buffer.from(`\n//# sourceMappingURL=data:application/json;base64,${MAP}\n`)]);
  return script;
}

/** Handles the proxy's own paths. True when it answered the request. */
export function handleRecorderRequest(req: http.IncomingMessage, res: http.ServerResponse, route: LocalRoute, origin: string): boolean {
  const pathname = (req.url ?? "/").split("?")[0];
  if (pathname === RECORDER_PATH && (req.method === "GET" || req.method === "HEAD")) {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(req.method === "HEAD" ? undefined : recorderScript());
    return true;
  }
  if (pathname !== EVENTS_PATH) return false;
  // Only the page itself: another site can't post into your history, and nothing is read back.
  if (req.method !== "POST" || req.headers.origin !== origin) {
    res.writeHead(403, { "Content-Type": "text/plain" }).end("Not allowed");
    req.resume();
    return true;
  }
  let size = 0;
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size <= MAX_POST) chunks.push(c);
  });
  req.on("end", () => {
    if (size <= MAX_POST) {
      try {
        acceptBrowserEvents(Buffer.concat(chunks).toString("utf8"), route, /HeadlessChrome/i.test(String(req.headers["user-agent"] ?? "")));
      } catch {
        // not what the script sends: ignored
      }
    }
    res.writeHead(204, { "Cache-Control": "no-store" }).end();
  });
  return true;
}

const TYPES = new Set(["route", "action", "console", "error", "request"]);
const LEVELS = new Set(["log", "info", "warn", "error", "debug"]);

/** Reads what the page sent, keeps only known fields at bounded sizes, and masks credentials. */
export function acceptBrowserEvents(raw: string, route: LocalRoute, headless = false): ActivityEvent[] {
  const data = JSON.parse(raw) as { visit?: unknown; events?: unknown };
  if (!Array.isArray(data.events)) return [];
  const visit = typeof data.visit === "string" ? data.visit.slice(0, 40) : undefined;
  const out: ActivityEvent[] = [];
  for (const item of data.events.slice(0, MAX_EVENTS)) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const type = String(e.type);
    if (!TYPES.has(type)) continue;
    const str = (v: unknown, max: number) => (typeof v === "string" && v ? maskText(v.slice(0, max)) : undefined);
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined);
    const at = num(e.at);
    const level = typeof e.level === "string" && LEVELS.has(e.level) ? (e.level as ActivityEvent["level"]) : undefined;
    const base: NewActivity = {
      dir: route.dir,
      project: route.project,
      service: route.service,
      type: type as ActivityEvent["type"],
      text: str(e.text, 4000) ?? "",
      from: headless ? "check" : "browser",
      visit,
      // The page's clock is this computer's clock; a value far off is replaced by now.
      at: at !== undefined && Math.abs(at - Date.now()) < 3_600_000 ? new Date(at).toISOString() : undefined,
      page: str(e.page, 2000),
      source: str(e.source, 500),
      stack: str(e.stack, 8000),
    };
    if (type === "action" && typeof e.target === "string" && e.target) base.target = e.target.slice(0, 300);
    if (type === "console") base.level = level ?? "log";
    if (type === "error") base.level = "error";
    if (type === "request") {
      const url = str(e.url, 2000) ?? "";
      const method = (str(e.method, 10) ?? "GET").toUpperCase();
      const status = num(e.status);
      const error = str(e.error, 300);
      Object.assign(base, {
        url,
        method,
        status,
        ms: num(e.ms),
        error,
        text: `${method} ${url} → ${error ? `failed (${error})` : (status ?? "…")}`,
        level: error || (status ?? 0) >= 400 ? "error" : undefined,
        requestBody: typeof e.req === "string" ? maskBody(e.req.slice(0, 16 * 1024), String(e.reqType ?? "")) : undefined,
        responseBody: typeof e.res === "string" ? maskBody(e.res.slice(0, 32 * 1024), String(e.resType ?? "")) : undefined,
      });
    }
    if (!base.text) continue;
    const recorded = recordActivity(base);
    if (recorded) out.push(recorded);
  }
  return out;
}

/**
 * A finished exchange the proxy saw, into the history: API calls and pages always, scripts,
 * styles and images only when they failed. WebSockets (live reload) aren't history.
 */
export function requestActivity(e: TrafficEntry, route: LocalRoute, userAgent = ""): ActivityEvent | undefined {
  const failed = !!e.error || (e.status ?? 0) >= 400;
  if (e.kind === "socket" || (e.kind === "asset" && !failed)) return undefined;
  // Browsers ask for the icon on every page by themselves; it's not something you did, and an app
  // without one answers 404. Only a server error there is worth knowing.
  if (/^\/favicon\.ico(\?|$)/.test(e.path) && (e.status ?? 0) < 500 && !e.error) return undefined;
  return recordActivity({
    dir: route.dir,
    project: route.project,
    service: route.service ?? e.service,
    type: e.kind === "page" ? "page" : "request",
    text: `${e.method} ${e.path} → ${e.error ? `failed (${e.error})` : (e.status ?? "…")}${e.mocked ? " (mocked)" : ""}`,
    level: failed ? "error" : undefined,
    mocked: e.mocked || undefined,
    url: e.path,
    method: e.method,
    status: e.status,
    ms: e.ms,
    error: e.error,
    requestHeaders: e.requestHeaders,
    responseHeaders: e.responseHeaders,
    requestBody: e.requestBody,
    responseBody: e.responseBody,
    truncated: e.truncated,
    from: /HeadlessChrome/i.test(userAgent) ? "check" : "proxy",
    at: e.at,
  });
}

/** Whether to add the script to this answer: an HTML page, while history is kept, and a page policy that allows it. */
export function shouldInject(req: http.IncomingMessage, status: number, headers: http.IncomingHttpHeaders): boolean {
  if (!activitySettings().on) return false;
  if (req.method !== "GET" || status < 200 || status >= 300 || status === 204) return false;
  if (!/text\/html/i.test(String(headers["content-type"] ?? ""))) return false;
  if (headers["content-encoding"] && !/^identity$/i.test(String(headers["content-encoding"]))) return false;
  // A content security policy that wouldn't run a script from the page's own origin: leave the page as it is.
  const csp = String(headers["content-security-policy"] ?? "");
  if (csp) {
    const directive = (name: string) => new RegExp(`(?:^|;)\\s*${name}\\s+([^;]*)`, "i").exec(csp)?.[1];
    const scripts = directive("script-src-elem") ?? directive("script-src") ?? directive("default-src");
    if (scripts !== undefined && !/'self'/.test(scripts)) return false;
  }
  return true;
}

/**
 * Adds the script tag right after <head …> (or <html …>, or the doctype) as the page streams
 * through, holding back only the start of the page until that tag has gone by.
 */
export function injector(write: (chunk: Buffer) => void): { push(chunk: Buffer): void; end(): void } {
  let held: Buffer[] = [];
  let heldBytes = 0;
  let done = false;
  const release = (force: boolean) => {
    const buf = Buffer.concat(held);
    const text = buf.toString("latin1");
    let at = afterTag(text, /<head\b[^>]*>/i);
    if (at < 0 && force) at = afterTag(text, /<html\b[^>]*>/i);
    if (at < 0 && force) at = afterTag(text, /<!doctype[^>]*>/i);
    if (at < 0 && force) at = 0;
    if (at < 0) return false;
    write(Buffer.concat([buf.subarray(0, at), TAG, buf.subarray(at)]));
    held = [];
    done = true;
    return true;
  };
  return {
    push(chunk) {
      if (done) return write(chunk);
      held.push(chunk);
      heldBytes += chunk.length;
      release(heldBytes > 64 * 1024);
    },
    end() {
      if (!done && heldBytes) release(true);
    },
  };
}

function afterTag(text: string, re: RegExp): number {
  const m = re.exec(text);
  return m ? m.index + m[0].length : -1;
}
