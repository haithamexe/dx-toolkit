import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// A dx home and a projects folder of our own, so the tests never touch the real ones.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-web-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-web-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", localDomainsPort: 0 }));

// A tiny project whose dev server prints its URL like Vite does, then serves on it.
const app = path.join(root, "tiny-app");
fs.mkdirSync(app);
fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "tiny-app", scripts: { dev: "node server.cjs" } }));
fs.writeFileSync(
  path.join(app, "server.cjs"),
  `const http = require("http");
   function checkout(cart) { return cart.items.length; }
   const s = http.createServer((q, r) => {
     if (q.url === "/boom") {
       try { checkout(undefined); } catch (e) { console.error(e.stack); }
       r.statusCode = 500;
       return r.end("Internal Server Error");
     }
     if (q.url === "/fixed") {
       console.log("10:42:07 [vite] page reload src/cart.js");
       return r.end("ok");
     }
     r.setHeader("content-type", "text/html");
     r.end("<!doctype html><title>Tiny shop</title><h1>Hello</h1><script>var x = 1;</script>");
   }).listen(0, "127.0.0.1", () => {
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

test("writes its address and token to dashboard.json, for this user only, so the MCP server can find it", async () => {
  const { readDashboardInfo, findDashboard } = await import("../link.js");
  const info = readDashboardInfo();
  assert.equal(info?.port, dashboard.port);
  assert.equal(info?.token, dashboard.token);
  assert.equal(info?.pid, process.pid);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(home, "dashboard.json")).mode & 0o077, 0, "no access for group or others");
  const client = await findDashboard();
  assert.ok(client, "found and answering");
  assert.deepEqual(await client.get("/api/ping"), { ok: true, pid: process.pid });
});

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

test("check only reaches this computer", async () => {
  for (const url of ["http://example.com/", "http://192.168.1.1/", "file:///etc/passwd", "http://localhost.evil.com/"]) {
    const r = await api("/api/check", { method: "POST", body: { url } });
    assert.equal(r.status, 400, url);
  }
  const refused = (await api("/api/check", { method: "POST", body: { url: "http://127.0.0.1:1/" } })).json;
  assert.match(refused.error, /Nothing is listening on port 1|ECONNREFUSED|fetch failed/);
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

  // The terminal: only one dx knows on this system; "" goes back to the first one found.
  assert.equal((await api("/api/config", { method: "POST", body: { terminal: "rm -rf /" } })).status, 400);
  const terminals = (await api("/api/terminals")).json as { id: string; installed: boolean; selected: boolean }[];
  assert.ok(terminals.length >= 3);
  const installed = terminals.filter((t) => t.installed);
  if (installed.length) {
    const pick = installed[installed.length - 1].id;
    assert.equal((await api("/api/config", { method: "POST", body: { terminal: pick } })).json.terminal, pick);
    assert.equal(((await api("/api/terminals")).json as typeof terminals).find((t) => t.selected)?.id, pick);
    assert.equal((await api("/api/config", { method: "POST", body: { terminal: "" } })).json.terminal, undefined);
  }
  assert.equal((await api("/api/projects/open", { method: "POST", body: { dir: path.join(root, "nowhere"), action: "shell" } })).status, 404, "only known projects");

  // How long the activity history is kept stays within bounds.
  assert.equal((await api("/api/config", { method: "POST", body: { activity: false, activityDays: 5000 } })).json.activityDays, 365);
  assert.equal((await api("/api/config", { method: "POST", body: { activity: true, activityDays: 7 } })).json.activity, true);
});

test("env & secrets: lists .env files, reads and saves only those, and fixes .gitignore", async () => {
  const envApp = path.join(root, "env-app");
  fs.mkdirSync(path.join(envApp, "apps", "web"), { recursive: true });
  fs.writeFileSync(path.join(envApp, "package.json"), JSON.stringify({ name: "env-app" }));
  fs.writeFileSync(path.join(envApp, ".env"), "API_KEY=first-value\n");
  fs.writeFileSync(path.join(envApp, ".env.example"), "API_KEY=\n");
  fs.writeFileSync(path.join(envApp, "apps", "web", ".env.local"), "X=1\n");

  const all = (await api("/api/env/all")).json as { name: string; problems: number; files: { name: string }[]; gitignore: boolean }[];
  const mine = all.find((p) => p.name === "env-app")!;
  assert.deepEqual(mine.files.map((f) => f.name), [".env", ".env.example", "apps/web/.env.local"]);
  assert.equal(mine.gitignore, false);
  assert.ok(mine.problems > 0);
  assert.ok(!JSON.stringify(all).includes("first-value"), "the list never carries values");

  const read = await api(`/api/env/file?dir=${encodeURIComponent(envApp)}&name=.env`);
  assert.equal(read.json.content, "API_KEY=first-value\n");
  for (const bad of ["package.json", "../env-app/.env", "apps/../../tiny-app/.env"]) {
    assert.equal((await api(`/api/env/file?dir=${encodeURIComponent(envApp)}&name=${encodeURIComponent(bad)}`)).status, 400, bad);
  }
  assert.equal((await api(`/api/env/file?dir=${encodeURIComponent(path.join(root, "nowhere"))}&name=.env`)).status, 404, "only known projects");

  const saved = await api("/api/env/file", { method: "POST", body: { dir: envApp, name: ".env", content: "API_KEY=second-value\n" } });
  assert.equal(saved.status, 200);
  assert.equal(fs.readFileSync(path.join(envApp, ".env"), "utf8"), "API_KEY=second-value\n");
  assert.equal((await api("/api/env/file", { method: "POST", body: { dir: envApp, name: "package.json", content: "{}" } })).status, 400);
  const runs = fs.readFileSync(path.join(home, "runs.jsonl"), "utf8");
  assert.ok(runs.includes("env-app: saved .env") && !runs.includes("second-value"), "the run log names the file, never its values");

  const fixed = await api("/api/env/gitignore", { method: "POST", body: { dir: envApp, patterns: [".env", ".env.*", "*.pem", "rm -rf /"] } });
  assert.deepEqual(fixed.json.added, [".env", ".env.*", "*.pem", "!.env.example"]);
  const after = (await api(`/api/env/project?dir=${encodeURIComponent(envApp)}`)).json;
  assert.equal(after.gitignore, true);
  assert.ok(after.rules.find((r: { pattern: string }) => r.pattern === ".env").covered);
});

test("git: graph, status, staging by file and by block, and commit, only on known projects and listed files", async () => {
  const repo = path.join(root, "git-app");
  fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "octocat@example.com");
  git("config", "user.name", "octocat");
  git("config", "core.autocrlf", "false");
  git("config", "commit.gpgsign", "false");
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  fs.writeFileSync(path.join(repo, "notes.txt"), `${lines.join("\n")}\n`);
  git("add", ".");
  git("commit", "-q", "-m", "First notes");
  const q = `dir=${encodeURIComponent(repo)}`;

  const graph = await api(`/api/git/graph?${q}`);
  assert.equal(graph.status, 200);
  assert.equal(graph.json.commits[0].subject, "First notes");
  const commit = await api(`/api/git/commit?${q}&hash=${graph.json.commits[0].short}`);
  assert.ok(commit.json.patch.includes("+line 1"));
  assert.equal((await api(`/api/git/commit?${q}&hash=--all`)).status, 400);
  assert.equal((await api(`/api/git/graph?dir=${encodeURIComponent(path.join(root, "nowhere"))}`)).status, 404, "only known projects");
  assert.equal((await api(`/api/git/status?dir=${encodeURIComponent(app)}`)).status, 400, "a project without git");

  const changed = lines.slice();
  changed[1] = "line 2 edited";
  changed[27] = "line 28 edited";
  fs.writeFileSync(path.join(repo, "notes.txt"), `${changed.join("\n")}\n`);
  fs.writeFileSync(path.join(repo, "todo.txt"), "buy milk\n");
  const status = (await api(`/api/git/status?${q}`)).json;
  assert.deepEqual(status.files.map((f: { path: string }) => f.path).sort(), ["notes.txt", "todo.txt"]);

  assert.equal((await api("/api/git/stage", { method: "POST", body: { dir: repo, paths: ["../tiny-app/package.json"] } })).status, 409, "only files git lists");
  assert.equal((await api("/api/git/stage", { method: "POST", body: { dir: repo, paths: "todo.txt" } })).status, 400);
  const staged = await api("/api/git/stage", { method: "POST", body: { dir: repo, paths: ["todo.txt"] } });
  assert.equal(staged.json.files.find((f: { path: string }) => f.path === "todo.txt").staged, true);

  const diff = (await api(`/api/git/diff?${q}&path=notes.txt&staged=false`)).json;
  assert.equal(diff.hunks.length, 2);
  assert.equal((await api("/api/git/hunk", { method: "POST", body: { dir: repo, path: "notes.txt", hunk: "made-up", staged: false } })).status, 409);
  await api("/api/git/hunk", { method: "POST", body: { dir: repo, path: "notes.txt", hunk: diff.hunks[0].id, staged: false } });
  assert.ok(git("diff", "--cached", "notes.txt").includes("+line 2 edited"));
  assert.ok(!git("diff", "--cached", "notes.txt").includes("+line 28 edited"), "only that block");

  assert.equal((await api("/api/git/commit", { method: "POST", body: { dir: repo, message: "" } })).status, 400);
  const made = await api("/api/git/commit", { method: "POST", body: { dir: repo, message: "Edit the notes and add a todo" } });
  assert.equal(made.status, 200);
  assert.equal(git("log", "-1", "--format=%s").trim(), "Edit the notes and add a todo");
  assert.ok(fs.readFileSync(path.join(home, "runs.jsonl"), "utf8").includes("git-app: committed"));
  await api("/api/git/stage", { method: "POST", body: { dir: repo, paths: ["notes.txt"] } });
  const unstaged = await api("/api/git/unstage", { method: "POST", body: { dir: repo, paths: ["notes.txt"] } });
  assert.equal(unstaged.status, 200);
  assert.equal(git("diff", "--cached"), "", "nothing staged after unstaging");
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

  const listed = (await api("/api/projects")).json.find((p: { name: string }) => p.name === "tiny-app");
  assert.equal(listed.dev.status, "ready");

  assert.equal(server.startedBy, "dashboard");
  assert.equal(server.errorCount, 0, "a warning on stderr is not an error");

  // An AI agent's loop: request a page, see the error the server logged, fix it, see it resolved.
  const boom = (await api("/api/check", { method: "POST", body: { dir: app, path: "/boom" } })).json;
  assert.equal(boom.status, 500);
  assert.equal(boom.project, "tiny-app");
  assert.equal(boom.serverErrors.length, 1, JSON.stringify(boom.serverOutput));
  assert.match(boom.serverErrors[0].message, /^TypeError: Cannot read properties of undefined/);
  assert.ok(boom.serverErrors[0].file.endsWith("server.cjs"));
  assert.equal(boom.serverErrors[0].line, 2);

  const errors = (await api(`/api/dev/errors?dir=${encodeURIComponent(app)}`)).json;
  assert.equal(errors[0].errors.length, 1);
  assert.equal((await api("/api/dev")).json[0].errorCount, 1);

  const before = (await api("/api/dev")).json[0].lastLine;
  const page = (await api("/api/check", { method: "POST", body: { dir: app } })).json;
  assert.equal(page.status, 200);
  assert.equal(page.title, "Tiny shop");
  assert.equal(page.snippet, "Hello", "tags and scripts are left out");
  await api("/api/check", { method: "POST", body: { dir: app, path: "/fixed" } });
  const waited = (await api("/api/dev/wait", { method: "POST", body: { dir: app, after: before, quietMs: 300, settleMs: 500 } })).json;
  assert.equal(waited.sawOutput, true);
  assert.equal(waited.errors.length, 0, "the clean reload resolved it");
  assert.equal((await api(`/api/dev/errors?dir=${encodeURIComponent(app)}&all=1`)).json[0].errors[0].resolved, true);

  // Opening a file: only inside the project.
  assert.equal((await api("/api/open-file", { method: "POST", body: { dir: app, file: "../../outside.txt" } })).status, 400);
  assert.equal((await api("/api/open-file", { method: "POST", body: { dir: app, file: "missing.js" } })).status, 404);

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

test("machine: lists tools, needs and background processes, and acts only on what it listed", async () => {
  // The release list comes from the cache, so the test doesn't reach the network.
  fs.mkdirSync(path.join(home, "cache"), { recursive: true });
  fs.writeFileSync(path.join(home, "cache", "latest-versions.json"), JSON.stringify({ at: Date.now(), cycles: {}, npm: {}, github: {} }));

  const tools = (await api("/api/machine/tools")).json;
  const node = tools.find((t: { id: string }) => t.id === "node");
  assert.equal(node.installed, true);
  assert.equal(node.version, process.versions.node);

  const needs = (await api("/api/machine/projects")).json;
  const tiny = needs.find((p: { project: string }) => p.project === "tiny-app");
  assert.ok(tiny.needs.some((n: { tool: string; ok: boolean }) => n.tool === "node" && n.ok), "tiny-app needs Node, and has it");

  // A process this dashboard started counts as dx's: it's listed, with its project, but not stopped here.
  const worker = path.join(app, "worker.cjs");
  fs.writeFileSync(worker, "setInterval(() => {}, 1000);");
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [worker], { stdio: "ignore" });
  try {
    let listed: { pid: number; project?: string; runByDx: boolean } | undefined;
    for (let i = 0; i < 20 && !listed; i++) {
      listed = (await api("/api/machine/processes")).json.find((p: { pid: number }) => p.pid === child.pid);
      if (!listed) await new Promise((r) => setTimeout(r, 300));
    }
    assert.ok(listed, "the worker is listed");
    assert.equal(listed.project, "tiny-app");
    assert.equal(listed.runByDx, true);
    const refused = await api("/api/machine/stop", { method: "POST", body: { pid: child.pid } });
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, /Projects page/);
  } finally {
    child.kill();
  }

  assert.equal((await api("/api/machine/stop", { method: "POST", body: { pid: "1; rm -rf /" } })).status, 400);
  assert.equal((await api("/api/machine/stop", { method: "POST", body: { pid: process.pid } })).status, 400, "never dx itself");
  assert.equal((await api("/api/machine/docker/prune", { method: "POST", body: { what: "volumes" } })).status, 400, "volumes hold data");
  assert.equal((await api("/api/machine/docker/stop", { method: "POST", body: { id: "--all" } })).status, 400);
  assert.equal((await api("/api/machine/run", { method: "POST", body: { tool: "node && calc" } })).status, 400, "a known tool only");
  assert.equal((await api("/api/machine/run", { method: "POST", body: { tool: "node", dir: os.tmpdir() } })).status, 404, "a known project only");
  const upToDate = await api("/api/machine/run", { method: "POST", body: { tool: "node", dir: app } });
  assert.equal(upToDate.status, 400, "nothing to fix: no terminal is opened");
});
