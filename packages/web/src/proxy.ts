import http from "node:http";
import net from "node:net";
import { localRoutes } from "./dev.js";

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
  close(): Promise<void>;
}

/** Port 80 gives addresses without a number; 1355 is the fallback when 80 is taken or not allowed. */
export const DOMAIN_PORTS = [80, 1355];

export async function startLocalDomains(options: { dashboardPort: number; ports?: number[] }): Promise<LocalDomains | undefined> {
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

  function target(req: http.IncomingMessage): { port: number; host: string } | undefined {
    const host = hostname(req.headers.host);
    if (host === "dx.localhost") return { port: options.dashboardPort, host };
    const route = localRoutes().get(host);
    if (!route) return undefined;
    const u = new URL(route.url);
    return { port: Number(u.port || 80), host };
  }

  function publicOrigin(host: string): string {
    return `http://${host}${proxyPort === 80 ? "" : `:${proxyPort}`}`;
  }

  function headersFor(req: http.IncomingMessage, t: { port: number; host: string }): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: `localhost:${t.port}`, "x-forwarded-host": req.headers.host, "x-forwarded-proto": "http" };
    // The dashboard checks Origin; its own page through dx.localhost is the dashboard.
    if (t.host === "dx.localhost" && req.headers.origin === publicOrigin(t.host)) headers.origin = `http://localhost:${t.port}`;
    return headers;
  }

  function forward(req: http.IncomingMessage, res: http.ServerResponse): void {
    const t = target(req);
    if (!t) return notFound(req, res);
    const upstream = http.request(
      { host: "localhost", port: t.port, method: req.method, path: req.url, headers: headersFor(req, t) },
      (up) => {
        const headers = { ...up.headers };
        const location = headers.location;
        if (typeof location === "string") {
          headers.location = location.replace(new RegExp(`^https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):${t.port}(?=/|$)`), publicOrigin(t.host));
        }
        res.writeHead(up.statusCode ?? 502, up.statusMessage, headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      if (res.headersSent) return res.destroy();
      page(res, 502, `${t.host} isn't answering`, `The dev server behind it didn't accept the connection (${(err as NodeJS.ErrnoException).code ?? err.message}). It may still be starting, or it stopped: the dx dashboard shows its output.`);
    });
    req.pipe(upstream);
  }

  function upgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    const t = target(req);
    if (!t) return void socket.destroy();
    const upstream = net.connect({ host: "localhost", port: t.port });
    upstream.once("connect", () => {
      const headers = headersFor(req, t);
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
      known.map((h) => publicOrigin(h)),
    );
  }

  return {
    port: proxyPort,
    async close() {
      await Promise.all(
        [server, ...(v6port !== undefined ? [v6] : [])].map(
          (s) =>
            new Promise<void>((resolve) => {
              s.close(() => resolve());
              s.closeAllConnections();
            }),
        ),
      );
    },
  };
}

function hostname(host: string | undefined): string {
  return String(host ?? "")
    .toLowerCase()
    .replace(/:\d+$/, "");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(res: http.ServerResponse, status: number, title: string, text: string, links: string[] = []): void {
  const items = links.map((l) => `<li><a href="${escapeHtml(l)}">${escapeHtml(l)}</a></li>`).join("");
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#171b21}@media(prefers-color-scheme:dark){body{background:#11151a;color:#d5dbe3}a{color:#67d8ee}}</style>` +
      `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${items ? `<ul>${items}</ul>` : ""}`,
  );
}

/** Listens on host:port, or resolves undefined when the port is taken or not allowed. */
function listen(server: http.Server, port: number, host: string): Promise<number | undefined> {
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
