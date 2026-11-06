import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { localRoutes, type LocalRoute } from "./dev.js";
import { answerFromMocks, cacheAnswer, handleMockServer, mockServerByHost } from "./mocks.js";
import { relayWithRules, rulePlanFor } from "./apilab.js";
import { answered, callKey, chaosConfig, chaosFor, withChaos } from "./chaos.js";
import { answerToolsFor, withAnswerTools } from "./toolsapi.js";
import { handleRecorderRequest, injector, requestActivity, shouldInject } from "./recorder.js";
import { recordExchange } from "./traffic.js";

/**
 * Local domains: shop.localhost goes to that project's front end, api.shop.localhost to its API,
 * dx.localhost to the dashboard. Browsers send every *.localhost name to this computer by
 * themselves, so nothing needs setting up. The proxy listens on this computer only and forwards
 * only to dev servers dx is running, so it opens nothing that localhost:5173 doesn't already.
 *
 * The Host header is rewritten to localhost:<port> on the way in (dev servers that check it see
 * what they expect) and Location headers back on the way out; WebSocket upgrades (live reload)
 * are passed through.
 */
export interface LocalDomains {
  port: number;
  /** Where https:// is served, when local HTTPS is on. */
  httpsPort?: number;
  close(): Promise<void>;
}

/** Port 80 gives addresses without a number; 1355 is the fallback when 80 is taken or not allowed. */
export const DOMAIN_PORTS = [80, 1355];
/** The same for https: 443, else 1356. */
export const HTTPS_PORTS = [443, 1356];

export interface TlsOptions {
  cert: Buffer | string;
  key: Buffer | string;
  ports?: number[];
  /** Called for a name the certificate doesn't cover yet; returns a new certificate that does. */
  refresh?: (host: string) => Promise<{ cert: Buffer | string; key: Buffer | string } | undefined>;
  covers?: (host: string) => boolean;
}

export async function startLocalDomains(options: { dashboardPort: number; ports?: number[]; tls?: TlsOptions }): Promise<LocalDomains | undefined> {
  const server = http.createServer((req, res) => forward(req, res));
  server.on("upgrade", (req, socket, head) => upgrade(req, socket as net.Socket, head));
  server.on("clientError", (_err, socket) => socket.destroy());

  let port: number | undefined;
  for (const wanted of options.ports ?? DOMAIN_PORTS) {
    port = await listen(server, wanted, "127.0.0.1");
    if (port !== undefined) break;
  }
  if (port === undefined) return undefined;
  // Some systems resolve *.localhost to ::1 first; listen there too when we can.
  const v6 = http.createServer((req, res) => forward(req, res));
  v6.on("upgrade", (req, socket, head) => upgrade(req, socket as net.Socket, head));
  v6.on("clientError", (_err, socket) => socket.destroy());
  const v6port = await listen(v6, port, "::1");
  const proxyPort = port;

  // https://, with the same routes. The certificate grows when a new project's name is asked for.
  const secureServers: net.Server[] = [];
  let httpsPort: number | undefined;
  if (options.tls) {
    const tlsOpts = options.tls;
    let context = tls.createSecureContext({ cert: tlsOpts.cert, key: tlsOpts.key });
    let refreshing: Promise<void> | undefined;
    const sni = (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => {
      const host = servername.toLowerCase();
      const known = host === "dx.localhost" || localRoutes().has(host);
      if (!known || !tlsOpts.refresh || tlsOpts.covers?.(host) !== false) return cb(null, context);
      refreshing ??= tlsOpts
        .refresh(host)
        .then((next) => {
          if (next) context = tls.createSecureContext({ cert: next.cert, key: next.key });
        })
        .catch(() => undefined)
        .finally(() => (refreshing = undefined));
      void refreshing.then(() => cb(null, context));
    };
    const make = () => {
      const s = https.createServer({ cert: tlsOpts.cert, key: tlsOpts.key, SNICallback: sni }, (req, res) => forward(req, res));
      s.on("upgrade", (req, socket, head) => upgrade(req, socket as net.Socket, head));
      s.on("tlsClientError", (_err, socket) => socket.destroy());
      return s;
    };
    for (const wanted of tlsOpts.ports ?? HTTPS_PORTS) {
      const s = make();
      httpsPort = await listen(s, wanted, "127.0.0.1");
      if (httpsPort !== undefined) {
        secureServers.push(s);
        break;
      }
    }
    if (httpsPort !== undefined) {
      const s6 = make();
      if ((await listen(s6, httpsPort, "::1")) !== undefined) secureServers.push(s6);
    }
  }

  const isSecure = (req: http.IncomingMessage) => (req.socket as tls.TLSSocket).encrypted === true;

  function target(req: http.IncomingMessage): { port: number; host: string } | undefined {
    const host = hostname(req.headers.host);
    if (host === "dx.localhost") return { port: options.dashboardPort, host };
    const route = localRoutes().get(host);
    if (!route) return undefined;
    const u = new URL(route.url);
    return { port: Number(u.port || 80), host };
  }

  function publicOrigin(host: string, secure = false): string {
    if (secure && httpsPort !== undefined) return `https://${host}${httpsPort === 443 ? "" : `:${httpsPort}`}`;
    return `http://${host}${proxyPort === 80 ? "" : `:${proxyPort}`}`;
  }

  function headersFor(req: http.IncomingMessage, t: { port: number; host: string }): http.OutgoingHttpHeaders {
    const secure = isSecure(req);
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: `localhost:${t.port}`, "x-forwarded-host": req.headers.host, "x-forwarded-proto": secure ? "https" : "http" };
    // The dashboard checks Origin; its own page through dx.localhost is the dashboard.
    if (t.host === "dx.localhost" && req.headers.origin === publicOrigin(t.host, secure)) headers.origin = `http://localhost:${t.port}`;
    return headers;
  }

  function forward(req: http.IncomingMessage, res: http.ServerResponse): void {
    // <project>.mock.localhost: that project's mock server, answered here from its mocks.
    const mockServer = mockServerByHost(hostname(req.headers.host));
    if (mockServer) return handleMockServer(req, res, mockServer);
    const t = target(req);
    if (!t) return notFound(req, res);
    // Every exchange with a dev server is logged (network_log); the dashboard's own aren't.
    const route = t.host === "dx.localhost" ? undefined : localRoutes().get(t.host);
    // The activity recorder's script and the events it sends are answered here, never forwarded.
    if (route && (req.url ?? "").startsWith("/__dx/") && handleRecorderRequest(req, res, route, `${isSecure(req) ? "https" : "http"}://${req.headers.host}`)) return;
    relay(req, res, {
      port: t.port,
      headers: headersFor(req, t),
      route,
      label: t.host,
      publicOrigin: publicOrigin(t.host, isSecure(req)),
      unreachable: (code) =>
        page(res, 502, `${t.host} isn't answering`, `The dev server behind it didn't accept the connection (${code}). It may still be starting, or it stopped: the dx dashboard shows its output.`),
    });
  }

  function upgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    const t = target(req);
    if (!t) return void socket.destroy();
    pipeUpgrade(req, socket, head, t.port, headersFor(req, t));
  }

  function notFound(req: http.IncomingMessage, res: http.ServerResponse): void {
    const host = hostname(req.headers.host);
    const known = [...localRoutes().keys()].sort();
    if (!host.endsWith(".localhost") && host !== "localhost") {
      return page(res, 404, "Not a dx address", "dx only answers for names ending in .localhost.");
    }
    page(
      res,
      404,
      `Nothing runs at ${host}`,
      known.length ? "Running now:" : "No dev servers are running. Start one from the dx dashboard at dx.localhost, or ask your AI tool to.",
      known.map((h) => publicOrigin(h, isSecure(req))),
    );
  }

  return {
    port: proxyPort,
    httpsPort,
    async close() {
      await Promise.all(
        [server, ...(v6port !== undefined ? [v6] : []), ...secureServers].map(
          (s) =>
            new Promise<void>((resolve) => {
              s.close(() => resolve());
              (s as http.Server).closeAllConnections?.();
            }),
        ),
      );
    },
  };
}

export interface RelayOptions {
  /** The dev server's port on this computer. */
  port: number;
  /** The request's headers as the dev server should get them. */
  headers: http.OutgoingHttpHeaders;
  /** When given, the exchange is logged (network log, activity) and the recorder goes into pages. */
  route?: LocalRoute;
  /** The address the request came to, for the network log. */
  label: string;
  /** Where redirects to the dev server's own address should point instead. */
  publicOrigin: string;
  /** Answers the browser when the dev server doesn't take the connection. */
  unreachable(code: string): void;
}

/**
 * Passes one request to a dev server on this computer and its answer back. With a route, the
 * exchange is recorded and HTML pages get the activity recorder as they stream through.
 */
export function relay(req: http.IncomingMessage, res: http.ServerResponse, o: RelayOptions): void {
  const { route } = o;
  // Mock mode: the project's API answered from its recordings; pages and assets still go through.
  if (route && answerFromMocks(req, res, route, o.label)) return;
  // The Requests page's rules: changed, held, slowed or failed on the way.
  let plan = route ? rulePlanFor(req, route) : undefined;
  // Chaos mode: some API calls slowed, failed, dropped or answered out of order, on purpose.
  const chaos = route ? chaosFor(req, route) : undefined;
  if (chaos) plan = withChaos(plan, chaos);
  // Custom tools of kind answer: fields added to or taken out of JSON answers on their way back.
  const answers = route ? answerToolsFor(req, route) : [];
  if (answers.length) plan = withAnswerTools(plan, answers);
  if (plan && route) return void relayWithRules(req, res, { ...o, route }, plan);
  const chaosOn = !!route && !!chaosConfig(route.dir)?.on;
  const rec = route ? recordExchange(req, route, o.label) : undefined;
  if (rec) req.on("data", (c: Buffer) => rec.request(c));
  let done = false;
  const finish = (error?: string) => {
    if (done) return;
    done = true;
    if (chaosOn) answered(callKey(req.method ?? "GET", req.url ?? "/"));
    if (!rec || !route) return;
    rec.end(error);
    requestActivity(rec.entry, route, String(req.headers["user-agent"] ?? ""));
    cacheAnswer(route, rec.entry, rec.fullResponse());
  };
  const outgoing = { ...o.headers };
  // A page the recorder goes into is asked for uncompressed, so the tag can be added as it streams.
  const wantsPage = !!route && req.method === "GET" && /text\/html/i.test(String(req.headers.accept ?? ""));
  if (wantsPage) delete outgoing["accept-encoding"];
  const upstream = http.request({ host: "localhost", port: o.port, method: req.method, path: req.url, headers: outgoing }, (up) => {
    const headers = { ...up.headers };
    const location = headers.location;
    if (typeof location === "string") {
      headers.location = location.replace(new RegExp(`^https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):${o.port}(?=/|$)`), o.publicOrigin);
    }
    const status = up.statusCode ?? 502;
    rec?.headers(status, up.headers);
    const inject = wantsPage && shouldInject(req, status, up.headers);
    if (inject) delete headers["content-length"];
    res.writeHead(status, up.statusMessage, headers);
    if (rec) {
      up.on("data", (c: Buffer) => rec.response(c));
      up.on("end", () => finish());
      up.on("aborted", () => finish("the dev server closed the connection"));
      res.on("close", () => finish());
    }
    if (!inject) return void up.pipe(res);
    const html = injector((chunk) => res.write(chunk));
    up.on("data", (c: Buffer) => html.push(c));
    up.on("end", () => {
      html.end();
      res.end();
    });
    up.on("aborted", () => res.destroy());
  });
  upstream.on("error", (err) => {
    const code = (err as NodeJS.ErrnoException).code ?? err.message;
    finish(code);
    if (res.headersSent) return res.destroy();
    o.unreachable(code);
  });
  req.pipe(upstream);
}

/** Passes a WebSocket upgrade (live reload) to a dev server on this computer, both ways. */
export function pipeUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer, port: number, headers: http.OutgoingHttpHeaders): void {
  const upstream = net.connect({ host: "localhost", port });
  upstream.once("connect", () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  const close = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on("error", close);
  socket.on("error", close);
}

function hostname(host: string | undefined): string {
  return String(host ?? "")
    .toLowerCase()
    .replace(/:\d+$/, "");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function page(res: http.ServerResponse, status: number, title: string, text: string, links: string[] = []): void {
  const items = links.map((l) => `<li><a href="${escapeHtml(l)}">${escapeHtml(l)}</a></li>`).join("");
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#171b21}@media(prefers-color-scheme:dark){body{background:#11151a;color:#d5dbe3}a{color:#67d8ee}}</style>` +
      `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${items ? `<ul>${items}</ul>` : ""}`,
  );
}

/** Listens on host:port, or resolves undefined when the port is taken or not allowed. */
export function listen(server: net.Server, port: number, host: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const onError = () => {
      server.removeListener("listening", onListening);
      resolve(undefined);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}
