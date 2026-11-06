import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import { applyAnswerTool, breakJson, editBody, editHeaders, loadRules, MASK, maskBody, maskHeaders, matchRules, planRules, rulesFile, type Headers, type RulePlan, type RuleSet } from "@dx/core";
import type { LocalRoute } from "./dev.js";
import { answered, callKey, holdForNext } from "./chaos.js";
import { hold } from "./intercept.js";
import { cacheAnswer } from "./mocks.js";
import { requestActivity } from "./recorder.js";
import { decode, recordExchange } from "./traffic.js";

/**
 * The Requests page's tools in the proxy: rules that change requests and answers on their way
 * (match and replace, delays, failures), Intercept, and the Repeater's sends. Everything goes only
 * to a dev server dx runs on this computer, like the rest of the proxy.
 */

// ------------------------------------------------------------------ rules

const ruleCache = new Map<string, { stamp: string; set: RuleSet }>();
/** How often each rule matched since the dashboard started, by rule id. */
export const ruleHits = new Map<string, number>();

function activeRules(dir: string): RuleSet | undefined {
  const file = rulesFile(dir);
  let stamp: string;
  try {
    const st = fs.statSync(file);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    ruleCache.delete(file);
    return undefined;
  }
  let c = ruleCache.get(file);
  if (!c || c.stamp !== stamp) {
    c = { stamp, set: loadRules(dir) };
    ruleCache.set(file, c);
  }
  return c.set.rules.some((r) => r.on) ? c.set : undefined;
}

export function forgetRules(): void {
  ruleCache.clear();
}

/** What the project's rules do to this request; undefined when none applies. Page loads and dx's own paths are left alone. */
export function rulePlanFor(req: http.IncomingMessage, route: LocalRoute): RulePlan | undefined {
  const url = req.url ?? "/";
  const method = (req.method ?? "GET").toUpperCase();
  if (url.startsWith("/__dx/") || req.headers.upgrade) return undefined;
  if (method === "GET" && /text\/html/i.test(String(req.headers.accept ?? ""))) return undefined;
  const set = activeRules(route.dir);
  if (!set) return undefined;
  const plan = planRules(matchRules(set, { method, url, service: route.service }));
  for (const r of plan?.rules ?? []) ruleHits.set(r.id, (ruleHits.get(r.id) ?? 0) + 1);
  return plan;
}

const BUFFER_MAX = 8 * 1024 * 1024;

function readAll(stream: NodeJS.ReadableStream, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) return reject(new Error("too large"));
      chunks.push(c);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isTextType = (t: string) => /json|text\/|xml|graphql|x-www-form-urlencoded|javascript/i.test(t);

function flat(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : String(v);
  return out;
}

export interface RuleRelay {
  port: number;
  headers: http.OutgoingHttpHeaders;
  route: LocalRoute;
  label: string;
  publicOrigin: string;
  unreachable(code: string): void;
}

/**
 * Passes one request on with the rules' plan: the request is read whole, held, changed, failed or
 * slowed as the rules say, and the answer is read whole when a rule changes its body or holds it.
 * Logged like any other exchange, with the rules that changed it.
 */
export async function relayWithRules(req: http.IncomingMessage, res: http.ServerResponse, o: RuleRelay, plan: RulePlan): Promise<void> {
  const { route } = o;
  const names = plan.rules.map((r) => r.name);
  const rec = recordExchange(req, route, o.label);
  const chaos = plan.chaos;
  rec.entry.rules = [...names, ...(plan.answerTools ?? []).map((t) => `tool: ${t.name}`), ...(chaos ? [chaos.label] : [])];
  const ua = String(req.headers["user-agent"] ?? "");
  let finished = false;
  const finish = (error?: string) => {
    if (finished) return;
    finished = true;
    if (chaos) answered(callKey(req.method ?? "GET", req.url ?? "/"));
    rec.end(error);
    requestActivity(rec.entry, route, ua);
    cacheAnswer(route, rec.entry, rec.fullResponse());
  };
  let closed = false;
  res.on("close", () => {
    closed = true;
    if (!res.writableFinished) finish("the page closed the connection");
  });

  let body: Buffer;
  try {
    body = await readAll(req, BUFFER_MAX);
  } catch {
    res.writeHead(413, { "content-type": "text/plain" });
    res.end("Too large for a dx rule (8 MB).");
    return finish("too large for a dx rule");
  }

  if (plan.delayMs) await sleep(plan.delayMs);
  if (closed) return;

  // Chaos answers that never reach the server: a session that expired, a rate limit, a 500.
  if (chaos && (chaos.fault === "logout" || chaos.fault === "ratelimit" || chaos.fault === "flaky")) {
    rec.request(body);
    const [status, message, extra] =
      chaos.fault === "logout"
        ? [401, "Unauthorized: your session has expired (dx chaos mode)", { "www-authenticate": 'Bearer error="invalid_token"' }]
        : chaos.fault === "ratelimit"
          ? [429, "Too Many Requests (dx chaos mode)", { "retry-after": "5" }]
          : [500, "Internal Server Error (dx chaos mode)", {}];
    const b = Buffer.from(JSON.stringify({ error: message }));
    const h = { "content-type": "application/json", "content-length": String(b.length), "x-dx-chaos": chaos.fault, ...extra };
    rec.headers(status, h);
    rec.response(b);
    res.writeHead(status, h);
    res.end(b);
    return finish();
  }
  if (chaos?.fault === "timeout") plan.fail ??= "timeout";

  if (plan.fail) {
    rec.request(body);
    if (plan.fail === "500") {
      const b = Buffer.from(JSON.stringify({ error: `Internal Server Error (failed by the dx rule ${names.join(", ")})` }));
      const h = { "content-type": "application/json", "content-length": String(b.length), "x-dx-rule": "fail" };
      rec.headers(500, h);
      rec.response(b);
      res.writeHead(500, h);
      res.end(b);
      return finish();
    }
    if (plan.fail === "drop") {
      finish("connection dropped by a dx rule");
      return void req.socket.destroy();
    }
    // timeout: no answer, until the page gives up (or two minutes pass).
    const t = setTimeout(() => {
      finish("timed out (a dx rule)");
      req.socket.destroy();
    }, 120_000);
    res.on("close", () => clearTimeout(t));
    return;
  }

  let method = (req.method ?? "GET").toUpperCase();
  let url = req.url ?? "/";
  let headers: Headers = { ...(o.headers as Headers) };
  const reqType = String(req.headers["content-type"] ?? "");
  let out = body;
  for (const e of plan.request) {
    headers = editHeaders(headers, e);
    if (e.body !== undefined || e.json?.length) out = Buffer.from(editBody(out.toString("utf8"), e).body, "utf8");
  }

  if (plan.interceptRequest) {
    const text = !out.length || isTextType(reqType);
    const d = await hold({ dir: route.dir, project: route.project, service: route.service, phase: "request", method, url, headers: flat(headers), body: text ? out.toString("utf8") : "", binary: !text || undefined, rule: names.join(", ") });
    if (closed) return;
    if (d.action === "drop") {
      finish("dropped in Intercept");
      return void req.socket.destroy();
    }
    if (!d.timedOut && (d.method || d.url || d.headers || d.body !== undefined)) {
      method = d.method ?? method;
      url = d.url ?? url;
      if (d.headers) headers = { ...d.headers };
      if (d.body !== undefined && text) out = Buffer.from(d.body, "utf8");
      rec.entry.rules!.push("edited by hand");
    }
  }

  // Wherever the edits went, the request goes to this dev server, addressed the way dx addresses it.
  headers.host = String(o.headers.host);
  delete headers["transfer-encoding"];
  delete headers["content-length"];
  if (out.length || !["GET", "HEAD", "DELETE", "OPTIONS"].includes(method)) headers["content-length"] = String(out.length);
  if (plan.needsResponseBody) delete headers["accept-encoding"];
  rec.entry.method = method;
  rec.entry.path = url;
  rec.entry.requestHeaders = maskHeaders(headers as http.IncomingHttpHeaders);
  if (out.length) rec.request(out);

  const upstream = http.request({ host: "localhost", port: o.port, method, path: url, headers: headers as http.OutgoingHttpHeaders }, async (up) => {
    let status = up.statusCode ?? 502;
    let resHeaders: Headers = { ...up.headers };
    const location = resHeaders.location;
    if (typeof location === "string") resHeaders.location = location.replace(new RegExp(`^https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):${o.port}(?=/|$)`), o.publicOrigin);
    for (const e of plan.response) {
      resHeaders = editHeaders(resHeaders, e);
      if (e.status) status = e.status;
    }
    if (!plan.needsResponseBody) {
      rec.headers(status, resHeaders as http.IncomingHttpHeaders);
      res.writeHead(status, resHeaders as http.OutgoingHttpHeaders);
      up.on("data", (c: Buffer) => rec.response(c));
      up.on("end", () => finish());
      up.on("aborted", () => finish("the dev server closed the connection"));
      return void up.pipe(res);
    }
    let raw: Buffer;
    try {
      raw = await readAll(up, BUFFER_MAX);
    } catch {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("The answer was too large for a dx rule (8 MB).");
      return finish("answer too large for a dx rule");
    }
    const enc = String(up.headers["content-encoding"] ?? "");
    const text = enc && !/^identity$/i.test(enc) ? decode(raw, enc) : raw.toString("utf8");
    let outRes = raw;
    if (text !== undefined) {
      delete resHeaders["content-encoding"];
      let t = text;
      for (const e of plan.response) if (e.body !== undefined || e.json?.length) t = editBody(t, e).body;
      // Custom tools of kind answer: fields worked out or taken out of a JSON answer. Not JSON, nothing changes.
      if (plan.answerTools?.length) {
        try {
          let data = JSON.parse(t) as unknown;
          for (const at of plan.answerTools) data = applyAnswerTool(data, at as Parameters<typeof applyAnswerTool>[1]);
          t = JSON.stringify(data);
          if (resHeaders["content-type"] === undefined) resHeaders["content-type"] = "application/json";
        } catch {
          rec.entry.rules = rec.entry.rules!.filter((r) => !r.startsWith("tool: "));
        }
      }
      if (chaos?.fault === "baddata" && status < 300) {
        const broken = breakJson(t, 0, chaos.salt);
        if (broken) {
          t = broken.text;
          rec.entry.rules = rec.entry.rules!.map((r) => (r === chaos.label ? `${r}: ${broken.note}` : r));
        } else rec.entry.rules = rec.entry.rules!.filter((r) => r !== chaos.label);
      }
      outRes = Buffer.from(t, "utf8");
    }
    if (chaos?.fault === "reorder") {
      await holdForNext(callKey(method, url));
      if (closed) return;
    }
    if (chaos?.fault === "drop") {
      // Headers and half the answer, then the connection closes: what a page sees when the network goes.
      delete resHeaders["transfer-encoding"];
      resHeaders["content-length"] = String(outRes.length);
      rec.headers(status, resHeaders as http.IncomingHttpHeaders);
      const half = outRes.subarray(0, Math.floor(outRes.length / 2));
      rec.response(half);
      res.writeHead(status, resHeaders as http.OutgoingHttpHeaders);
      res.write(half);
      finish("connection dropped halfway (dx chaos mode)");
      return void setTimeout(() => res.destroy(), 50);
    }
    if (plan.interceptResponse) {
      const isText = text !== undefined && (!outRes.length || isTextType(String(resHeaders["content-type"] ?? "")));
      const d = await hold({ dir: route.dir, project: route.project, service: route.service, phase: "response", method, url, status, headers: flat(resHeaders), body: isText ? outRes.toString("utf8") : "", binary: !isText || undefined, rule: names.join(", ") });
      if (closed) return;
      if (d.action === "drop") {
        finish("dropped in Intercept");
        return void req.socket.destroy();
      }
      if (!d.timedOut && (d.status || d.headers || d.body !== undefined)) {
        if (d.status) status = d.status;
        if (d.headers) resHeaders = { ...d.headers };
        if (d.body !== undefined && isText) outRes = Buffer.from(d.body, "utf8");
        if (!rec.entry.rules!.includes("edited by hand")) rec.entry.rules!.push("edited by hand");
      }
    }
    delete resHeaders["transfer-encoding"];
    resHeaders["content-length"] = String(outRes.length);
    rec.headers(status, resHeaders as http.IncomingHttpHeaders);
    rec.response(outRes);
    res.writeHead(status, resHeaders as http.OutgoingHttpHeaders);
    res.end(outRes);
    finish();
  });
  upstream.on("error", (err) => {
    const code = (err as NodeJS.ErrnoException).code ?? err.message;
    finish(code);
    if (res.headersSent) return void res.destroy();
    o.unreachable(code);
  });
  upstream.end(out);
}

// ------------------------------------------------------------------ the Repeater

export interface SendInput {
  route: LocalRoute;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

export interface SendResult {
  id: string;
  at: string;
  method: string;
  path: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  status?: number;
  ms: number;
  responseHeaders: Record<string, string>;
  responseBody?: string;
  bytes: number;
  truncated?: boolean;
  error?: string;
  /** A header or body still held a value dx had hidden (•••): the real one wasn't sent. */
  masked?: boolean;
}

const KEEP = 1024 * 1024;
const history = new Map<string, SendResult[]>();
const hkey = (dir: string) => (process.platform === "linux" ? dir : dir.toLowerCase());

export function sendHistory(dir: string): SendResult[] {
  return history.get(hkey(dir)) ?? [];
}

/**
 * Sends one request to the project's dev server (only there: the address is the route's own port
 * on this computer) and returns the whole answer. Logged in the network log and the activity
 * history like any request, without the proxy's rules or mocks: what you send is what it gets.
 */
export function sendRequest(input: SendInput): Promise<SendResult> {
  const port = Number(new URL(input.route.url).port || 80);
  const body = input.body !== undefined ? Buffer.from(input.body, "utf8") : Buffer.alloc(0);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = v;
  for (const k of ["host", "content-length", "transfer-encoding", "connection", "upgrade"]) delete headers[k];
  headers.host = `localhost:${port}`;
  if (body.length || !["GET", "HEAD", "DELETE", "OPTIONS"].includes(input.method)) headers["content-length"] = String(body.length);
  const masked = Object.values(headers).some((v) => v.includes(MASK)) || (input.body ?? "").includes(MASK);
  const fake = { method: input.method, url: input.path, headers } as unknown as http.IncomingMessage;
  const rec = recordExchange(fake, input.route, "Repeater");
  if (body.length) rec.request(body);
  const started = Date.now();
  const result: SendResult = {
    id: crypto.randomBytes(5).toString("hex"),
    at: new Date(started).toISOString(),
    method: input.method,
    path: input.path,
    requestHeaders: maskHeaders(headers as http.IncomingHttpHeaders),
    requestBody: input.body,
    ms: 0,
    responseHeaders: {},
    bytes: 0,
    masked: masked || undefined,
  };
  return new Promise((resolve) => {
    const done = (error?: string) => {
      result.ms = Date.now() - started;
      if (error) result.error = error;
      rec.end(error);
      requestActivity(rec.entry, input.route, "dx-repeater");
      const list = history.get(hkey(input.route.dir)) ?? [];
      // The history keeps what the network log keeps: credentials masked. Only the answer shown now is exact.
      list.unshift({
        ...result,
        responseBody: result.responseBody === undefined ? undefined : maskBody(result.responseBody.slice(0, 64 * 1024), result.responseHeaders["content-type"] ?? ""),
        requestBody: result.requestBody === undefined ? undefined : maskBody(result.requestBody.slice(0, 16 * 1024), headers["content-type"] ?? ""),
      });
      history.set(hkey(input.route.dir), list.slice(0, 50));
      resolve(result);
    };
    const req = http.request({ host: "localhost", port, method: input.method, path: input.path, headers, timeout: 60_000 }, (up) => {
      result.status = up.statusCode;
      result.responseHeaders = flat(up.headers);
      rec.headers(up.statusCode ?? 0, up.headers);
      const chunks: Buffer[] = [];
      let size = 0;
      up.on("data", (c: Buffer) => {
        rec.response(c);
        result.bytes += c.length;
        if (size < KEEP) {
          chunks.push(c);
          size += c.length;
        } else result.truncated = true;
      });
      up.on("end", () => {
        const raw = Buffer.concat(chunks);
        const text = decode(raw, String(up.headers["content-encoding"] ?? ""));
        result.responseBody = text ?? `(${raw.length} bytes of binary data)`;
        done();
      });
      up.on("aborted", () => done("the dev server closed the connection"));
    });
    req.on("timeout", () => req.destroy(new Error("no answer within 60 s")));
    req.on("error", (err) => done((err as NodeJS.ErrnoException).code ?? err.message));
    req.end(body);
  });
}
