import type http from "node:http";
import zlib from "node:zlib";

/**
 * A log of the requests that pass through the local domains proxy (shop.localhost and its
 * services): method, path, status, timing, and the start of each body, with credentials masked.
 * It's how an AI agent, or you, sees what the front end sent to the API and what came back,
 * without adding console.log calls. Kept in memory only, and only while the dashboard runs.
 */

export type TrafficKind = "api" | "page" | "asset" | "socket";

export interface TrafficEntry {
  id: number;
  at: string;
  host: string;
  dir: string;
  service?: string;
  method: string;
  path: string;
  kind: TrafficKind;
  status?: number;
  ms?: number;
  error?: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  requestBytes: number;
  responseBytes: number;
  /** The body was longer than what's kept. */
  truncated?: boolean;
}

const MAX_ENTRIES = 1000;
const KEEP_REQUEST = 16 * 1024;
const KEEP_RESPONSE = 32 * 1024;
const CAPTURE = 512 * 1024;
const entries: TrafficEntry[] = [];
let seq = 0;

const SECRET_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token)$/i;
// "authorization" but not "author", "card_number" but not "cards".
const SECRET_KEY = /pass(word)?|passwd|secret|token|api[-_]?key|^auth$|authorization|credential|session[-_]?id|cookie|card[-_]?(number|no)|cvv|cvc|ssn|iban|private[-_]?key/i;
export const MASK = "•••";

/** Starts recording one exchange. Call the returned functions as the bodies stream and when it ends. */
export function recordExchange(req: http.IncomingMessage, route: { dir: string; service?: string }, host: string) {
  const started = Date.now();
  const entry: TrafficEntry = {
    id: ++seq,
    at: new Date(started).toISOString(),
    host,
    dir: route.dir,
    service: route.service,
    method: req.method ?? "GET",
    path: req.url ?? "/",
    kind: req.headers.upgrade ? "socket" : "asset",
    requestHeaders: maskHeaders(req.headers),
    responseHeaders: {},
    requestBytes: 0,
    responseBytes: 0,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);

  const reqChunks: Buffer[] = [];
  const resChunks: Buffer[] = [];
  let reqKept = 0;
  let resKept = 0;
  return {
    request(chunk: Buffer) {
      entry.requestBytes += chunk.length;
      if (reqKept < CAPTURE) {
        reqChunks.push(chunk);
        reqKept += chunk.length;
      }
    },
    response(chunk: Buffer) {
      entry.responseBytes += chunk.length;
      if (resKept < CAPTURE) {
        resChunks.push(chunk);
        resKept += chunk.length;
      }
    },
    headers(status: number, headers: http.IncomingHttpHeaders) {
      entry.status = status;
      entry.responseHeaders = maskHeaders(headers);
    },
    end(error?: string) {
      entry.ms = Date.now() - started;
      if (error) entry.error = error;
      const reqType = String(entry.requestHeaders["content-type"] ?? "");
      const resType = String(entry.responseHeaders["content-type"] ?? "");
      if (entry.kind !== "socket") entry.kind = classify(entry.method, resType, entry.path);
      if (isText(reqType) && reqChunks.length) {
        const body = Buffer.concat(reqChunks).toString("utf8");
        entry.requestBody = maskBody(cut(body, KEEP_REQUEST, entry), reqType);
      }
      if (entry.kind === "api" && isText(resType) && resChunks.length) {
        const raw = decode(Buffer.concat(resChunks), String(entry.responseHeaders["content-encoding"] ?? ""));
        if (raw !== undefined) entry.responseBody = maskBody(cut(raw, KEEP_RESPONSE, entry), resType);
      }
    },
  };
}

export interface TrafficQuery {
  dir?: string;
  service?: string;
  /** Only entries after this id. */
  after?: number;
  /** Include pages, scripts, styles and images, not only API calls. */
  all?: boolean;
  /** Only paths containing this. */
  path?: string;
  /** Only failed ones: 4xx, 5xx, or no answer. */
  failed?: boolean;
  limit?: number;
}

export function listTraffic(q: TrafficQuery = {}): TrafficEntry[] {
  const norm = (p: string) => (process.platform === "linux" ? p : p.toLowerCase());
  const out = entries.filter(
    (e) =>
      (q.dir === undefined || norm(e.dir) === norm(q.dir)) &&
      (q.service === undefined || e.service === q.service) &&
      (q.after === undefined || e.id > q.after) &&
      (q.all || e.kind === "api" || e.kind === "page" || (e.status ?? 0) >= 400 || !!e.error) &&
      (q.path === undefined || e.path.includes(q.path)) &&
      (!q.failed || (e.status ?? 0) >= 400 || !!e.error),
  );
  return out.slice(-(q.limit ?? 200));
}

export function clearTraffic(dir?: string): void {
  if (dir === undefined) return void entries.splice(0);
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].dir.toLowerCase() === dir.toLowerCase()) entries.splice(i, 1);
}

/** API calls are what matter; pages, scripts, styles and images are kept but listed only on request. */
export function classify(method: string, contentType: string, path: string): TrafficKind {
  if (/text\/html/i.test(contentType)) return "page";
  if (method !== "GET" && method !== "HEAD") return "api";
  if (/json|xml|text\/plain|graphql|x-www-form-urlencoded|event-stream/i.test(contentType)) return "api";
  if (/\/api\/|\/graphql|\/trpc\//i.test(path) && !/javascript|css|image|font/i.test(contentType)) return "api";
  return "asset";
}

function isText(type: string): boolean {
  return /json|text\/|xml|graphql|x-www-form-urlencoded|javascript/i.test(type);
}

function decode(buf: Buffer, encoding: string): string | undefined {
  try {
    if (/gzip/i.test(encoding)) return zlib.gunzipSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString("utf8");
    if (/deflate/i.test(encoding)) return zlib.inflateSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString("utf8");
    if (/br/i.test(encoding)) return zlib.brotliDecompressSync(buf).toString("utf8");
    return buf.toString("utf8");
  } catch {
    return undefined;
  }
}

function cut(text: string, max: number, entry: TrafficEntry): string {
  if (text.length <= max) return text;
  entry.truncated = true;
  return text.slice(0, max);
}

export function maskHeaders(headers: http.IncomingHttpHeaders | http.OutgoingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = SECRET_HEADERS.test(k) ? MASK : Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

/** Masks the values of keys that look like credentials, in JSON, forms and key=value text. */
export function maskBody(body: string, type: string): string {
  if (/json|graphql/i.test(type)) {
    try {
      return JSON.stringify(maskJson(JSON.parse(body)));
    } catch {
      // cut short or not JSON after all: fall through to the text rules
    }
  }
  if (/x-www-form-urlencoded/i.test(type)) {
    return body
      .split("&")
      .map((pair) => {
        const [k, ...rest] = pair.split("=");
        return SECRET_KEY.test(decodeURIComponent(k ?? "")) && rest.length ? `${k}=${MASK}` : pair;
      })
      .join("&");
  }
  return body.replace(/("?)([\w-]*(?:pass(?:word)?|secret|token|api[-_]?key)[\w-]*)\1(\s*[:=]\s*)("?)[^"&\s,}]+\4/gi, `$1$2$1$3$4${MASK}$4`);
}

function maskJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskJson);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET_KEY.test(k) && (typeof x === "string" || typeof x === "number") ? MASK : maskJson(x)]));
  }
  return v;
}
