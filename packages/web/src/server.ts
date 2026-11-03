import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi, HttpError } from "./api.js";
import { certCovers, ensureCert, loadConfig, projectHostNames, type CertFiles, type DxConfig } from "@dx/core";
import { anyDevServerRunning, setLocalDomainsPort, stopAllDevServers } from "./dev.js";
import { DOMAIN_PORTS, startLocalDomains, type LocalDomains, type TlsOptions } from "./proxy.js";
import { clearDashboardInfo, writeDashboardInfo } from "./link.js";

/** The certificate for https://*.localhost when `dx https` turned it on and mkcert is still here. */
async function localTls(config: DxConfig): Promise<TlsOptions | undefined> {
  if (config.https !== true) return undefined;
  try {
    const cert = await ensureCert(projectHostNames());
    if (!cert) return undefined;
    const read = (c: CertFiles) => ({ cert: fs.readFileSync(c.cert), key: fs.readFileSync(c.key) });
    return {
      ...read(cert),
      ports: config.httpsPort !== undefined ? [config.httpsPort] : undefined,
      covers: (host) => certCovers(host),
      // A project made since the dashboard started: add its name (and its services') to the certificate.
      refresh: async (host) => {
        const base = host.replace(/\.localhost$/, "").split(".").pop();
        const next = base ? await ensureCert([`${base}.localhost`, `*.${base}.localhost`]) : undefined;
        return next && read(next);
      },
    };
  } catch {
    return undefined;
  }
}

/**
 * The dx dashboard's server. It listens on 127.0.0.1 only, and because the dashboard can kill
 * processes and delete folders, every API call must carry a token that exists only in the page
 * this server served. Other websites can't read that page, and the Host check stops a site that
 * re-points its own name at 127.0.0.1 (DNS rebinding).
 */
export interface DashboardOptions {
  /** Port to listen on (default 4646; the next free one if it's taken). 0 picks any free port. */
  port?: number;
  /** Folder with index.html, app.js and styles.css (default: this package's public folder). */
  publicDir?: string;
  /** Token to require; generated when not given. */
  token?: string;
  /** Running without a terminal; it then stops itself when idle. */
  background?: boolean;
  /** Minutes with no dev servers and no requests before a background dashboard calls onIdle (default 30). */
  idleMinutes?: number;
  onIdle?: () => void;
  /** Ports to try for local domains (shop.localhost); false for none. Default: the config, else 80 then 1355. */
  localDomainPorts?: number[] | false;
}

export interface Dashboard {
  url: string;
  port: number;
  token: string;
  /** The port shop.localhost is served on, when local domains are on. */
  localDomainsPort?: number;
  close(): Promise<void>;
  /** Settles once the dashboard has stopped, whoever stopped it. */
  closed: Promise<void>;
}

const DEFAULT_PORT = 4646;
const MAX_BODY = 1024 * 1024;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export async function startDashboard(options: DashboardOptions = {}): Promise<Dashboard> {
  const token = options.token ?? randomBytes(24).toString("hex");
  const publicDir = options.publicDir ?? fileURLToPath(new URL("../public/", import.meta.url));
  let port = 0;
  let lastActivity = Date.now();
  let closing: Promise<void> | undefined;
  let markClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => (markClosed = resolve));

  const server = http.createServer((req, res) => {
    void respond(req, res).catch((err: Error) => send(res, 500, { error: err.message }));
  });

  async function respond(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(String(req.headers.host ?? "").toLowerCase())) {
      return send(res, 403, { error: "The dx dashboard only answers on 127.0.0.1." });
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    if (url.pathname.startsWith("/api/")) {
      if (!tokenMatches(req.headers["x-dx-token"], token)) {
        return send(res, 401, { error: "Missing or wrong dashboard token. Reload the page, or run dx ui again." });
      }
      const origin = req.headers.origin;
      if (origin && !allowedHosts.some((h) => origin === `http://${h}`)) return send(res, 403, { error: "Wrong origin." });
      lastActivity = Date.now();
      if (url.pathname === "/api/shutdown" && req.method === "POST") {
        send(res, 200, { ok: true });
        setTimeout(() => void close(), 50);
        return;
      }
      let body: Record<string, unknown> = {};
      if (req.method === "POST") {
        try {
          body = await readJson(req);
        } catch (err) {
          return send(res, 400, { error: (err as Error).message });
        }
      }
      try {
        const result = await handleApi({ method: req.method ?? "GET", path: url.pathname, query: url.searchParams, body });
        return send(res, 200, result ?? null);
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        return send(res, status, { error: (err as Error).message });
      }
    }

    if (req.method !== "GET") return send(res, 405, { error: "Method not allowed" });
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(publicDir, rel);
    if (!file.startsWith(path.resolve(publicDir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return send(res, 404, { error: "Not found" });
    }
    let content: Buffer | string = fs.readFileSync(file);
    if (rel === "index.html") content = content.toString("utf8").replace("__DX_TOKEN__", token);
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    res.end(content);
  }

  port = await listen(server, options.port ?? DEFAULT_PORT);
  const url = `http://127.0.0.1:${port}/`;

  let domains: LocalDomains | undefined;
  const config = loadConfig();
  const domainPorts = options.localDomainPorts ?? (config.localDomains === false ? false : config.localDomainsPort !== undefined ? [config.localDomainsPort] : DOMAIN_PORTS);
  if (domainPorts !== false) domains = await startLocalDomains({ dashboardPort: port, ports: domainPorts, tls: await localTls(config) }).catch(() => undefined);
  setLocalDomainsPort(domains?.port, domains?.httpsPort);

  writeDashboardInfo({ url, port, token, pid: process.pid, startedAt: new Date().toISOString(), background: !!options.background, localDomainsPort: domains?.port, httpsPort: domains?.httpsPort });

  const idleMs = (options.idleMinutes ?? 30) * 60_000;
  const idleTimer = setInterval(() => {
    if (options.background && !anyDevServerRunning() && Date.now() - lastActivity > idleMs) options.onIdle?.();
  }, Math.min(60_000, Math.max(1000, idleMs / 4)));
  idleTimer.unref();

  function close(): Promise<void> {
    closing ??= (async () => {
      clearInterval(idleTimer);
      clearDashboardInfo();
      await stopAllDevServers();
      setLocalDomainsPort(undefined);
      await domains?.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      markClosed();
    })();
    return closing;
  }

  return { url, port, token, localDomainsPort: domains?.port, close, closed };
}

/** Listens on 127.0.0.1, moving to the next port when the wanted one is taken. */
function listen(server: http.Server, wanted: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = wanted;
    const tryPort = () => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attempt !== 0 && attempt < wanted + 20) {
          attempt++;
          tryPort();
        } else reject(err);
      });
      server.listen(attempt, "127.0.0.1", () => {
        server.removeAllListeners("error");
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : attempt);
      });
    };
    tryPort();
  });
}

function tokenMatches(given: string | string[] | undefined, token: string): boolean {
  if (typeof given !== "string" || given.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("Request too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        const json = JSON.parse(text) as unknown;
        if (!json || typeof json !== "object" || Array.isArray(json)) return reject(new Error("Expected a JSON object."));
        resolve(json as Record<string, unknown>);
      } catch {
        reject(new Error("The request body isn't valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(body));
}
