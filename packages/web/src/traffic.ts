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
  /** Answered by dx's mock mode, not the dev server. */
  mocked?: boolean;
  /** Changed on its way by these rules ("edited by hand" when intercepted and changed). */
  rules?: string[];
}

const MAX_ENTRIES = 1000;
const KEEP_REQUEST = 16 * 1024;
const KEEP_RESPONSE = 32 * 1024;
const CAPTURE = 512 * 1024;
const entries: TrafficEntry[] = [];
let seq = 0;

// The masking is core's, shared with the activity recorder and the dx browser.
import { MASK, classify, maskBody, maskHeaders } from "@dx/core";
export { MASK, classify, maskBody, maskHeaders };

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
  let resTotal = 0;
  let fullResponse: string | undefined;
  return {
    entry,
    /** The whole answer (up to 512 KB), decoded and masked, for the response cache; undefined when it was larger or not text. */
    fullResponse: () => fullResponse,
    request(chunk: Buffer) {
      entry.requestBytes += chunk.length;
      if (reqKept < CAPTURE) {
        reqChunks.push(chunk);
        reqKept += chunk.length;
      }
    },
    response(chunk: Buffer) {
      entry.responseBytes += chunk.length;
      resTotal += chunk.length;
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
        if (raw !== undefined) {
          if (resTotal <= CAPTURE) fullResponse = maskBody(raw, resType);
          entry.responseBody = maskBody(cut(raw, KEEP_RESPONSE, entry), resType);
        }
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

function isText(type: string): boolean {
  return /json|text\/|xml|graphql|x-www-form-urlencoded|javascript/i.test(type);
}

export function decode(buf: Buffer, encoding: string): string | undefined {
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

