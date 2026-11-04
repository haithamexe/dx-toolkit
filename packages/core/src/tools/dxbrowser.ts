import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import type { Readable, Writable } from "node:stream";
import { dxPath } from "../config.js";
import type { ActivityEvent, ActivityInput } from "./activity.js";
import { browserInstallFix, findBrowser } from "./browser.js";
import { classify, isTextType, maskBody, maskHeaders, maskText, maskUrl } from "./mask.js";
import { deploymentFrom, type SiteTarget } from "./sites.js";

/**
 * The dx browser: a Chrome, Edge, Chromium or Brave window with a profile of its own
 * (~/.dx/browser-profile), driven over the DevTools protocol through a pipe (file descriptors 3
 * and 4), not a debugging port, so no other program on this computer can connect to it. It
 * records what happens on the sites you chose (and on addresses on this computer) into the
 * activity history, the same events the local recorder produces: requests with their payloads
 * and responses, page loads and route changes, clicks and form submits (never typed values),
 * console output and errors. Anything else you browse in it is dropped as it arrives.
 */

export interface DxBrowserOptions {
  /** Where events go: a recorded site's project and environment, or undefined to record nothing for this address. */
  targetFor: (url: string) => SiteTarget | undefined;
  /** Each recorded event, masked already. */
  onEvent: (e: ActivityInput) => void;
  /** Requests never recorded, even from a recorded page (the dashboard's own API). */
  ignore?: (url: string) => boolean;
  /** The first address to open (http or https). */
  url?: string;
  /** Default ~/.dx/browser-profile. */
  profileDir?: string;
  /** Without a window, for tests. */
  headless?: boolean;
}

export interface DxBrowser {
  /** Which browser: Chrome, Edge… */
  browser: string;
  pid?: number;
  profileDir: string;
  startedAt: string;
  /** Tabs open now. */
  pages(): number;
  /** Opens an address in a new tab. */
  open(url: string): Promise<void>;
  close(): Promise<void>;
  /** Settles when the browser has gone, closed by you or by dx. */
  closed: Promise<void>;
}

/** Only http(s) addresses are opened; no user name or password in them. */
export function checkOpenUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    throw new Error("Give a full address to open, starting with http:// or https://.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http and https addresses can be opened in the dx browser.");
  if (u.username || u.password) throw new Error("Leave the user name and password out of the address; sign in on the page instead.");
  return u.href;
}

// ------------------------------------------------------------------ the pipe

type Message = { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
export type CdpSend = <T = unknown>(method: string, params?: object, sessionId?: string) => Promise<T>;

/** The DevTools protocol over a pipe: JSON messages, each ended by a NUL byte. */
export class PipeConnection {
  private id = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private chunks: Buffer[] = [];
  private closedFlag = false;
  onEvent: (method: string, params: Record<string, unknown>, sessionId?: string) => void = () => undefined;
  onClose: () => void = () => undefined;

  constructor(
    private out: Writable,
    input: Readable,
  ) {
    input.on("data", (chunk: Buffer) => this.receive(chunk));
    const end = () => this.shutdown();
    input.on("close", end);
    input.on("end", end);
    input.on("error", end);
    out.on("error", end);
  }

  private receive(chunk: Buffer): void {
    let start = 0;
    for (let i = chunk.indexOf(0); i >= 0; i = chunk.indexOf(0, start)) {
      this.chunks.push(chunk.subarray(start, i));
      const text = Buffer.concat(this.chunks).toString("utf8");
      this.chunks = [];
      start = i + 1;
      let msg: Message;
      try {
        msg = JSON.parse(text) as Message;
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
    if (start < chunk.length) this.chunks.push(chunk.subarray(start));
  }

  private dispatch(msg: Message): void {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    } else if (msg.method) {
      try {
        this.onEvent(msg.method, msg.params ?? {}, msg.sessionId);
      } catch {
        // one event that couldn't be read doesn't stop the others
      }
    }
  }

  send: CdpSend = <T = unknown>(method: string, params: object = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> => {
    if (this.closedFlag) return Promise.reject(new Error("The dx browser has closed."));
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser didn't answer ${method}.`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      this.out.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
  };

  get closed(): boolean {
    return this.closedFlag;
  }

  private shutdown(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("The dx browser has closed."));
    }
    this.pending.clear();
    this.onClose();
  }
}

// ------------------------------------------------------------------ from DevTools events to activity

/** The isolated world the click listener runs in: the page's own scripts can't see it or its binding. */
export const RECORDER_WORLD = "dx-recorder";
export const BINDING = "__dxRecord";

/**
 * Runs in every page, in its own world (it shares the DOM, not the scripts): reports clicks on
 * controls and form submits the way public/recorder.js does, by label and how to find the
 * control again, never what was typed.
 */
export const CLICK_SCRIPT = String.raw`(() => {
  if (window.__dxClicks) return;
  window.__dxClicks = true;
  const send = (ev) => { try { __dxRecord(JSON.stringify(ev)); } catch (e) {} };
  const clip = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n) + "…" : s; };
  const short = (href) => { try { const u = new URL(href); return u.origin === location.origin ? u.pathname + u.search + u.hash : href; } catch (e) { return href; } };
  const CONTROL = 'a,button,summary,select,label,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="switch"],input[type="submit"],input[type="button"],input[type="checkbox"],input[type="radio"],input[type="reset"]';
  const nameOf = (el) => {
    let label = el.getAttribute("aria-label") || "";
    if (!label && el.id && el.tagName !== "LABEL") { const f = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (f) label = f.textContent || ""; }
    if (!label && el.tagName === "INPUT" && (el.type === "submit" || el.type === "button" || el.type === "reset")) label = el.value || "";
    if (!label && el.tagName !== "SELECT") label = el.innerText || el.textContent || "";
    if (!label) label = el.getAttribute("title") || el.getAttribute("name") || el.getAttribute("alt") || "";
    return clip(label.replace(/\s+/g, " ").trim(), 80);
  };
  const targetOf = (el, name) => {
    for (const a of ["data-testid", "data-test", "data-cy"]) { const v = el.getAttribute(a); if (v) return "[" + a + "=" + JSON.stringify(v) + "]"; }
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) && document.querySelectorAll("#" + el.id).length === 1) return "#" + el.id;
    if (name && name.length <= 60) return "text=" + name;
    return undefined;
  };
  const kindOf = (el) => el.getAttribute("role") || (el.tagName === "A" ? "link" : el.tagName === "INPUT" ? el.type : el.tagName.toLowerCase());
  document.addEventListener("click", (e) => {
    try {
      const el = e.target && e.target.closest ? e.target.closest(CONTROL) : null;
      if (!el) return;
      const name = nameOf(el);
      let text = "Clicked " + kindOf(el) + (name ? " “" + name + "”" : "");
      if (el.tagName === "A" && el.getAttribute("href")) text += " (" + clip(short(el.href), 200) + ")";
      if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) text += el.checked ? ", now on" : ", now off";
      send({ type: "action", text, target: targetOf(el, name), at: Date.now() });
    } catch (err) {}
  }, true);
  document.addEventListener("submit", (e) => {
    try {
      const f = e.target;
      const name = f.getAttribute("aria-label") || f.getAttribute("name") || f.id || "";
      const method = (f.getAttribute("method") || "get").toUpperCase();
      send({ type: "action", text: "Submitted form" + (name ? " “" + clip(name, 80) + "”" : "") + " (" + method + " " + clip(short(f.action || location.href), 200) + ")", at: Date.now() });
    } catch (err) {}
  }, true);
})();`;

const META_SCRIPT = String.raw`(() => { const out = {}; for (const m of document.querySelectorAll("meta[name]")) { const n = (m.getAttribute("name") || "").toLowerCase(); if (/^(version|app-version|commit|git-commit|revision|build|build-id|release)$/.test(n)) out[n] = String(m.getAttribute("content") || "").slice(0, 100); } return out; })()`;

const KEEP_REQUEST = 16 * 1024;
const KEEP_RESPONSE = 32 * 1024;
const MAX_TEXT = 4000;
// The dev server's own chatter isn't the app's output (as in the recorder); its warnings and errors are kept.
const CHATTER = /^\[(vite|hmr|webpack-dev-server|webpack|fast refresh|hot module replacement|wds)\]/i;

interface Req {
  id: string;
  url: string;
  method: string;
  headers: Record<string, unknown>;
  postData?: string;
  hasPostData?: boolean;
  type?: string;
  started: number;
  wall: number;
  target: SiteTarget;
  page?: string;
  visit?: string;
  document: boolean;
  status?: number;
  responseHeaders?: Record<string, unknown>;
  mime?: string;
  bodies: boolean;
}

interface Session {
  id: string;
  targetId: string;
  type: string;
  url: string;
  visit?: string;
  visitLoader?: string;
  requests: Map<string, Req>;
  pendingPage?: { event: ActivityInput; timer: NodeJS.Timeout };
  /** dx is loading an address in it already. */
  claimed?: boolean;
}

interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  unserializableValue?: string;
  preview?: { properties?: { name: string; value?: string }[]; overflow?: boolean; subtype?: string };
}
interface CallFrame {
  functionName?: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

/** A new visit id, like the recorder's: 8 random characters, then the time it started in base 36. */
export function newVisitId(now = Date.now()): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, "0") + now.toString(36);
}

/**
 * Turns DevTools events into activity events. It owns no browser: `send` talks to one (or, in
 * tests, answers from fixtures), so every mapping can be tested with recorded messages.
 */
export class CdpRecorder {
  private sessions = new Map<string, Session>();
  /** Targets set up and running, by target id, for loading an address only once dx listens. */
  private ready = new Map<string, string>();
  private waiters = new Map<string, (sessionId: string) => void>();
  /**
   * How far the browser's clock is from this process's (a few ms): events the browser stamps
   * (requests, console) and ones it doesn't (route changes, stamped on arrival) stay in order.
   */
  private skew = 0;

  private browserTime(ms: unknown): string | undefined {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
    this.skew = ms - Date.now();
    return new Date(ms).toISOString();
  }

  private browserNow(): string {
    return new Date(Date.now() + Math.max(-5000, Math.min(5000, this.skew))).toISOString();
  }

  /** The session of a target once it's set up, or undefined after `ms`. */
  whenReady(targetId: string, ms = 10_000): Promise<string | undefined> {
    const known = this.ready.get(targetId);
    if (known) return Promise.resolve(known);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(targetId);
        resolve(undefined);
      }, ms);
      timer.unref?.();
      this.waiters.set(targetId, (id) => {
        clearTimeout(timer);
        resolve(id);
      });
    });
  }

  constructor(
    private options: Pick<DxBrowserOptions, "targetFor" | "onEvent" | "ignore"> & { send: CdpSend; settleMs?: number },
  ) {}

  pages(): number {
    return [...this.sessions.values()].filter((s) => s.type === "page").length;
  }

  /** A tab that shows nothing yet (the one the browser opened with), to load the first address in. */
  blankPage(claim = true): string | undefined {
    const ready = new Set(this.ready.values());
    const s = [...this.sessions.values()].find((x) => x.type === "page" && ready.has(x.id) && !x.claimed && (!x.url || x.url === "about:blank"));
    if (s && claim) s.claimed = true;
    return s?.id;
  }

  /** Sets a page or frame up: Network, Runtime, Page and Log, the click listener, then lets it run. */
  async attach(sessionId: string, info: { targetId: string; type: string; url?: string }, waiting = true): Promise<void> {
    const send = this.options.send;
    if (info.type !== "page" && info.type !== "iframe") {
      // Workers: nothing to record there that the page doesn't see.
      if (waiting) await send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
      return;
    }
    this.sessions.set(sessionId, { id: sessionId, targetId: info.targetId, type: info.type, url: info.url ?? "", requests: new Map() });
    const steps = [
      send("Runtime.addBinding", { name: BINDING, executionContextName: RECORDER_WORLD }, sessionId),
      send("Page.addScriptToEvaluateOnNewDocument", { source: CLICK_SCRIPT, worldName: RECORDER_WORLD, runImmediately: true }, sessionId),
      send("Page.enable", {}, sessionId),
      send("Network.enable", { maxPostDataSize: KEEP_REQUEST }, sessionId),
      send("Runtime.enable", {}, sessionId),
      send("Log.enable", {}, sessionId),
      send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId),
    ];
    await Promise.all(steps.map((p) => p.catch(() => undefined)));
    if (waiting) await send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
    if (this.sessions.has(sessionId)) {
      this.ready.set(info.targetId, sessionId);
      this.waiters.get(info.targetId)?.(sessionId);
      this.waiters.delete(info.targetId);
    }
  }

  detach(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.pendingPage) this.flushPage(s);
    this.sessions.delete(sessionId);
    if (this.ready.get(s.targetId) === sessionId) this.ready.delete(s.targetId);
  }

  /** One DevTools event. */
  handle(method: string, p: Record<string, unknown>, sessionId?: string): void {
    if (method === "Target.attachedToTarget") {
      const info = p.targetInfo as { targetId: string; type: string; url?: string };
      void this.attach(p.sessionId as string, info, p.waitingForDebugger !== false);
      return;
    }
    if (method === "Target.detachedFromTarget") return this.detach(p.sessionId as string);
    const s = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!s) return;
    switch (method) {
      case "Network.requestWillBeSent":
        return this.requestStarted(s, p);
      case "Network.responseReceived": {
        const r = s.requests.get(p.requestId as string);
        if (!r) return;
        const res = p.response as { status: number; headers: Record<string, unknown>; mimeType?: string };
        r.status = res.status;
        r.responseHeaders = res.headers;
        r.mime = res.mimeType || headerOf(res.headers, "content-type");
        return;
      }
      case "Network.loadingFinished":
        return void this.requestEnded(s, p.requestId as string, p.timestamp as number);
      case "Network.loadingFailed": {
        if (p.canceled || p.errorText === "net::ERR_ABORTED") {
          s.requests.delete(p.requestId as string);
          return;
        }
        return void this.requestEnded(s, p.requestId as string, p.timestamp as number, String(p.errorText ?? "failed"));
      }
      case "Page.frameNavigated": {
        const frame = p.frame as { id: string; parentId?: string; url: string; urlFragment?: string; loaderId?: string };
        if (frame.parentId && frame.id !== s.targetId) return;
        s.url = frame.url + (frame.urlFragment ?? "");
        if (frame.loaderId !== s.visitLoader) {
          s.visit = newVisitId();
          s.visitLoader = frame.loaderId;
        }
        return;
      }
      case "Page.navigatedWithinDocument": {
        if (p.frameId !== s.targetId && s.type === "page") return;
        const to = p.url as string;
        const from = s.url;
        s.url = to;
        if (to === from) return;
        const target = this.options.targetFor(to);
        if (!target) return;
        return this.emit(target, { type: "route", text: `${short(from, to)} → ${short(to, to)}`, page: maskUrl(to), visit: s.visit, at: this.browserNow() });
      }
      case "Page.domContentEventFired":
        return void this.readMeta(s);
      case "Runtime.consoleAPICalled":
        return this.console(s, p);
      case "Runtime.exceptionThrown":
        return this.exception(s, p);
      case "Runtime.bindingCalled":
        if (p.name === BINDING) this.binding(s, String(p.payload ?? ""));
        return;
      case "Log.entryAdded": {
        const e = p.entry as { level: string; text: string; source: string; url?: string; lineNumber?: number; timestamp?: number };
        // Network failures come with their request; console calls and exceptions from Runtime.
        if (e.source !== "security" || (e.level !== "error" && e.level !== "warning")) return;
        const target = this.options.targetFor(s.url);
        if (!target) return;
        return this.emit(target, {
          type: "console",
          level: e.level === "error" ? "error" : "warn",
          text: maskText(clip(e.text, MAX_TEXT)),
          source: e.url ? `${shortSource(e.url, s.url)}${e.lineNumber !== undefined ? `:${e.lineNumber + 1}` : ""}` : undefined,
          page: maskUrl(s.url),
          visit: s.visit,
          at: e.timestamp ? new Date(e.timestamp).toISOString() : undefined,
        });
      }
    }
  }

  private emit(target: SiteTarget, e: Omit<ActivityInput, "dir" | "from">): void {
    this.options.onEvent({ ...e, dir: target.dir, project: target.project, service: target.service, site: target.site, env: target.env, from: "dx-browser" } as ActivityInput);
  }

  private requestStarted(s: Session, p: Record<string, unknown>): void {
    const request = p.request as { url: string; method: string; headers: Record<string, unknown>; postData?: string; hasPostData?: boolean };
    const id = p.requestId as string;
    const prev = s.requests.get(id);
    // A redirect: the hop before it is finished, with the answer that sent it on.
    if (prev && p.redirectResponse) {
      const rr = p.redirectResponse as { status: number; headers: Record<string, unknown>; mimeType?: string };
      prev.status = rr.status;
      prev.responseHeaders = rr.headers;
      prev.mime = rr.mimeType;
      void this.requestEnded(s, id, p.timestamp as number);
    }
    if (!/^https?:/i.test(request.url)) return;
    const document = p.type === "Document" && p.frameId === s.targetId;
    // The page decides: a page on a recorded site has its requests recorded, wherever they go.
    const target = this.options.targetFor(document ? request.url : s.url);
    if (!target || this.options.ignore?.(request.url)) return;
    if (typeof p.wallTime === "number") this.browserTime(p.wallTime * 1000);
    if (document && p.loaderId && p.loaderId !== s.visitLoader) {
      if (s.pendingPage) this.flushPage(s);
      s.visit = newVisitId();
      s.visitLoader = p.loaderId as string;
    }
    s.requests.set(id, {
      id,
      url: request.url,
      method: (request.method || "GET").toUpperCase(),
      headers: request.headers ?? {},
      postData: request.postData,
      hasPostData: request.hasPostData,
      type: p.type as string | undefined,
      started: Number(p.timestamp) || 0,
      wall: typeof p.wallTime === "number" ? p.wallTime * 1000 : Date.now() + this.skew,
      target,
      page: document ? undefined : s.url,
      visit: s.visit,
      document,
      // Bodies only for addresses that are themselves recorded: not a third party's.
      bodies: !!this.options.targetFor(request.url),
    });
  }

  private async requestEnded(s: Session, id: string, timestamp: number | undefined, error?: string): Promise<void> {
    const r = s.requests.get(id);
    if (!r) return;
    s.requests.delete(id);
    let path = r.url;
    try {
      path = new URL(r.url).pathname;
    } catch {
      // the address as it is
    }
    const mime = r.mime ?? "";
    const failed = !!error || (r.status ?? 0) >= 400;
    const kind = r.document ? "page" : classify(r.method, mime, path);
    if (kind === "asset" && !failed) return;
    if (r.type === "Preflight" && !failed) return;
    if (/^\/favicon\.ico$/.test(path) && (r.status ?? 0) < 500 && !error) return;
    // Its own origin's addresses are kept as paths, like the proxy's; others whole.
    const url = maskUrl(sameOrigin(r.url, r.document ? r.url : (r.page ?? "")) ? pathOf(r.url) : r.url);
    const ms = timestamp && r.started ? Math.max(0, Math.round((timestamp - r.started) * 1000)) : undefined;
    const event: ActivityInput = {
      type: kind === "page" ? "page" : "request",
      text: `${r.method} ${url} → ${error ? `failed (${error})` : (r.status ?? "…")}`,
      level: failed ? "error" : undefined,
      url,
      method: r.method,
      status: r.status,
      ms,
      error,
      requestHeaders: maskHeaders(r.headers as Record<string, string>),
      responseHeaders: r.responseHeaders ? maskHeaders(r.responseHeaders as Record<string, string>) : undefined,
      page: r.page ? maskUrl(r.page) : undefined,
      visit: r.visit,
      at: new Date(r.wall).toISOString(),
      dir: r.target.dir,
      from: "dx-browser",
    };
    if (r.bodies) {
      const reqType = headerOf(r.headers, "content-type");
      let post = r.postData;
      if (post === undefined && r.hasPostData) {
        post = await this.options
          .send<{ postData: string }>("Network.getRequestPostData", { requestId: id }, s.id)
          .then((x) => x.postData)
          .catch(() => undefined);
      }
      if (post && (isTextType(reqType) || !reqType)) {
        if (post.length > KEEP_REQUEST) event.truncated = true;
        event.requestBody = maskBody(post.slice(0, KEEP_REQUEST), reqType || "text/plain");
      }
      const redirect = (r.status ?? 0) >= 300 && (r.status ?? 0) < 400;
      if (kind === "api" && !error && !redirect && isTextType(mime)) {
        const got = await this.options.send<{ body: string; base64Encoded: boolean }>("Network.getResponseBody", { requestId: id }, s.id).catch(() => undefined);
        if (got) {
          const body = got.base64Encoded ? Buffer.from(got.body, "base64").toString("utf8") : got.body;
          if (body.length > KEEP_RESPONSE) event.truncated = true;
          event.responseBody = maskBody(body.slice(0, KEEP_RESPONSE), mime);
        }
      }
    }
    if (event.type === "page") {
      const fromHeaders = deploymentFrom(event.responseHeaders);
      if (fromHeaders || error) {
        if (fromHeaders) event.deploy = fromHeaders;
        return this.emit(r.target, event);
      }
      // Wait for the page's own meta tags (version, commit, build): read once it has parsed.
      if (s.pendingPage) this.flushPage(s);
      const timer = setTimeout(() => this.flushPage(s), this.options.settleMs ?? 3000);
      timer.unref?.();
      s.pendingPage = { event: { ...event, service: r.target.service, site: r.target.site, env: r.target.env, project: r.target.project } as ActivityInput, timer };
      return;
    }
    this.emit(r.target, event);
  }

  private flushPage(s: Session, meta?: Record<string, string>): void {
    const pending = s.pendingPage;
    if (!pending) return;
    s.pendingPage = undefined;
    clearTimeout(pending.timer);
    const deploy = meta && Object.keys(meta).length ? deploymentFrom(pending.event.responseHeaders, meta) : undefined;
    this.options.onEvent(deploy ? { ...pending.event, deploy } : pending.event);
  }

  private async readMeta(s: Session): Promise<void> {
    if (!s.pendingPage) return;
    const r = await this.options
      .send<{ result?: { value?: Record<string, string> } }>("Runtime.evaluate", { expression: META_SCRIPT, returnByValue: true }, s.id)
      .catch(() => undefined);
    this.flushPage(s, r?.result?.value ?? undefined);
  }

  private console(s: Session, p: Record<string, unknown>): void {
    const target = this.options.targetFor(s.url);
    if (!target) return;
    const type = String(p.type);
    const level: ActivityEvent["level"] =
      type === "error" || type === "assert" ? "error" : type === "warning" ? "warn" : type === "info" ? "info" : type === "debug" ? "debug" : "log";
    if (!["log", "info", "warning", "error", "debug", "assert", "dir", "table", "trace", "dirxml"].includes(type)) return;
    const args = (p.args as RemoteObject[] | undefined) ?? [];
    const text = args.map(remoteText).join(" ");
    if ((level === "log" || level === "info" || level === "debug") && CHATTER.test(text)) return;
    const frames = ((p.stackTrace as { callFrames?: CallFrame[] } | undefined)?.callFrames ?? []).filter((f) => f.url);
    const at = this.browserTime(p.timestamp);
    this.emit(target, {
      type: "console",
      level,
      text: maskText(clip(type === "assert" ? `Assertion failed: ${text}` : text, MAX_TEXT)),
      source: frames[0] ? frameSource(frames[0], s.url) : undefined,
      stack: (level === "error" || level === "warn") && frames.length ? maskText(clip(stackText(frames), MAX_TEXT)) : undefined,
      page: maskUrl(s.url),
      visit: s.visit,
      at,
    });
  }

  private exception(s: Session, p: Record<string, unknown>): void {
    const target = this.options.targetFor(s.url);
    if (!target) return;
    const d = p.exceptionDetails as { text?: string; url?: string; lineNumber?: number; columnNumber?: number; stackTrace?: { callFrames: CallFrame[] }; exception?: RemoteObject };
    const description = d.exception?.description ?? (d.exception ? remoteText(d.exception) : "");
    const first = description.split("\n")[0] || d.text || "Uncaught error";
    const rejection = /in promise/i.test(d.text ?? "");
    const frames = (d.stackTrace?.callFrames ?? []).filter((f) => f.url);
    const stack = description.includes("\n    at ") ? description : frames.length ? `${first}\n${stackText(frames)}` : undefined;
    this.emit(target, {
      type: "error",
      level: "error",
      text: maskText(clip(rejection ? `Unhandled promise rejection: ${first}` : first, MAX_TEXT)),
      source: frames[0] ? frameSource(frames[0], s.url) : d.url ? `${shortSource(d.url, s.url)}:${(d.lineNumber ?? 0) + 1}:${(d.columnNumber ?? 0) + 1}` : undefined,
      stack: stack ? maskText(clip(stack, MAX_TEXT)) : undefined,
      page: maskUrl(s.url),
      visit: s.visit,
      at: this.browserTime(p.timestamp),
    });
  }

  /** A click or submit from the listener: known fields only, bounded, masked. */
  private binding(s: Session, payload: string): void {
    const target = this.options.targetFor(s.url);
    if (!target) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(payload.slice(0, 4000)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (data.type !== "action" || typeof data.text !== "string" || !data.text) return;
    const at = typeof data.at === "number" && Math.abs(data.at - Date.now()) < 3_600_000 ? new Date(data.at).toISOString() : this.browserNow();
    this.emit(target, {
      type: "action",
      text: maskText(clip(data.text, 400)),
      target: typeof data.target === "string" && data.target ? data.target.slice(0, 300) : undefined,
      page: maskUrl(s.url),
      visit: s.visit,
      at,
    });
  }
}

function headerOf(headers: Record<string, unknown> | undefined, name: string): string {
  for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === name) return String(v);
  return "";
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function pathOf(url: string): string {
  const u = new URL(url);
  return u.pathname + u.search;
}

/** "/cart" for an address on the page's own origin, the whole address for others. */
function short(href: string, page: string): string {
  try {
    const u = new URL(href);
    return sameOrigin(href, page) ? maskUrl(u.pathname + u.search + u.hash) : maskUrl(href);
  } catch {
    return href;
  }
}

function shortSource(url: string, page: string): string {
  try {
    return sameOrigin(url, page) ? new URL(url).pathname : url;
  } catch {
    return url;
  }
}

function frameSource(f: CallFrame, page: string): string {
  return `${shortSource(f.url, page)}:${f.lineNumber + 1}:${f.columnNumber + 1}`;
}

function stackText(frames: CallFrame[]): string {
  return frames
    .slice(0, 30)
    .map((f) => `    at ${f.functionName ? `${f.functionName} (` : ""}${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1}${f.functionName ? ")" : ""}`)
    .join("\n");
}

/** A console argument as text, like the recorder shows it. */
function remoteText(o: RemoteObject): string {
  if (o.type === "string") return String(o.value);
  if (o.value !== undefined) return typeof o.value === "object" ? JSON.stringify(o.value) : String(o.value);
  if (o.unserializableValue) return o.unserializableValue;
  if (o.type === "object" && o.preview?.properties && o.subtype !== "error" && o.subtype !== "node") {
    const arr = o.subtype === "array";
    const parts = o.preview.properties.map((x) => (arr ? x.value : `${JSON.stringify(x.name)}:${/^-?\d/.test(x.value ?? "") || x.value === "true" || x.value === "false" || x.value === "null" ? x.value : JSON.stringify(x.value ?? "")}`));
    return arr ? `[${parts.join(",")}]` : `{${parts.join(",")}}`;
  }
  return o.description ?? o.type;
}

// ------------------------------------------------------------------ launching

const START_TIMEOUT_MS = 60_000;

/** Opens the dx browser. One at a time per profile: a second start with the same profile fails with a message. */
export async function launchDxBrowser(options: DxBrowserOptions): Promise<DxBrowser> {
  const found = findBrowser();
  if (!found) throw new Error(`No Chrome, Edge, Chromium or Brave was found for the dx browser. Install one: ${browserInstallFix()}`);
  const profileDir = options.profileDir ?? dxPath("browser-profile");
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const startUrl = options.url ? checkOpenUrl(options.url) : undefined;
  const args = [
    "--remote-debugging-pipe",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(options.headless ? ["--headless=new", "--mute-audio", "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync"] : []),
    ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
    // The first address is loaded once dx is attached, so its first page load is recorded too.
    "about:blank",
  ];
  const proc: ChildProcess = spawn(found.path, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], windowsHide: !!options.headless });
  let said = "";
  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (c: string) => {
    said = (said + c).slice(-2000);
  });
  const conn = new PipeConnection(proc.stdio[3] as Writable, proc.stdio[4] as Readable);
  const recorder = new CdpRecorder({ targetFor: options.targetFor, onEvent: options.onEvent, ignore: options.ignore, send: conn.send });
  conn.onEvent = (method, params, sessionId) => recorder.handle(method, params, sessionId);

  let markClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => (markClosed = resolve));
  let exited = false;
  proc.on("exit", () => {
    exited = true;
    markClosed();
  });
  conn.onClose = () => {
    // The pipe closed: the browser is going. Make sure it's gone.
    setTimeout(() => {
      if (!exited) proc.kill();
    }, 3000).unref();
  };

  // Ready when it answers; a browser that quits first was handed the address by one already open with this profile.
  const ready = conn.send("Browser.getVersion", {}, undefined);
  const quit = new Promise<never>((_, reject) => {
    proc.once("error", (e) => reject(new Error(`Couldn't start the browser: ${e.message}`)));
    proc.once("exit", (code) =>
      reject(
        new Error(
          code === 0 || code === null
            ? "The dx browser is already open (a window of it is still running, from this or another dashboard). Use that window, or close it and try again."
            : `The browser quit straight away (code ${code}).${said.trim() ? ` It said: ${said.trim().slice(-300)}` : ""}`,
        ),
      ),
    );
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The browser didn't start within ${START_TIMEOUT_MS / 1000}s.`)), START_TIMEOUT_MS);
  });
  // Only the first to settle counts; the others mustn't be left rejecting with nobody listening.
  for (const p of [ready, quit, timeout]) p.catch(() => undefined);
  try {
    await Promise.race([ready, quit, timeout]);
    await conn.send("Target.setDiscoverTargets", { discover: true });
    await conn.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  } catch (err) {
    if (!exited) proc.kill();
    throw err;
  } finally {
    clearTimeout(timer);
  }
  proc.stderr?.resume();

  const open = async (url: string) => {
    const href = checkOpenUrl(url);
    let session = recorder.blankPage();
    if (!session) {
      // A new tab, blank until dx is listening in it, so its first page load is recorded too.
      const { targetId } = await conn.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
      session = await recorder.whenReady(targetId);
      if (!session) {
        await conn.send("Target.closeTarget", { targetId }).catch(() => undefined);
        throw new Error("The dx browser didn't open a new tab.");
      }
    }
    await conn.send("Page.navigate", { url: href }, session);
    await conn.send("Page.bringToFront", {}, session).catch(() => undefined);
  };
  if (startUrl) {
    // The window's first tab is attached a moment after the browser answers.
    for (let i = 0; i < 40 && !recorder.blankPage(false); i++) await new Promise((r) => setTimeout(r, 50));
    await open(startUrl).catch(() => undefined);
  }

  return {
    browser: found.name,
    pid: proc.pid,
    profileDir,
    startedAt: new Date().toISOString(),
    pages: () => recorder.pages(),
    open,
    async close() {
      if (exited) return;
      await conn.send("Browser.close", {}).catch(() => undefined);
      const gone = await Promise.race([closed.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 5000).unref())]);
      if (!gone && !exited) proc.kill();
    },
    closed,
  };
}
