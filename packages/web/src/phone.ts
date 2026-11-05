import crypto from "node:crypto";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import { qrMatrix, qrPath, recordRun, type Project } from "@dx/core";
import { listActivity } from "./activity.js";
import { HttpError, knownProject, type ApiRequest } from "./api.js";
import { localRoutes, type LocalRoute } from "./dev.js";
import { page, pipeUpgrade, relay } from "./proxy.js";
import { handleRecorderRequest } from "./recorder.js";

/**
 * Open on my phone: the one deliberate exception to "dx listens on this computer only". For one
 * project, on request, for a limited time, dx listens on this computer's address on the local
 * network and forwards to that project's dev server only (never the dashboard, never another
 * address). The QR code holds a one-time link: opening it on the phone trades it for a cookie
 * that only this session accepts, and the link stops working. Everything the phone does goes
 * into the history like a desktop visit, labelled "phone". It closes when the time is up, when
 * the dev server stops, when you press Stop, or when the dashboard closes.
 */

export interface PhoneView {
  dir: string;
  project: string;
  /** The address the phone opens (with the one-time code, until it's used). */
  url?: string;
  /** The QR code of `url`, as an SVG path for a square viewBox of `qrSize`. */
  qr?: string;
  qrSize?: number;
  /** The link was opened: a phone is connected. */
  joined: boolean;
  expiresAt: string;
  address: string;
}

interface Session {
  dir: string;
  project: string;
  server: http.Server;
  host: string;
  port: number;
  code?: string;
  secret: string;
  joined: boolean;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

const sessions = new Map<string, Session>();
const COOKIE = "dx_phone";

/** This computer's address on a private network (Wi-Fi or Ethernet), if it has one. */
export function lanAddress(): string | undefined {
  const all = Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === "IPv4" && !i.internal);
  const isPrivate = (a: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
  // Virtual adapters (WSL, Docker, VirtualBox) are usually 172.x; prefer the others.
  const ranked = all.filter((i) => isPrivate(i.address)).sort((a, b) => Number(a.address.startsWith("172.")) - Number(b.address.startsWith("172.")));
  return ranked[0]?.address;
}

function routeFor(dir: string): LocalRoute | undefined {
  const all = [...localRoutes().values()].filter((r) => r.dir.toLowerCase() === dir.toLowerCase());
  return all.find((r) => !r.service) ?? all[0];
}

function view(s: Session): PhoneView {
  const url = s.code ? `http://${s.host}:${s.port}/__dx/phone?c=${s.code}` : undefined;
  const qr = url ? qrPath(qrMatrix(url)) : undefined;
  return { dir: s.dir, project: s.project, url, qr: qr?.d, qrSize: qr?.size, joined: s.joined, expiresAt: new Date(s.expiresAt).toISOString(), address: `http://${s.host}:${s.port}` };
}

export function phoneSession(dir: string): PhoneView | undefined {
  const s = sessions.get(dir.toLowerCase());
  return s ? view(s) : undefined;
}

function cookieOf(req: http.IncomingMessage): string | undefined {
  for (const part of String(req.headers.cookie ?? "").split(/;\s*/)) if (part.startsWith(`${COOKIE}=`)) return part.slice(COOKIE.length + 1);
  return undefined;
}

function same(a: string | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Starts (or restarts) the phone session for a project whose dev server dx runs. */
export async function startPhone(project: Project, minutes = 30): Promise<PhoneView> {
  const route = routeFor(project.dir);
  if (!route) throw new Error(`${project.name}'s dev server isn't running through dx. Start it first.`);
  const host = lanAddress();
  if (!host) throw new Error("This computer isn't on a local network (no Wi-Fi or Ethernet address), so a phone can't reach it.");
  await stopPhone(project.dir);
  const key = project.dir.toLowerCase();
  const s: Session = {
    dir: project.dir,
    project: project.name,
    server: http.createServer(),
    host,
    port: 0,
    code: crypto.randomBytes(16).toString("hex"),
    secret: crypto.randomBytes(32).toString("hex"),
    joined: false,
    expiresAt: Date.now() + Math.max(5, Math.min(120, minutes)) * 60_000,
    timer: setTimeout(() => void stopPhone(project.dir, "time's up"), Math.max(5, Math.min(120, minutes)) * 60_000),
  };
  s.timer.unref?.();
  const origin = () => `http://${s.host}:${s.port}`;
  s.server.on("request", (req, res) => {
    const url = req.url ?? "/";
    // The one-time link: the code becomes this session's cookie, and stops working.
    if (url.startsWith("/__dx/phone")) {
      const code = new URL(url, origin()).searchParams.get("c") ?? "";
      if (!s.code || !same(code, s.code)) return page(res, 403, "This link was used already", "Open on my phone makes a new code each time: press it again on the dx dashboard and scan the new one.");
      s.code = undefined;
      s.joined = true;
      recordRun("phone", true, `${s.project}: a phone joined at ${s.host}`, "web", { project: s.project });
      res.writeHead(302, { location: "/", "set-cookie": `${COOKIE}=${s.secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.round((s.expiresAt - Date.now()) / 1000)}`, "cache-control": "no-store" });
      return void res.end();
    }
    if (!same(cookieOf(req), s.secret)) return page(res, 403, "Scan the code on the dx dashboard", "This address only answers the phone that opened its one-time link.");
    const live = routeFor(s.dir);
    if (!live) return page(res, 502, `${s.project} isn't running`, "Its dev server stopped. Start it again on the dx dashboard.");
    const r: LocalRoute = { ...live, env: "phone" };
    if (url.startsWith("/__dx/") && handleRecorderRequest(req, res, r, origin())) return;
    const port = Number(new URL(live.url).port || 80);
    relay(req, res, {
      port,
      headers: headersFor(req, port),
      route: r,
      label: `${s.host}:${s.port}`,
      publicOrigin: origin(),
      unreachable: (code) => page(res, 502, `${s.project} isn't answering`, `Its dev server didn't take the connection (${code}).`),
    });
  });
  s.server.on("upgrade", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const live = routeFor(s.dir);
    if (!live || !same(cookieOf(req), s.secret)) return void socket.destroy();
    const port = Number(new URL(live.url).port || 80);
    pipeUpgrade(req, socket, head, port, headersFor(req, port));
  });
  await new Promise<void>((resolve, reject) => {
    s.server.once("error", reject);
    // Only this computer's own address on the local network, never every interface.
    s.server.listen(0, host, () => resolve());
  });
  s.port = (s.server.address() as net.AddressInfo).port;
  sessions.set(key, s);
  recordRun("phone", true, `${project.name}: open on a phone at ${host}:${s.port}, for ${Math.round((s.expiresAt - Date.now()) / 60_000)} minutes`, "web", { project: project.name });
  return view(s);
}

/** The phone's request as the dev server should get it: dx's host, without dx's cookie. */
function headersFor(req: http.IncomingMessage, port: number): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: `localhost:${port}`, "x-forwarded-host": req.headers.host, "x-forwarded-proto": "http" };
  const rest = String(req.headers.cookie ?? "")
    .split(/;\s*/)
    .filter((c) => c && !c.startsWith(`${COOKIE}=`))
    .join("; ");
  if (rest) headers.cookie = rest;
  else delete headers.cookie;
  return headers;
}

export async function stopPhone(dir: string, why = "stopped"): Promise<boolean> {
  const key = dir.toLowerCase();
  const s = sessions.get(key);
  if (!s) return false;
  sessions.delete(key);
  clearTimeout(s.timer);
  await new Promise<void>((resolve) => {
    s.server.close(() => resolve());
    s.server.closeAllConnections?.();
  });
  recordRun("phone", true, `${s.project}: phone session ended (${why})`, "web", { project: s.project });
  return true;
}

export async function stopAllPhones(): Promise<void> {
  await Promise.all([...sessions.values()].map((s) => stopPhone(s.dir, "the dashboard closed")));
}

/** Closes sessions whose dev server stopped. Called on the dashboard's regular check. */
export function prunePhones(): void {
  for (const s of sessions.values()) if (!routeFor(s.dir)) void stopPhone(s.dir, "the dev server stopped");
}

// ------------------------------------------------------------------ routes

export const phoneRoutes: Record<string, (req: ApiRequest) => unknown> = {
  "GET /api/phone": (req) => {
    const project = knownProject(req.query.get("dir"));
    const session = phoneSession(project.dir);
    // What the phone did lately: console, errors, clicks and calls from its visits.
    const events = session ? listActivity({ dir: project.dir, env: "phone", since: new Date(Date.now() - 2 * 3_600_000), limit: 40 }) : [];
    return { session, address: lanAddress() ?? null, events: events.map((e) => ({ id: e.id, at: e.at, type: e.type, level: e.level, text: e.text.slice(0, 300) })) };
  },
  "POST /api/phone": async (req) => {
    const project = knownProject(req.body.dir);
    if (req.body.on === false) return { stopped: await stopPhone(project.dir) };
    const minutes = Number(req.body.minutes ?? 30);
    try {
      return await startPhone(project, Number.isFinite(minutes) ? minutes : 30);
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
  },
};
