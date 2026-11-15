import type http from "node:http";
import { onChange, type Problem } from "@dx/core";
import { devProblem, listDevServers } from "./dev.js";

/**
 * The live stream (`GET /api/events`, server-sent events): what changed in dx, as it changes, so
 * the page doesn't have to ask. Events say that something moved and carry what the page needs to
 * show it at once (a dev server's status, what it is doing, why it failed); anything bigger is
 * read again from the page's own routes. Nothing here is a command, and nothing secret goes in:
 * a status, a project's folder and name, a problem's words.
 *
 * It is behind the same token, Host and Origin checks as every /api route (the page reads it with
 * fetch, since EventSource can't send the token header). A watcher looks for changes once a second
 * only while a page is connected, so a dashboard nobody looks at does no extra work.
 */

export interface LiveEvent {
  id: number;
  at: string;
  type: string;
  data: Record<string, unknown>;
}

const RING = 200;
const HEARTBEAT_MS = 15_000;
const SLOW_CLIENT_BYTES = 1_000_000;

let nextId = 1;
const ring: LiveEvent[] = [];
const clients = new Set<(event: LiveEvent) => void>();

/** Tells every connected page. Returns the event (tests read it). */
export function publish(type: string, data: Record<string, unknown> = {}): LiveEvent {
  const event: LiveEvent = { id: nextId++, at: new Date().toISOString(), type, data };
  ring.push(event);
  if (ring.length > RING) ring.splice(0, ring.length - RING);
  for (const send of clients) send(event);
  return event;
}

/** The events after an id still in the ring, so a page that dropped for a moment catches up. */
export function eventsAfter(id: number): LiveEvent[] {
  return ring.filter((e) => e.id > id);
}

export const liveClientCount = () => clients.size;

// ---- the watcher: looks for what changed, only while someone is listening

let timer: NodeJS.Timeout | undefined;
let offChange: (() => void) | undefined;
let ticking = false;
let primed = false;
const seen = new Map<string, string>();

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const servers = listDevServers().filter((s) => !s.snapshot && !s.service);
    const live = new Set<string>();
    for (const s of servers) {
      live.add(s.dir);
      const signature = [s.status, s.step ?? "", s.errorCount, s.url ?? "", s.problem?.code ?? ""].join("|");
      if (seen.get(s.dir) === signature) continue;
      seen.set(s.dir, signature);
      // What's running when the first page connects is said by the page's own first read, not as news.
      if (!primed) continue;
      const problem: Problem | undefined = s.status === "failed" ? ((await devProblem(s.dir).catch(() => undefined)) ?? s.problem) : undefined;
      publish("dev", { dir: s.dir, project: s.project, status: s.status, step: s.step, errorCount: s.errorCount, url: s.url, recorded: s.recorded, problem });
    }
    for (const dir of [...seen.keys()]) {
      if (live.has(dir)) continue;
      seen.delete(dir);
      if (primed) publish("dev", { dir, status: "stopped" });
    }
    primed = true;
  } finally {
    ticking = false;
  }
}

function startWatching(): void {
  if (timer) return;
  primed = false;
  seen.clear();
  void tick();
  timer = setInterval(() => void tick(), 1000);
  timer.unref();
  offChange = onChange((c) => publish("change", { id: c.id, kind: c.kind, project: c.project, by: c.by }));
}

function stopWatching(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  offChange?.();
  offChange = undefined;
}

// ---- the stream

const open = new Set<http.ServerResponse>();

/** Answers one page's `GET /api/events` and keeps writing to it until it goes away. */
export function serveEvents(req: http.IncomingMessage, res: http.ServerResponse, after?: number): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Accel-Buffering": "no",
  });
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  open.add(res);

  const frame = (event: LiveEvent) => `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({ at: event.at, ...event.data })}\n\n`;
  const send = (event: LiveEvent) => {
    if (res.writableEnded) return;
    if (res.writableLength > SLOW_CLIENT_BYTES) return void res.end();
    res.write(frame(event));
  };

  res.write("retry: 3000\n\n");
  res.write(frame({ id: 0, at: new Date().toISOString(), type: "hello", data: { last: nextId - 1 } }).replace(/^id: 0\n/, ""));
  if (after !== undefined && Number.isFinite(after)) for (const e of eventsAfter(after)) send(e);

  clients.add(send);
  startWatching();
  const beat = setInterval(() => !res.writableEnded && res.write(": ping\n\n"), HEARTBEAT_MS);
  beat.unref();
  const cleanup = () => {
    clearInterval(beat);
    clients.delete(send);
    open.delete(res);
    if (!clients.size) stopWatching();
  };
  req.once("close", cleanup);
  res.once("close", cleanup);
}

/** Ends every stream (the dashboard is closing). */
export function stopEvents(): void {
  for (const res of open) res.end();
  open.clear();
  clients.clear();
  stopWatching();
}
