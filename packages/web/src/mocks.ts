import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import {
  addMocks,
  foldPath,
  loadMocks,
  matchMock,
  MOCK_BODY_MAX,
  mockFile,
  mockNeedsBody,
  saveMocks,
  type ActivityEvent,
  type MockEndpoint,
  type MockSet,
  type MockWanted,
} from "@dx/core";
import type { LocalRoute } from "./dev.js";
import { requestActivity } from "./recorder.js";
import { recordExchange, type TrafficEntry } from "./traffic.js";

/**
 * Mocks in the dashboard:
 * - mock mode in the proxy: while it's on, a project's API calls are answered from its mocks,
 *   never forwarded; pages, scripts and styles still come from the dev server;
 * - the cache: real answers that pass through are kept as mocks (source "cache") until purged;
 * - the mock server: a project's mocks on an address of their own (localhost:<port> and
 *   <project>.mock.localhost), answering from the first call like a Postman mock server, with or
 *   without the dev server.
 * All of it only on this computer, and only from the project's own mock file. Every mocked
 * answer goes into the network log and the activity history marked as mocked.
 */

const cache = new Map<string, { stamp: string; set: MockSet }>();

/** The project's mock set, read again when its file changes (dx mock in a terminal). */
export function projectMocks(dir: string): MockSet | undefined {
  const file = mockFile(dir);
  let stamp: string;
  try {
    const st = fs.statSync(file);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    cache.delete(file);
    return undefined;
  }
  let c = cache.get(file);
  if (!c || c.stamp !== stamp) {
    c = { stamp, set: loadMocks(dir) };
    cache.set(file, c);
  }
  return c.set;
}

/** The project's mock set when mock mode is on. */
export function activeMocks(dir: string): MockSet | undefined {
  const set = projectMocks(dir);
  return set?.on ? set : undefined;
}

/** After the dashboard changed a set: read it again on the next request. */
export function forgetMocks(): void {
  cache.clear();
}

/** An API call by its look, for strict mode: not a page, not a script, style or image. */
function looksLikeApi(method: string, url: string, headers: http.IncomingHttpHeaders): boolean {
  if (method !== "GET" && method !== "HEAD") return true;
  if (/\/api\/|\/graphql|\/trpc\//i.test(url.split("?")[0] + "/")) return true;
  return /json|xml/i.test(String(headers.accept ?? "")) && !/text\/html/i.test(String(headers.accept ?? ""));
}

/** The answer a caller asks for, as with Postman: x-mock-response-code / x-mock-response-name (Prism's Prefer: code=… too). */
export function wantedOf(headers: http.IncomingHttpHeaders): MockWanted {
  const code = Number(headers["x-mock-response-code"] ?? /\bcode=(\d{3})\b/.exec(String(headers.prefer ?? ""))?.[1]);
  const name = String(headers["x-mock-response-name"] ?? /\bexample=([\w.-]+)/.exec(String(headers.prefer ?? ""))?.[1] ?? "").slice(0, 100);
  return { code: Number.isInteger(code) && code >= 100 && code <= 599 ? code : undefined, name: name || undefined };
}

type Answer = Pick<MockEndpoint, "status" | "contentType" | "body" | "delayMs" | "offline">;

/**
 * Answers the request from the project's mocks when mock mode is on and one matches, or in strict
 * mode with a 404 for an API call that has none. True when it's answered here.
 */
export function answerFromMocks(req: http.IncomingMessage, res: http.ServerResponse, route: LocalRoute, label: string): boolean {
  const set = activeMocks(route.dir);
  if (!set || !set.endpoints.length) return false;
  const method = (req.method ?? "GET").toUpperCase();
  const url = req.url ?? "/";
  if (url.startsWith("/__dx/") || method === "OPTIONS" || req.headers.upgrade) return false;
  // Page loads are the dev server's: the front end itself always runs for real.
  if (method === "GET" && /text\/html/i.test(String(req.headers.accept ?? ""))) return false;
  const want = wantedOf(req.headers);
  const first = matchMock(set, { method, url, service: route.service }, want);
  if (!first && !(set.strict && looksLikeApi(method, url, req.headers))) return false;
  serveFromSet(req, res, route, label, set, first, want, () => ({
    status: 404,
    contentType: "application/json",
    body: JSON.stringify({ error: `No mock for ${method} ${foldPath(url)} (dx mock mode is strict)` }),
    delayMs: 0,
  }));
  return true;
}

/** Reads the request (when the mock depends on its body), picks the answer and sends it, logged as mocked. */
function serveFromSet(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  route: LocalRoute,
  label: string,
  set: MockSet,
  first: MockEndpoint | undefined,
  want: MockWanted,
  missing: () => Answer,
  extraHeaders: Record<string, string> = {},
): void {
  const method = (req.method ?? "GET").toUpperCase();
  const url = req.url ?? "/";
  const rec = recordExchange(req, route, label);
  rec.entry.mocked = true;
  const chunks: Buffer[] = [];
  let size = 0;
  let answered = false;
  let timer: NodeJS.Timeout | undefined;
  const ua = String(req.headers["user-agent"] ?? "");
  const finish = (error?: string) => {
    rec.end(error);
    requestActivity(rec.entry, route, ua);
  };
  res.on("close", () => {
    if (answered) return;
    answered = true;
    if (timer) clearTimeout(timer);
    finish("closed before the mock answered");
  });
  const decide = () => {
    let ep: Answer | undefined = first;
    if (first && mockNeedsBody(set, method, url, route.service)) {
      ep = matchMock(set, { method, url, body: Buffer.concat(chunks).toString("utf8"), contentType: String(req.headers["content-type"] ?? ""), service: route.service }, want) ?? first;
    }
    answer(ep ?? missing());
  };
  // A request whose body was already read elsewhere is answered at once.
  if (req.readableEnded) decide();
  else {
    req.on("data", (c: Buffer) => {
      rec.request(c);
      if (size < MOCK_BODY_MAX) {
        chunks.push(c);
        size += c.length;
      }
    });
    req.on("end", decide);
  }
  function answer(ep: Answer): void {
    const go = () => {
      if (answered) return;
      answered = true;
      if (ep.offline) {
        // As if the API were down: the connection closes with no answer.
        finish("offline (a dx mock)");
        req.socket.destroy();
        return;
      }
      const empty = method === "HEAD" || ep.status === 204 || ep.status === 304;
      const body = empty ? Buffer.alloc(0) : Buffer.from(ep.body, "utf8");
      const headers: Record<string, string> = { "content-type": ep.contentType, "cache-control": "no-store", "x-dx-mock": "1", ...extraHeaders };
      if (!empty) headers["content-length"] = String(body.length);
      rec.headers(ep.status, headers);
      if (body.length) rec.response(body);
      res.writeHead(ep.status, headers);
      res.end(body.length ? body : undefined);
      finish();
    };
    if (ep.delayMs > 0) timer = setTimeout(go, Math.min(ep.delayMs, 30_000));
    else go();
  }
}

// ------------------------------------------------------------------ the cache

const pendingCache = new Map<string, { project: string; events: ActivityEvent[]; timer: NodeJS.Timeout }>();

/**
 * Keeps a real answer as a mock when the project's cache is on: the newest answer per endpoint
 * (and per query or body where calls differ), masked like the rest of the history, written in
 * batches a second apart. Errors from the server (5xx), redirects and answers too large to keep
 * whole aren't kept.
 */
export function cacheAnswer(route: LocalRoute, e: TrafficEntry, fullBody: string | undefined): void {
  const set = projectMocks(route.dir);
  if (!set?.cache || e.mocked || e.kind !== "api" || e.error || fullBody === undefined) return;
  const status = e.status ?? 0;
  if (status < 200 || status >= 500 || (status >= 300 && status < 400)) return;
  const event: ActivityEvent = {
    id: e.id,
    at: e.at,
    dir: route.dir,
    project: route.project,
    service: route.service ?? e.service,
    type: "request",
    text: "",
    method: e.method,
    url: e.path,
    status,
    requestHeaders: e.requestHeaders,
    responseHeaders: e.responseHeaders,
    requestBody: e.requestBody,
    responseBody: fullBody,
    from: "proxy",
  };
  const key = route.dir.toLowerCase();
  const p = pendingCache.get(key);
  if (p) p.events.push(event);
  else {
    const timer = setTimeout(() => flushCache(key), 1000);
    timer.unref?.();
    pendingCache.set(key, { project: route.project, events: [event], timer });
  }
}

export function flushCache(key?: string): void {
  for (const [k, p] of pendingCache) {
    if (key && k !== key) continue;
    clearTimeout(p.timer);
    pendingCache.delete(k);
    try {
      addMocks(p.events[0].dir, p.project, p.events, "cache");
    } catch {
      // the next batch tries again
    }
  }
  forgetMocks();
}

// ------------------------------------------------------------------ the mock server

interface MockServer {
  dir: string;
  project: string;
  name: string;
  port: number;
  server: http.Server;
}

const servers = new Map<string, MockServer>();
const key = (dir: string) => (process.platform === "linux" ? dir : dir.toLowerCase());

/** dx's names for things in addresses: "Shop Website" → "shop-website". */
function hostName(project: string): string {
  return project.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

export function listMockServers(): Array<{ dir: string; project: string; port: number; url: string; host: string }> {
  return [...servers.values()].map((s) => ({ dir: s.dir, project: s.project, port: s.port, url: `http://localhost:${s.port}`, host: `${s.name}.mock.localhost` }));
}

export function mockServerFor(dir: string) {
  return listMockServers().find((s) => key(s.dir) === key(dir));
}

/** The project whose mock server answers at <name>.mock.localhost, for the local domains proxy. */
export function mockServerByHost(host: string): MockServer | undefined {
  const m = /^([a-z0-9-]+)\.mock\.localhost$/.exec(host);
  return m ? [...servers.values()].find((s) => s.name === m[1]) : undefined;
}

/**
 * Starts a project's mock server on this computer only: the port it had before when that's free
 * (so its address stays the same), else 4010 and up (Prism's usual port), else any free one.
 */
export async function startMockServer(dir: string, project: string): Promise<{ port: number; url: string; host: string }> {
  const running = servers.get(key(dir));
  if (running) return mockServerFor(dir)!;
  const set = loadMocks(dir, project);
  const server = http.createServer((req, res) => handleMockServer(req, res, entry));
  const entry: MockServer = { dir, project, name: hostName(project), port: 0, server };
  const tries = [set.serverPort, ...Array.from({ length: 40 }, (_, i) => 4010 + i), 0].filter((p): p is number => p !== undefined);
  for (const p of tries) {
    const port = await listenOn(server, p);
    if (port) {
      entry.port = port;
      break;
    }
  }
  if (!entry.port) throw new Error("No free port for the mock server.");
  servers.set(key(dir), entry);
  set.server = true;
  set.serverPort = entry.port;
  saveMocks(set);
  forgetMocks();
  return mockServerFor(dir)!;
}

export async function stopMockServer(dir: string, remember = true): Promise<boolean> {
  const s = servers.get(key(dir));
  if (!s) return false;
  servers.delete(key(dir));
  await new Promise<void>((r) => s.server.close(() => r()));
  s.server.closeAllConnections?.();
  if (remember) {
    const set = loadMocks(dir, s.project);
    set.server = false;
    saveMocks(set);
    forgetMocks();
  }
  return true;
}

/** Stops them all when the dashboard stops; each starts again with the dashboard (its set remembers). */
export async function stopAllMockServers(): Promise<void> {
  for (const s of [...servers.values()]) await stopMockServer(s.dir, false);
}

function listenOn(server: http.Server, port: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    const onError = () => {
      server.removeListener("listening", onListening);
      resolve(undefined);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve((server.address() as net.AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

/** CORS for pages on this computer only: a site on the internet can't read the mocks. */
function corsHeaders(origin: string | undefined): Record<string, string> {
  if (!origin) return {};
  let host = "";
  try {
    host = new URL(origin).hostname;
  } catch {
    return {};
  }
  if (!(host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost"))) return {};
  return { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" };
}

/** One request to a mock server: always answered from the mocks, whether mock mode is on or not. */
export function handleMockServer(req: http.IncomingMessage, res: http.ServerResponse, s: { dir: string; project: string; name: string }): void {
  const method = (req.method ?? "GET").toUpperCase();
  const url = req.url ?? "/";
  const cors = corsHeaders(typeof req.headers.origin === "string" ? req.headers.origin : undefined);
  if (method === "OPTIONS") {
    res.writeHead(204, {
      ...cors,
      "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS",
      "access-control-allow-headers": String(req.headers["access-control-request-headers"] ?? "content-type, authorization"),
      "access-control-max-age": "600",
    });
    return void res.end();
  }
  const set = projectMocks(s.dir) ?? loadMocks(s.dir, s.project);
  const route: LocalRoute = { url: `http://localhost`, dir: s.dir, project: s.project };
  const want = wantedOf(req.headers);
  const first = matchMock(set, { method, url }, want);
  serveFromSet(
    req,
    res,
    route,
    `${s.name}.mock.localhost`,
    set,
    first,
    want,
    () => ({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        error: `No mock for ${method} ${foldPath(url)}${want.code ? ` answering ${want.code}` : ""}${want.name ? ` named ${want.name}` : ""}`,
        hint: "Add one from the API spec, the cache or the history on dx's Requests page.",
      }),
      delayMs: 0,
    }),
    cors,
  );
}
