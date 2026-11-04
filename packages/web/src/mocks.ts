import fs from "node:fs";
import type http from "node:http";
import { foldPath, loadMocks, matchMock, MOCK_BODY_MAX, mockFile, mockNeedsBody, type MockEndpoint, type MockSet } from "@dx/core";
import type { LocalRoute } from "./dev.js";
import { requestActivity } from "./recorder.js";
import { recordExchange } from "./traffic.js";

/**
 * Mock mode in the proxy: while a project's mock set is on, its API calls are answered here from
 * the recorded answers, never forwarded; pages, scripts and styles still come from the dev server.
 * Only requests that already reached dx's own proxy (or the localhost door) for a dev server dx
 * runs get here, so a mock can't be used to reach anything. Every mocked answer goes into the
 * network log and the activity history marked as mocked.
 */

const cache = new Map<string, { stamp: string; set: MockSet }>();

/** The project's mock set when mock mode is on; read again when its file changes (dx mock on in a terminal). */
export function activeMocks(dir: string): MockSet | undefined {
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
  return c.set.on ? c.set : undefined;
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

/**
 * Answers the request from the project's mocks when mock mode is on and one matches (or, in
 * strict mode, with a 404 for an API call that has none). True when it's answered here.
 */
export function answerFromMocks(req: http.IncomingMessage, res: http.ServerResponse, route: LocalRoute, label: string): boolean {
  const set = activeMocks(route.dir);
  if (!set) return false;
  const method = (req.method ?? "GET").toUpperCase();
  const url = req.url ?? "/";
  if (url.startsWith("/__dx/") || method === "OPTIONS" || req.headers.upgrade) return false;
  // Page loads are the dev server's: the front end itself always runs for real.
  if (method === "GET" && /text\/html/i.test(String(req.headers.accept ?? ""))) return false;
  const first = matchMock(set, { method, url, service: route.service });
  if (!first && !(set.strict && looksLikeApi(method, url, req.headers))) return false;

  const rec = recordExchange(req, route, label);
  rec.entry.mocked = true;
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (c: Buffer) => {
    rec.request(c);
    if (size < MOCK_BODY_MAX) {
      chunks.push(c);
      size += c.length;
    }
  });
  req.on("end", () => {
    let ep: Pick<MockEndpoint, "status" | "contentType" | "body" | "delayMs" | "offline"> | undefined = first;
    if (first && mockNeedsBody(set, method, url, route.service)) {
      ep = matchMock(set, { method, url, body: Buffer.concat(chunks).toString("utf8"), contentType: String(req.headers["content-type"] ?? ""), service: route.service }) ?? first;
    }
    ep ??= { status: 404, contentType: "application/json", body: JSON.stringify({ error: `No mock for ${method} ${foldPath(url)} (dx mock mode is strict)` }), delayMs: 0 };
    answer(ep);
  });

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
  function answer(ep: Pick<MockEndpoint, "status" | "contentType" | "body" | "delayMs" | "offline">): void {
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
      const headers: Record<string, string> = { "content-type": ep.contentType, "cache-control": "no-store", "x-dx-mock": "1" };
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
  return true;
}
