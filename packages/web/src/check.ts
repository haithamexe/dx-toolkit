import { devErrors, devLogs, localRoutes, serverForPort, type DevLine } from "./dev.js";
import { checkPage, isLoopbackUrl, type DevError, type PageCheck } from "@dx/core";

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
  /** Also load it in a headless browser: console errors, exceptions, failed requests. */
  browser?: boolean;
  /** With browser: save a screenshot. */
  screenshot?: boolean;
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
  /** What the browser saw, with `browser: true`. */
  page?: PageCheck;
}

export { isLoopbackUrl };

const MAX_BODY = 2 * 1024 * 1024;

export async function checkUrl(options: CheckOptions): Promise<CheckResult> {
  if (!isLoopbackUrl(options.url)) throw new Error("Only http://localhost and http://127.0.0.1 addresses can be checked.");
  let url = new URL(options.url);
  // shop.localhost goes straight to the dev server behind it: not every system resolves *.localhost.
  const route = url.hostname.endsWith(".localhost") ? localRoutes().get(url.hostname.toLowerCase()) : undefined;
  if (url.hostname.endsWith(".localhost") && !route) throw new Error(`Nothing runs at ${url.hostname}. dev_servers lists what does.`);
  if (route) url = new URL(url.pathname + url.search, route.url);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const server = serverForPort(port);
  const before = server ? Math.max(0, ...devLogs(server.dir).lines.map((l) => l.n)) : 0;

  // GET only: a browser loads pages, it doesn't send bodies.
  if (options.browser) {
    if ((options.method ?? "GET").toUpperCase() !== "GET") throw new Error("A page is loaded in the browser with GET; leave out method and body.");
    const result: CheckResult = { url: options.url, ok: false, ms: 0, project: server ? (server.service ? `${server.project}/${server.service}` : server.project) : undefined, serverOutput: [], serverErrors: [] };
    const page = await checkPage({ url: url.href, screenshot: options.screenshot, timeoutMs: options.timeoutMs ?? 30_000 });
    Object.assign(result, { page, ok: page.ok, ms: page.ms, status: page.status, title: page.title, snippet: page.text, error: page.error });
    await collectServer(result, server, before);
    return result;
  }

  const started = Date.now();
  const result: CheckResult = { url: options.url, ok: false, ms: 0, project: server ? (server.service ? `${server.project}/${server.service}` : server.project) : undefined, serverOutput: [], serverErrors: [] };
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

  await collectServer(result, server, before);
  return result;
}

async function collectServer(result: CheckResult, server: ReturnType<typeof serverForPort>, before: number): Promise<void> {
  if (!server) return;
  // Give the server a moment to finish logging what it did for this request.
  await new Promise((r) => setTimeout(r, 400));
  result.serverOutput = devLogs(server.dir, before, server.service).lines.slice(-60);
  result.serverErrors = devErrors(server.dir, { after: before, service: server.service })[0]?.errors ?? [];
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
