import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi, HttpError } from "./api.js";
import { certCovers, dxPath, ensureCert, loadConfig, projectHostNames, type CertFiles, type DxConfig } from "@dx/core";
import { releaseAll } from "./intercept.js";
import { flushCache, listMockServers, startMockServer, stopAllMockServers } from "./mocks.js";
import { prunePhones, stopAllPhones } from "./phone.js";
import { startEnvWatch } from "./envwatch.js";
import { anyDevServerRunning, setLocalDomainsPort, stopAllDevServers } from "./dev.js";
import { DOMAIN_PORTS, startLocalDomains, type LocalDomains, type TlsOptions } from "./proxy.js";
import { clearDashboardInfo, writeDashboardInfo } from "./link.js";
import { closeDxBrowser, dxBrowserOpen, setDxBrowserDashboardPort } from "./dxbrowser.js";
import { startHeadWatch } from "./visual.js";

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
// A bug bundle (at most 2 MB), a mock's body (at most 1 MB, larger once escaped as JSON) and a tools file (at most 2 MB) come in whole.
const LARGE_BODY = 3 * 1024 * 1024;
const LARGE_PATHS = new Set(["/api/activity/bundle/replay", "/api/mocks/update", "/api/tools/import/check", "/api/tools/import"]);
// A tool chat has no limit: the maintainer pastes long texts, sent again with each turn's history.
// It's read only after the token, Host and Origin checks, so only dx's own page and CLI can send one.
const UNLIMITED_PATHS = new Set(["/api/tools/chat"]);
// A dx state file (at most 25 MB, core's STATE_MAX), checked and then imported whole.
const STATE_BODY = 26 * 1024 * 1024;
const STATE_PATHS = new Set(["/api/state/import/check", "/api/state/import"]);
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
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
      // Floppy asks every few seconds what's going on; that alone doesn't keep a background dashboard running.
      if (req.headers["x-dx-quiet"] !== "1") lastActivity = Date.now();
      if (url.pathname === "/api/shutdown" && req.method === "POST") {
        send(res, 200, { ok: true });
        setTimeout(() => void close(), 50);
        return;
      }
      let body: Record<string, unknown> = {};
      if (req.method === "POST") {
        try {
          body = await readJson(req, UNLIMITED_PATHS.has(url.pathname) ? Infinity : STATE_PATHS.has(url.pathname) ? STATE_BODY : LARGE_PATHS.has(url.pathname) ? LARGE_BODY : MAX_BODY);
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
  setDxBrowserDashboardPort(port);

  let domains: LocalDomains | undefined;
  const config = loadConfig();
  const domainPorts = options.localDomainPorts ?? (config.localDomains === false ? false : config.localDomainsPort !== undefined ? [config.localDomainsPort] : DOMAIN_PORTS);
  if (domainPorts !== false) domains = await startLocalDomains({ dashboardPort: port, ports: domainPorts, tls: await localTls(config) }).catch(() => undefined);
  setLocalDomainsPort(domains?.port, domains?.httpsPort);
  // Mock servers that were running when the dashboard last stopped start again, on the same port when it's free.
  await restoreMockServers();

  writeDashboardInfo({ url, port, token, pid: process.pid, startedAt: new Date().toISOString(), background: !!options.background, localDomainsPort: domains?.port, httpsPort: domains?.httpsPort });

  const idleMs = (options.idleMinutes ?? 30) * 60_000;
  const idleTimer = setInterval(() => {
    prunePhones();
    if (options.background && !anyDevServerRunning() && !dxBrowserOpen() && !listMockServers().length && Date.now() - lastActivity > idleMs) options.onIdle?.();
  }, Math.min(60_000, Math.max(1000, idleMs / 4)));
  idleTimer.unref();
  // A commit made in a terminal under a dev server dx runs gets its visual diff too.
  const stopHeadWatch = startHeadWatch();
  // .env files changed, staged or committed in any project: a warning, with a sound and the system's notification.
  const stopEnvWatch = startEnvWatch();

  function close(): Promise<void> {
    closing ??= (async () => {
      clearInterval(idleTimer);
      stopHeadWatch();
      stopEnvWatch();
      clearDashboardInfo();
      // Anything held in Intercept goes on as it was; the cache's last answers are written down.
      releaseAll();
      flushCache();
      await stopAllMockServers();
      await stopAllPhones();
      await stopAllDevServers();
      // It records through this dashboard, so it goes with it, like the dev servers.
      await closeDxBrowser().catch(() => undefined);
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

/** Starts the mock servers whose sets say they were on, for projects that are still there. */
async function restoreMockServers(): Promise<void> {
  let files: string[] = [];
  try {
    files = fs.readdirSync(dxPath("mocks")).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  for (const f of files) {
    try {
      const set = JSON.parse(fs.readFileSync(dxPath("mocks", f), "utf8")) as { dir?: string; project?: string; server?: boolean };
      if (set.server === true && set.dir && fs.existsSync(set.dir)) await startMockServer(set.dir, set.project ?? path.basename(set.dir)).catch(() => undefined);
    } catch {
      // a broken file: skipped
    }
  }
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

function readJson(req: http.IncomingMessage, max = MAX_BODY): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error("Request too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      let text: string;
      try {
        text = Buffer.concat(chunks).toString("utf8").trim();
      } catch {
        // past what Node can hold as one string
        return reject(new Error("Request too large."));
      }
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
