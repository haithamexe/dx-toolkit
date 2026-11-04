import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// Apps opened at localhost:<port>, the address you'd type, are recorded too: dx answers there
// and runs the dev server on another port. A fake `vite` stands in for the real one: it listens
// on the --port it's given, the way vite does.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-door-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-door-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0 }));

const usualPort = await freePort();
const otherPort = await freePort();

/** A project whose dev script is `vite`, run by a fake that serves a page, an API and a socket. */
function fakeViteProject(name: string, port: number, obeysPort: boolean): string {
  const dir = path.join(root, name);
  const bin = path.join(dir, "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules", "fake-vite"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, scripts: { dev: "vite" } }));
  // The usual address, as .devrc.json says it: a free port, not 5173, so tests don't collide with real apps.
  fs.writeFileSync(path.join(dir, ".devrc.json"), JSON.stringify({ url: `http://localhost:${port}` }));
  fs.writeFileSync(
    path.join(dir, "node_modules", "fake-vite", "cli.cjs"),
    `const http = require("http");
     const args = process.argv.slice(2);
     const i = args.indexOf("--port");
     const port = ${obeysPort ? 'i >= 0 ? Number(args[i + 1]) : 5173' : otherPort};
     const s = http.createServer((q, r) => {
       if (q.url === "/api/hello") { r.setHeader("content-type", "application/json"); return r.end(JSON.stringify({ hello: "world", host: q.headers.host })); }
       if (q.url === "/go") { r.writeHead(302, { location: "http://localhost:" + port + "/there" }); return r.end(); }
       r.setHeader("content-type", "text/html"); r.end("<!doctype html><html><head><title>Door</title></head><body>hi</body></html>");
     });
     s.on("upgrade", (req, socket) => {
       socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n");
       socket.on("data", (d) => socket.write("echo:" + d));
     });
     s.listen(port, "127.0.0.1", () => console.log("  Local:   http://localhost:" + port + "/"));`,
  );
  fs.writeFileSync(path.join(bin, "vite.cmd"), `@node "%~dp0\\..\\fake-vite\\cli.cjs" %*\r\n`);
  fs.writeFileSync(path.join(bin, "vite"), `#!/bin/sh\nexec node "$(dirname "$0")/../fake-vite/cli.cjs" "$@"\n`, { mode: 0o755 });
  return dir;
}

const app = fakeViteProject("door-app", usualPort, true);
const stubborn = fakeViteProject("stubborn-app", await freePort(), false);

const { startDashboard } = await import("../server.js");
const { isPortOpen, readActivity } = await import("@dx/core");
let dashboard: Awaited<ReturnType<typeof startDashboard>>;

async function api(p: string, body?: unknown) {
  const res = await fetch(new URL(p, dashboard.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-DX-Token": dashboard.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as any;
}

async function waitReady(dir: string) {
  let s: any;
  for (let i = 0; i < 150; i++) {
    s = (await api("/api/dev")).find((d: { dir: string }) => d.dir === dir);
    if (s?.status === "ready" || s?.status === "failed") return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  return s;
}

function get(port: number, p: string, headers: Record<string, string> = {}, method = "GET", body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

before(async () => {
  dashboard = await startDashboard({ port: 0 });
});
after(async () => {
  await api("/api/dev/stop", { dir: app });
  await api("/api/dev/stop", { dir: stubborn });
  await dashboard.close();
});

test("dx answers at the app's usual address and the dev server runs behind it", async () => {
  await api("/api/dev/start", { dir: app });
  const s = await waitReady(app);
  assert.equal(s.status, "ready", JSON.stringify(s));
  assert.equal(s.url, `http://localhost:${usualPort}`, "the address to open is the usual one");
  assert.equal(s.recorded, true);
  assert.match(s.command, /--port \d+ --strictPort$/, "the server was told its own port");
  const logs = await api(`/api/dev/logs?dir=${encodeURIComponent(app)}&after=0`);
  assert.ok(logs.lines.some((l: { text: string }) => l.text.startsWith(`Recording at http://localhost:${usualPort}`)), JSON.stringify(logs.lines));
  assert.ok(logs.lines.some((l: { text: string }) => l.text === `Ready at http://localhost:${usualPort}`));
});

test("a page there gets the recorder, the API is logged, redirects stay on the usual address", async () => {
  const page = await get(usualPort, "/", { accept: "text/html" });
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('<head><script src="/__dx/node_modules/dx-recorder.js"></script><title>Door</title>'), page.body);
  const hello = await get(usualPort, "/api/hello", { accept: "application/json" });
  assert.deepEqual(JSON.parse(hello.body), { hello: "world", host: `localhost:${usualPort}` }, "the Host the browser sent reaches the server");
  const go = await get(usualPort, "/go");
  assert.equal(go.headers.location, `http://localhost:${usualPort}/there`);

  // The page's own events: only from the page's origin.
  const events = JSON.stringify({ visit: "door1", events: [{ type: "action", text: "Clicked button “Save”", target: "text=Save", at: Date.now() }] });
  assert.equal((await get(usualPort, "/__dx/events", { origin: "http://evil.example", "content-type": "text/plain" }, "POST", events)).status, 403);
  assert.equal((await get(usualPort, "/__dx/events", { origin: `http://localhost:${usualPort}`, "content-type": "text/plain" }, "POST", events)).status, 204);

  const list = await api(`/api/activity?dir=${encodeURIComponent(app)}&since=1h`);
  assert.ok(list.some((e: { type: string; url?: string; status?: number }) => e.type === "request" && e.url === "/api/hello" && e.status === 200), JSON.stringify(list.map((e: { type: string; text: string }) => [e.type, e.text])));
  assert.ok(list.some((e: { type: string; text: string; visit?: string }) => e.type === "action" && e.visit === "door1"));
  assert.ok(readActivity({ dir: app }).some((e) => e.url === "/api/hello"), "and on disk");
});

test("live reload's socket passes through", async () => {
  const echoed = await new Promise<string>((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: usualPort }, () => {
      socket.write(`GET /ws HTTP/1.1\r\nHost: localhost:${usualPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
    });
    let got = "";
    socket.on("data", (d) => {
      got += d;
      if (got.includes("101") && !got.includes("echo:")) socket.write("ping");
      if (got.includes("echo:ping")) {
        socket.destroy();
        resolve(got);
      }
    });
    socket.on("error", reject);
    setTimeout(() => reject(new Error(`no echo: ${got}`)), 5000);
  });
  assert.match(echoed, /echo:ping/);
});

test("a server that ignores the port it's given runs as before, and dx steps aside", async () => {
  await api("/api/dev/start", { dir: stubborn });
  const s = await waitReady(stubborn);
  assert.equal(s.status, "ready", JSON.stringify(s));
  assert.equal(s.url, `http://localhost:${otherPort}`);
  assert.equal(s.recorded, undefined);
  const logs = await api(`/api/dev/logs?dir=${encodeURIComponent(stubborn)}&after=0`);
  assert.ok(logs.lines.some((l: { text: string }) => /didn't take the port dx gave it/.test(l.text)), JSON.stringify(logs.lines.map((l: { text: string }) => l.text)));
});

test("stopping the app frees its usual address", async () => {
  await api("/api/dev/stop", { dir: app });
  for (let i = 0; i < 50 && (await isPortOpen(usualPort)); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await isPortOpen(usualPort), false);
});

test("off with localhostRecording: false", async () => {
  await api("/api/config", { localhostRecording: false });
  await api("/api/dev/start", { dir: app });
  const s = await waitReady(app);
  assert.equal(s.recorded, undefined);
  assert.equal(s.command, "npm run dev");
  await api("/api/dev/stop", { dir: app });
  await api("/api/config", { localhostRecording: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}
