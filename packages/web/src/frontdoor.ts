import http from "node:http";
import type net from "node:net";
import type { LocalRoute } from "./dev.js";
import { listen, page, pipeUpgrade, relay } from "./proxy.js";
import { handleRecorderRequest } from "./recorder.js";

/**
 * dx at an app's usual address. When dx starts a dev server it knows how to move (vite, next, …),
 * the server runs on a port of its own and dx answers on the one you'd open, localhost:5173,
 * passing everything through. So what happens in your own browser there is recorded too, the
 * same as at shop.localhost: requests, and the page's clicks, routes, console and errors.
 *
 * It listens on this computer only, forwards only to that one dev server, and keeps the Host
 * the browser sent, so the server's own links and redirects keep pointing here.
 */
export interface FrontDoor {
  port: number;
  close(): Promise<void>;
}

/** Listens on `port` for one dev server; `target` says where it is once it runs. */
export async function openFrontDoor(port: number, target: () => { port: number; route: LocalRoute } | undefined): Promise<FrontDoor | undefined> {
  const handle = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const t = target();
    if (!t) return page(res, 503, "Still starting", "The dev server is starting. This page will work in a moment: reload it.");
    const origin = `http://${req.headers.host}`;
    if ((req.url ?? "").startsWith("/__dx/") && handleRecorderRequest(req, res, t.route, origin)) return;
    relay(req, res, {
      port: t.port,
      headers: { ...req.headers, "x-forwarded-host": req.headers.host, "x-forwarded-proto": "http" },
      route: t.route,
      label: req.headers.host ?? `localhost:${port}`,
      publicOrigin: origin,
      unreachable: (code) => page(res, 502, "The dev server isn't answering", `It didn't take the connection (${code}). It may have stopped: the dx dashboard shows its output.`),
    });
  };
  const upgrade = (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const t = target();
    if (!t) return void socket.destroy();
    pipeUpgrade(req, socket, head, t.port, req.headers);
  };
  const make = () => {
    const s = http.createServer(handle);
    s.on("upgrade", (req, socket, head) => upgrade(req, socket as net.Socket, head));
    s.on("clientError", (_err, socket) => socket.destroy());
    return s;
  };
  const v4 = make();
  if ((await listen(v4, port, "127.0.0.1")) === undefined) return undefined;
  // Browsers try ::1 for localhost first on some systems.
  const v6 = make();
  const both = (await listen(v6, port, "::1")) !== undefined;
  return {
    port,
    async close() {
      await Promise.all(
        [v4, ...(both ? [v6] : [])].map(
          (s) =>
            new Promise<void>((resolve) => {
              s.close(() => resolve());
              s.closeAllConnections?.();
            }),
        ),
      );
    },
  };
}

/** A port nothing listens on right now, from the system. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      const port = typeof address === "object" && address ? address.port : 0;
      s.close(() => resolve(port));
    });
  });
}
