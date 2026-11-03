import { devErrors, devLogs, listDevServers, type DevLine } from "./dev.js";
import type { DevError } from "@dx/core";

/**
 * Requests a page or API route on a local dev server, the way an AI agent checks its own change:
 * what came back, and what the server printed while answering. Only loopback hosts are allowed,
 * so this can't be used to reach the internet or the local network.
 */
export interface CheckOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface CheckResult {
  url: string;
  status?: number;
  statusText?: string;
  ok: boolean;
  ms: number;
  contentType?: string;
  bytes?: number;
  /** Where a redirect points; redirects aren't followed. */
  location?: string;
  title?: string;
  /** The start of the body: text without tags for HTML, as-is otherwise. */
  snippet?: string;
  /** Why the request itself failed: refused, timed out, … */
  error?: string;
  /** The dev server serving this port, if dx runs it. */
  project?: string;
  /** What that server printed while handling the request. */
  serverOutput: DevLine[];
  /** Errors that server logged while handling the request. */
  serverErrors: DevError[];
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|[\w.-]+\.localhost)$/i;
const MAX_BODY = 2 * 1024 * 1024;

export function isLoopbackUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") && LOOPBACK.test(u.hostname);
  } catch {
    return false;
  }
}

export async function checkUrl(options: CheckOptions): Promise<CheckResult> {
  if (!isLoopbackUrl(options.url)) throw new Error("Only http://localhost and http://127.0.0.1 addresses can be checked.");
  const url = new URL(options.url);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const server = listDevServers().find((s) => s.url && Number(new URL(s.url).port) === port && s.status !== "stopped" && s.status !== "failed");
  const before = server?.lastLine ?? 0;

  const started = Date.now();
  const result: CheckResult = { url: url.href, ok: false, ms: 0, project: server?.project, serverOutput: [], serverErrors: [] };
  try {
    const res = await fetch(url, {
      method: (options.method ?? "GET").toUpperCase(),
      headers: options.headers,
      body: options.body,
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    const buf = await readCapped(res);
    result.ms = Date.now() - started;
    result.status = res.status;
    result.statusText = res.statusText;
    result.ok = res.ok;
    result.contentType = res.headers.get("content-type") ?? undefined;
    result.bytes = buf.length;
    result.location = res.headers.get("location") ?? undefined;
    const body = buf.toString("utf8");
    if (/html/i.test(result.contentType ?? "") || /^\s*<!doctype html|^\s*<html/i.test(body)) {
      result.title = /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1]?.trim() || undefined;
      result.snippet = htmlText(body).slice(0, 1500);
    } else {
      result.snippet = body.slice(0, 1500);
    }
  } catch (err) {
    result.ms = Date.now() - started;
    const e = err as Error & { cause?: { code?: string } };
    result.error =
      e.name === "TimeoutError"
        ? `No answer within ${options.timeoutMs ?? 15_000} ms.`
        : e.cause?.code === "ECONNREFUSED"
          ? `Nothing is listening on port ${port}. Is the dev server running?`
          : e.message;
  }

  if (server) {
    // Give the server a moment to finish logging what it did for this request.
    await new Promise((r) => setTimeout(r, 400));
    result.serverOutput = devLogs(server.dir, before).lines.slice(-60);
    result.serverErrors = devErrors(server.dir, { after: before })[0]?.errors ?? [];
  }
  return result;
}

async function readCapped(res: Response): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    chunks.push(Buffer.from(chunk));
    if (size > MAX_BODY) break;
  }
  return Buffer.concat(chunks);
}

function htmlText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|title|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
