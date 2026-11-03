import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// A dx home and a projects folder of our own, so the tests never touch the real ones.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-web-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-web-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code" }));

// A tiny project whose dev server prints its URL like Vite does, then serves on it.
const app = path.join(root, "tiny-app");
fs.mkdirSync(app);
fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "tiny-app", scripts: { dev: "node server.cjs" } }));
fs.writeFileSync(
  path.join(app, "server.cjs"),
  `const http = require("http");
   const s = http.createServer((q, r) => r.end("hi")).listen(0, "127.0.0.1", () => {
     console.log("  Local:   http://localhost:" + s.address().port + "/");
     console.error("a warning on stderr");
   });`,
);

const { startDashboard } = await import("../server.js");
let dashboard: Awaited<ReturnType<typeof startDashboard>>;

before(async () => {
  dashboard = await startDashboard({ port: 0 });
});
after(async () => {
  await dashboard.close();
});

async function api(p: string, init: { method?: string; body?: unknown; token?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (init.token !== null) headers["X-DX-Token"] = init.token ?? dashboard.token;
  if (init.body) headers["Content-Type"] = "application/json";
  const res = await fetch(new URL(p, dashboard.url), { method: init.method ?? "GET", headers, body: init.body ? JSON.stringify(init.body) : undefined });
  return { status: res.status, json: (await res.json()) as any };
}

function rawGet(p: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: dashboard.port, path: p, headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

test("serves the page with its token and a strict content security policy", async () => {
  const res = await fetch(dashboard.url);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes(`content="${dashboard.token}"`));
  assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  assert.equal((await fetch(new URL("app.js", dashboard.url))).status, 200);
});

test("refuses other hosts, missing tokens and paths outside the public folder", async () => {
  assert.equal(await rawGet("/", "evil.example:80"), 403, "DNS rebinding: another host name");
  assert.equal(await rawGet("/", `localhost:${dashboard.port}`), 200);
  assert.equal((await api("/api/projects", { token: null })).status, 401);
  assert.equal((await api("/api/projects", { token: "x".repeat(48) })).status, 401);
  assert.equal(await rawGet("/..%2f..%2fpackage.json", `127.0.0.1:${dashboard.port}`), 404);
  assert.equal((await api("/api/nope")).status, 404);
});

test("lists projects and only acts on projects dx found", async () => {
  const { status, json } = await api("/api/projects");
  assert.equal(status, 200);
  assert.deepEqual(json.map((p: { name: string }) => p.name), ["tiny-app"]);
  const outside = await api("/api/projects/open", { method: "POST", body: { dir: os.tmpdir(), action: "folder" } });
  assert.equal(outside.status, 404);
  assert.equal((await api("/api/dev/start", { method: "POST", body: { dir: os.homedir() } })).status, 404);
});

test("journal: add an entry and read it back", async () => {
  const empty = await api("/api/journal", { method: "POST", body: { text: "   " } });
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /empty/);
  const added = await api("/api/journal", { method: "POST", body: { text: "built the dashboard" } });
  assert.equal(added.status, 200);
  const { json } = await api("/api/journal?days=1");
  assert.deepEqual(json.map((e: { text: string }) => e.text), ["built the dashboard"]);
});

test("settings: validates and saves", async () => {
  assert.equal((await api("/api/config", { method: "POST", body: { githubUser: "not a user!" } })).status, 400);
  assert.equal((await api("/api/config", { method: "POST", body: { addRoot: path.join(root, "missing") } })).status, 400);
  const { status, json } = await api("/api/config", { method: "POST", body: { editor: "cursor", githubUser: "@octocat" } });
  assert.equal(status, 200);
  assert.equal(json.editor, "cursor");
  assert.equal(json.githubUser, "octocat");
});

test("runs a dev server, streams its output, notices the URL it prints, and stops it", async () => {
  const start = await api("/api/dev/start", { method: "POST", body: { dir: app } });
  assert.equal(start.status, 200);
  assert.equal(start.json.status, "starting");

  let server: any;
  for (let i = 0; i < 80; i++) {
    server = (await api("/api/dev")).json.find((s: { dir: string }) => s.dir === app);
    if (server?.status === "ready") break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal(server?.status, "ready");
  assert.match(server.url, /^http:\/\/localhost:\d+$/);

  const logs = (await api(`/api/dev/logs?dir=${encodeURIComponent(app)}&after=0`)).json;
  const text = logs.lines.map((l: { stream: string; text: string }) => `${l.stream}:${l.text}`).join("\n");
  assert.match(text, /dx:\$ npm run dev/);
  assert.match(text, /out:\s+Local:\s+http:\/\/localhost:\d+\//);
  assert.match(text, /err:a warning on stderr/);
  const newer = (await api(`/api/dev/logs?dir=${encodeURIComponent(app)}&after=${logs.server.lastLine}`)).json;
  assert.equal(newer.lines.length, 0, "only lines after the given number");

  const listed = (await api("/api/projects")).json[0];
  assert.equal(listed.dev.status, "ready");

  await api("/api/dev/stop", { method: "POST", body: { dir: app } });
  for (let i = 0; i < 60; i++) {
    server = (await api("/api/dev")).json.find((s: { dir: string }) => s.dir === app);
    if (server?.status === "stopped") break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal(server?.status, "stopped");
  assert.equal((await api("/api/dev/clear", { method: "POST", body: { dir: app } })).status, 200);
  assert.equal((await api("/api/dev")).json.length, 0);
});
