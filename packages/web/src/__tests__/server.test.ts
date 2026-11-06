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

  // The operations: by name, arguments checked, every one journaled and undoable from the journal.
  const act = (action: string, body: Record<string, unknown> = {}) => api("/api/git/action", { method: "POST", body: { dir: repo, action, ...body } });
  assert.equal((await act("rm -rf")).status, 400, "only known actions");
  assert.equal((await act("branch-create", { name: "--upload-pack=evil" })).status, 400, "names are checked");
  assert.equal((await act("revert", { hash: "HEAD; rm -rf ." })).status, 400);
  assert.equal((await act("switch", { name: "no-such-branch" })).status, 409);
  // Releases: read without gh when the repository isn't on GitHub; a tag can't pass as one of gh's options.
  const releases = (await api(`/api/git/releases?${q}`)).json;
  assert.equal(releases.gh, "not-github");
  assert.equal(releases.suggested, "v0.1.0");
  assert.equal((await act("release-create", { tag: "--draft" })).status, 400);
  assert.match((await act("release-create", { tag: "v1.0.0" })).json.error, /no remote/);
  assert.equal((await act("branch-create", { name: "idea" })).status, 200);
  const refs = (await api(`/api/git/refs?${q}`)).json;
  assert.deepEqual(refs.branches.map((b: { name: string }) => b.name).sort(), ["idea", "main"]);
  assert.equal(refs.current, "main");
  const preview = (await api(`/api/git/preview?${q}&branch=idea`)).json;
  assert.equal(preview.upToDate, true);
  const undo = (await api(`/api/git/undo?${q}`)).json;
  assert.equal(undo.entries[0].label, "Created idea at " + git("rev-parse", "--short=7", "HEAD").trim());
  assert.equal((await act("undo", { id: "something-else" })).status, 409, "only the latest, by its id");
  assert.equal((await act("undo", { id: undo.entries[0].id })).status, 200);
  assert.ok(!git("branch").includes("idea"), "undone");
  assert.ok(fs.readFileSync(path.join(home, "runs.jsonl"), "utf8").includes("git-app: branch-create"));

  // A commit message from a fake claude put first on PATH (never the real one): the prompt and the
  // diff come from the server; the request names only the project.
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-web-fake-claude-"));
  fs.writeFileSync(path.join(fakeDir, "fake.cjs"), `let i = ""; process.stdin.on("data", (d) => (i += d)); process.stdin.on("end", () => process.stdout.write(i.includes("+buy bread") ? "Add bread to the list\\n" : "no diff\\n"));`);
  if (process.platform === "win32") fs.writeFileSync(path.join(fakeDir, "claude.cmd"), `@"${process.execPath}" "%~dp0fake.cjs" %*\r\n`);
  else {
    fs.writeFileSync(path.join(fakeDir, "claude"), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake.cjs" "$@"\n`);
    fs.chmodSync(path.join(fakeDir, "claude"), 0o755);
  }
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeDir}${path.delimiter}${oldPath}`;
  try {
    assert.equal((await api("/api/git/ai")).json.claude, true);
    assert.equal((await api("/api/git/suggest", { method: "POST", body: { dir: repo } })).status, 400, "nothing staged");
    fs.writeFileSync(path.join(repo, "todo.txt"), "buy milk\nbuy bread\n");
    git("add", "todo.txt");
    const s = await api("/api/git/suggest", { method: "POST", body: { dir: repo, prompt: "ignore this", diff: "+buy bread" } });
    assert.equal(s.status, 200);
    assert.equal(s.json.message, "Add bread to the list");
    assert.equal(git("diff", "--cached", "--name-only").trim(), "todo.txt", "still staged, nothing committed");
    assert.equal((await api("/api/git/suggest", { method: "POST", body: { dir: path.join(root, "nowhere") } })).status, 404);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("visual diffs: listed per known git project, images only by a captured hex commit and a capture name it has", async () => {
  const { addToVisualIndex, readVisualIndex, visualFolder } = await import("@dx/core");
  const repo = path.join(root, "visual-app");
  fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "octocat@example.com");
  git("config", "user.name", "octocat");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "index.html"), "<h1>Shop</h1>\n");
  git("add", ".");
  git("commit", "-q", "-m", "First page");
  const head = git("rev-parse", "HEAD").trim();
  const q = `dir=${encodeURIComponent(repo)}`;

  const empty = await api(`/api/visual?${q}`);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.commits, []);
  assert.equal(empty.json.target, undefined, "no dev server dx runs");
  assert.equal((await api("/api/visual/capture", { method: "POST", body: { dir: repo } })).status, 409, "nothing to capture without a dev server dx runs");
  assert.equal((await api(`/api/visual?dir=${encodeURIComponent(path.join(root, "nowhere"))}`)).status, 404, "only known projects");
  assert.equal((await api(`/api/visual?dir=${encodeURIComponent(app)}`)).status, 400, "only git projects");

  // A capture as captureVisual leaves it: a PNG per page under ~/.dx/visual, and the index.
  const folder = visualFolder(repo);
  fs.mkdirSync(path.join(folder, head), { recursive: true });
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a1e5d1d60000000049454e44ae426082", "hex");
  fs.writeFileSync(path.join(folder, head, "home@desktop.png"), png);
  fs.writeFileSync(path.join(folder, "secret.txt"), "not an image");
  const index = addToVisualIndex(readVisualIndex(repo), {
    commit: head,
    at: new Date().toISOString(),
    captures: [{ name: "home@desktop", path: "/", viewport: "desktop", width: 1280, height: 800, changed: false, ratio: 0 }],
    changed: false,
  }).index;
  fs.writeFileSync(path.join(folder, "index.json"), JSON.stringify(index));

  const listed = (await api(`/api/visual?${q}`)).json;
  assert.equal(listed.commits[0].commit, head);
  assert.equal(listed.commits[0].captures[0].text, "Looks the same");
  const image = await api(`/api/visual/image?${q}&commit=${head}&name=home@desktop`);
  assert.equal(image.status, 200);
  assert.equal(image.json.image, `data:image/png;base64,${png.toString("base64")}`);
  const img = (extra: string) => api(`/api/visual/image?${q}&${extra}`).then((r) => r.status);
  assert.equal(await img(`commit=HEAD&name=home@desktop`), 400, "a commit must be hex");
  assert.equal(await img(`commit=--all&name=home@desktop`), 400);
  assert.equal(await img(`commit=${head}&name=${encodeURIComponent("../secret.txt")}`), 400, "no paths");
  assert.equal(await img(`commit=${head}&name=${encodeURIComponent("..\\..\\config.json")}`), 400, "no Windows paths either");
  assert.equal(await img(`commit=${head}&name=cart@desktop`), 404, "only captures the commit has");
  assert.equal(await img(`commit=${head}&name=home@desktop&kind=diff`), 404, "no diff for a page that didn't change");
  assert.equal(await img(`commit=${head}&kind=thumb`), 404);
  assert.equal(await img(`commit=${head}&name=home@desktop&kind=file`), 400);
  assert.equal(await img(`commit=${"0".repeat(40)}&name=home@desktop`), 404, "a commit that wasn't captured");
  assert.equal((await api(`/api/visual/image?dir=${encodeURIComponent(path.join(root, "nowhere"))}&commit=${head}&name=home@desktop`)).status, 404);

  // The setting.
  assert.equal((await api("/api/config", { method: "POST", body: { visualDiff: false } })).json.visualDiff, false);
  assert.equal((await api(`/api/visual?${q}`)).json.on, false);
  assert.equal((await api("/api/config", { method: "POST", body: { visualDiff: true } })).json.visualDiff, true);
});

test("ask Claude to fix: the error is looked up on the server, the patch is kept there and applied by id", async () => {
  // A git project whose dev server hits an error as it starts, and a fake claude first on PATH.
  const repo = path.join(root, "fix-app");
  fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "octocat@example.com");
  git("config", "user.name", "octocat");
  git("config", "core.autocrlf", "false");
  git("config", "commit.gpgsign", "false");
  const broken = "function total(cart) { return cart.items.length; }\n";
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "fix-app", scripts: { dev: "node server.cjs" } }));
  fs.writeFileSync(path.join(repo, "server.cjs"), `${broken}try { total(undefined); } catch (e) { console.error(e.stack); }\nsetInterval(() => {}, 1000);\n`);
  git("add", ".");
  git("commit", "-q", "-m", "Start");
  const original = fs.readFileSync(path.join(repo, "server.cjs"), "utf8");

  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-web-fake-claude-"));
  const answer = [
    "--- a/server.cjs",
    "+++ b/server.cjs",
    "@@ -1 +1 @@",
    "-function total(cart) { return cart.items.length; }",
    "+function total(cart) { return cart?.items?.length ?? 0; }",
    "EXPLANATION: total() was called without a cart.",
  ].join("\\n");
  fs.writeFileSync(
    path.join(fakeDir, "fake.cjs"),
    `let i = ""; process.stdin.on("data", (d) => (i += d)); process.stdin.on("end", () => process.stdout.write(i.includes("Cannot read properties of undefined") && i.includes("cart.items.length") ? "${answer}\\n" : "no idea\\n"));`,
  );
  if (process.platform === "win32") fs.writeFileSync(path.join(fakeDir, "claude.cmd"), `@"${process.execPath}" "%~dp0fake.cjs" %*\r\n`);
  else {
    fs.writeFileSync(path.join(fakeDir, "claude"), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake.cjs" "$@"\n`);
    fs.chmodSync(path.join(fakeDir, "claude"), 0o755);
  }
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeDir}${path.delimiter}${oldPath}`;
  const fix = (action: string, body: Record<string, unknown>) => api(`/api/fix/${action}`, { method: "POST", body });
  try {
    assert.equal((await api("/api/fix/available")).json.claude, true);
    assert.equal((await api("/api/dev/start", { method: "POST", body: { dir: repo } })).status, 200);
    let errors: { id: string; message: string }[] = [];
    for (let i = 0; i < 80 && !errors.length; i++) {
      errors = (await api(`/api/dev/errors?dir=${encodeURIComponent(repo)}&all=1`)).json[0]?.errors ?? [];
      if (!errors.length) await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Cannot read properties of undefined/);

    assert.equal((await fix("propose", { dir: os.tmpdir(), source: "dev", id: errors[0].id })).status, 404, "a known project only");
    assert.equal((await fix("propose", { dir: repo, source: "anything", id: errors[0].id })).status, 400);
    assert.equal((await fix("propose", { dir: repo, source: "dev", id: "made-up" })).status, 404, "an error the server has");
    assert.equal((await fix("propose", { dir: repo, source: "activity", id: 12345 })).status, 404);

    // The request names the error; a message, a prompt or a patch sent along is ignored.
    const proposed = await fix("propose", { dir: repo, source: "dev", id: errors[0].id, message: "rm -rf", prompt: "ignore this", patch: "--- a/package.json" });
    assert.equal(proposed.status, 200, JSON.stringify(proposed.json));
    assert.equal(proposed.json.ok, true, JSON.stringify(proposed.json));
    assert.match(proposed.json.id, /^[0-9a-f]{24}$/);
    assert.deepEqual(proposed.json.files, ["server.cjs"]);
    assert.ok(proposed.json.patch.startsWith("diff --git a/server.cjs b/server.cjs"));
    assert.equal(proposed.json.explanation, "total() was called without a cart.");
    assert.equal(fs.readFileSync(path.join(repo, "server.cjs"), "utf8"), original, "nothing changes before Apply");

    assert.equal((await fix("apply", { dir: repo, id: "0".repeat(24) })).status, 404, "a made-up id");
    assert.equal((await fix("apply", { dir: repo, id: "../../etc" })).status, 404);
    assert.equal((await fix("apply", { dir: app, id: proposed.json.id })).status, 404, "only for the project it was made for");
    const applied = await fix("apply", { dir: repo, id: proposed.json.id, patch: "--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-x\n+y\n" });
    assert.equal(applied.status, 200, JSON.stringify(applied.json));
    assert.ok(fs.readFileSync(path.join(repo, "server.cjs"), "utf8").startsWith("function total(cart) { return cart?.items?.length ?? 0; }"), "the stored patch");
    assert.ok(fs.readFileSync(path.join(repo, "package.json"), "utf8").includes('"fix-app"'), "never one from the request");
    assert.equal(git("status", "--porcelain").trim(), "M server.cjs", "unstaged, on the Git page's board");
    assert.equal((await fix("apply", { dir: repo, id: proposed.json.id })).status, 404, "applied once, then forgotten");

    // Undo on the Git page brings the file back.
    const undo = (await api(`/api/git/undo?dir=${encodeURIComponent(repo)}`)).json;
    assert.equal(undo.entries[0].id, applied.json.undoId);
    assert.equal((await api("/api/git/action", { method: "POST", body: { dir: repo, action: "undo", id: applied.json.undoId } })).status, 200);
    assert.equal(fs.readFileSync(path.join(repo, "server.cjs"), "utf8"), original);

    // Dismissed proposals can't be applied.
    const again = await fix("propose", { dir: repo, source: "dev", id: errors[0].id });
    assert.equal((await fix("dismiss", { id: again.json.id })).json.ok, true);
    assert.equal((await fix("apply", { dir: repo, id: again.json.id })).status, 404);
    assert.ok(fs.readFileSync(path.join(home, "runs.jsonl"), "utf8").includes("fix-app: applied Claude's fix to 1 file"));
  } finally {
    process.env.PATH = oldPath;
    await api("/api/dev/stop", { method: "POST", body: { dir: repo } });
    for (let i = 0; i < 60; i++) {
      const s = (await api("/api/dev")).json.find((x: { dir: string }) => x.dir === repo);
      if (!s || s.status === "stopped" || s.status === "crashed") break;
      await new Promise((r) => setTimeout(r, 150));
    }
    await api("/api/dev/clear", { method: "POST", body: { dir: repo } });
  }
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

test("the AI lane: the agent's calls and servers; take over only relabels, interrupt stops only the agent's servers", async () => {
  const { recordRun } = await import("@dx/core");
  const waitFor = async (status: string) => {
    let s: any;
    for (let i = 0; i < 80; i++) {
      s = (await api("/api/dev")).json.find((x: { dir: string }) => x.dir === app);
      if (s?.status === status) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(s?.status, status);
    return s;
  };
  recordRun("go", true, "tiny-app started from the dashboard", "web", { project: "tiny-app" }); // not the agent's
  recordRun("mcp.check_url", false, "Checked /boom on tiny-app: 500, 1 server error", "mcp", { project: "tiny-app", ms: 40, args: "project=tiny-app path=/boom" });
  const lane = (await api("/api/ai")).json;
  assert.equal(lane.active, true, "a call in the last few minutes");
  assert.equal(lane.calls.length, 1, "only the agent's MCP calls");
  assert.deepEqual(
    { ...lane.calls[0], at: undefined },
    { at: undefined, tool: "check_url", ok: false, text: "Checked /boom on tiny-app: 500, 1 server error", project: "tiny-app", dir: app, args: "project=tiny-app path=/boom", ms: 40 },
  );
  assert.equal((await api(`/api/ai?dir=${encodeURIComponent(app)}`)).json.calls.length, 1);
  assert.equal((await api(`/api/ai?dir=${encodeURIComponent(path.join(root, "nope"))}`)).status, 404);

  // The agent starts a server; the user takes it over: same process, now labelled theirs.
  await api("/api/dev/start", { method: "POST", body: { dir: app, by: "ai" } });
  const ai = await waitFor("ready");
  assert.equal(ai.startedBy, "ai");
  assert.deepEqual((await api("/api/ai")).json.servers.map((s: { project: string }) => s.project), ["tiny-app"]);
  const taken = await api("/api/dev/takeover", { method: "POST", body: { dir: app } });
  assert.equal(taken.status, 200);
  assert.equal(taken.json.startedBy, "dashboard");
  assert.equal(taken.json.pid, ai.pid, "the same process keeps running");
  assert.equal((await api("/api/dev/takeover", { method: "POST", body: { dir: app } })).status, 409, "not the agent's any more");
  assert.equal((await api("/api/dev/takeover", { method: "POST", body: { dir: path.join(root, "nope") } })).status, 404);

  // Interrupt leaves the user's server alone…
  assert.deepEqual((await api("/api/ai/interrupt", { method: "POST", body: {} })).json, { stopped: [] });
  assert.equal((await waitFor("ready")).pid, ai.pid);
  await api("/api/dev/stop", { method: "POST", body: { dir: app } });
  await waitFor("stopped");
  await api("/api/dev/clear", { method: "POST", body: { dir: app } });

  // …and stops the agent's, only those named when names are sent.
  await api("/api/dev/start", { method: "POST", body: { dir: app, by: "ai" } });
  await waitFor("ready");
  assert.equal((await api("/api/ai/interrupt", { method: "POST", body: { dirs: "all" } })).status, 400);
  assert.deepEqual((await api("/api/ai/interrupt", { method: "POST", body: { dirs: [path.join(root, "other")] } })).json, { stopped: [] });
  assert.deepEqual((await api("/api/ai/interrupt", { method: "POST", body: { dirs: [app] } })).json, { stopped: ["tiny-app"] });
  await waitFor("stopped");
  const after = (await api("/api/ai")).json;
  assert.deepEqual(after.servers, []);
  assert.deepEqual(after.interrupted.stopped, ["tiny-app"]);
  await api("/api/dev/clear", { method: "POST", body: { dir: app } });
});

test("your year as a story: built here, a year in range, saved under ~/.dx/summaries", async () => {
  const year = new Date().getFullYear();
  const r = await api(`/api/summary/story?year=3000&github=0`);
  assert.equal(r.status, 200);
  assert.equal(r.json.year, year, "a year to come is today's year");
  assert.equal(r.json.story.heat.length, 7);
  assert.equal(r.json.story.heat[0].length, 24);
  assert.ok(r.json.markdown.startsWith(`# ${year} in review`));
  assert.equal(r.json.summary, undefined, "not every commit of the year");
  const saved = await api("/api/summary/story/save", { method: "POST", body: { year, github: false } });
  assert.equal(saved.status, 200);
  assert.ok(fs.existsSync(path.join(home, "summaries", `${year}-in-review.md`)));
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

test("run any commit: search, a snapshot on its own port next to the project, and removal, only for known projects and commits", async () => {
  const repo = path.join(root, "snap-app");
  fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "octocat@example.com");
  git("config", "user.name", "octocat");
  git("config", "core.autocrlf", "false");
  git("config", "commit.gpgsign", "false");
  // Listens on PORT (what dx gives a snapshot whose tool it can't move by flag) and says where.
  const server = (v: string) =>
    `const s = require("http").createServer((q, r) => r.end("version ${v}")).listen(Number(process.env.PORT) || 0, "127.0.0.1", () => console.log("  Local: http://localhost:" + s.address().port + "/"));`;
  fs.writeFileSync(path.join(repo, ".devrc.json"), JSON.stringify({ dev: "node server.cjs" }));
  fs.writeFileSync(path.join(repo, "server.cjs"), server("1"));
  git("add", ".");
  git("commit", "-q", "-m", "Version one");
  const v1 = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "server.cjs"), server("2"));
  git("commit", "-q", "-am", "Version two");
  const v2 = git("rev-parse", "HEAD");
  const q = `dir=${encodeURIComponent(repo)}`;

  const found = await api(`/api/git/search?${q}&q=version`);
  assert.equal(found.status, 200);
  assert.deepEqual(found.json.map((c: { hash: string }) => c.hash), [v2, v1]);
  assert.equal((await api(`/api/git/search?dir=${encodeURIComponent(os.tmpdir())}&q=x`)).status, 404, "only known projects");
  const at = await api(`/api/git/at?${q}&at=${Date.now() + 1000}`);
  assert.equal(at.json.hash, v2, "time travel: where HEAD was");
  assert.equal((await api(`/api/git/at?${q}`)).status, 400);

  const run = (body: unknown) => api("/api/snapshots/run", { method: "POST", body });
  assert.equal((await run({ dir: os.tmpdir(), hash: v1 })).status, 404, "an unknown project");
  assert.equal((await run({ dir: repo, hash: "--all" })).status, 400, "not a hash");
  assert.equal((await run({ dir: repo, hash: "HEAD" })).status, 400, "names aren't taken, only hashes");
  assert.equal((await run({ dir: repo, hash: "deadbeef" })).status, 404, "a hash that doesn't resolve");
  const unregistered = path.join(home, "snapshots", `snap-app-${v1.slice(0, 7)}`);
  assert.equal((await api("/api/dev/start", { method: "POST", body: { dir: unregistered } })).status, 404, "not a project before it's registered");

  // The project's own dev server, and the old commit beside it.
  assert.equal((await api("/api/dev/start", { method: "POST", body: { dir: repo } })).status, 200);
  const started = await run({ dir: repo, hash: v1.slice(0, 7) });
  assert.equal(started.status, 200);
  assert.equal(started.json.name, `snap-app@${v1.slice(0, 7)}`);
  let snap: any;
  for (let i = 0; i < 100; i++) {
    snap = (await api(`/api/snapshots?${q}`)).json.find((s: { id: string }) => s.id === started.json.id);
    if (snap?.dev?.status === "ready" || snap?.job?.phase === "failed") break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal(snap?.dev?.status, "ready", JSON.stringify(snap));
  assert.equal(snap.dev.snapshot, true);
  assert.equal(snap.dir, unregistered);
  let own: any;
  for (let i = 0; i < 60; i++) {
    own = (await api("/api/dev")).json.find((s: { dir: string }) => s.dir === repo);
    if (own?.status === "ready") break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.notEqual(own.url, snap.dev.url, "each on its own port");
  assert.equal(await (await fetch(snap.dev.url)).text(), "version 1", "the snapshot serves the old commit");
  assert.equal(await (await fetch(own.url)).text(), "version 2", "the project serves its working copy");
  assert.equal(fs.readFileSync(path.join(repo, "server.cjs"), "utf8"), server("2"), "the working copy isn't touched");

  // A registered snapshot is a known project for running and reading, not for git or files.
  assert.equal((await api(`/api/dev/logs?dir=${encodeURIComponent(snap.dir)}&after=0`)).json.lines.length > 0, true);
  assert.equal((await api(`/api/git/graph?dir=${encodeURIComponent(snap.dir)}`)).status, 404, "git actions don't take a snapshot");
  assert.equal((await api(`/api/env/project?dir=${encodeURIComponent(snap.dir)}`)).status, 404);

  assert.equal((await api("/api/snapshots/remove", { method: "POST", body: { id: "nope-1234567" } })).status, 404);
  assert.equal((await api("/api/snapshots/remove", { method: "POST", body: {} })).status, 400);
  const removed = await api("/api/snapshots/remove", { method: "POST", body: { id: snap.id } });
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  assert.equal(fs.existsSync(snap.dir), false, "its folder is deleted");
  assert.equal((await api("/api/dev")).json.some((s: { dir: string }) => s.dir === snap.dir), false, "its server is stopped and gone");
  assert.equal((await api("/api/dev/start", { method: "POST", body: { dir: snap.dir } })).status, 404, "not a project once removed");
  assert.equal(fs.existsSync(path.join(repo, "server.cjs")), true);

  await api("/api/dev/stop", { method: "POST", body: { dir: repo } });
  for (let i = 0; i < 60; i++) {
    const s = (await api("/api/dev")).json.find((x: { dir: string }) => x.dir === repo);
    if (s?.status !== "ready" && s?.status !== "starting") break;
    await new Promise((r) => setTimeout(r, 150));
  }
  await api("/api/dev/clear", { method: "POST", body: { dir: repo } });
});

test("recorded sites and the dx browser: sites are validated, addresses must be http(s), and events show by site and environment", async () => {
  const { appendActivity, siteDir, findBrowser } = await import("@dx/core");
  const { browserTargetFor } = await import("../dxbrowser.js");
  const add = (body: unknown) => api("/api/sites/add", { method: "POST", body });
  assert.equal((await add({ host: "staging.shop-website.dev/cart" })).status, 400, "no path");
  assert.equal((await add({ host: "*" })).status, 400);
  assert.equal((await add({ host: "staging.shop-website.dev", dir: os.tmpdir() })).status, 404, "only a known project");
  const added = await add({ host: "Staging.Shop-Website.dev", dir: app, env: "staging" });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  assert.equal(added.json.host, "staging.shop-website.dev");
  assert.equal(added.json.projectName, "tiny-app");
  assert.equal((await add({ host: "shop-website.dev" })).json.env, "production", "guessed from the name");
  assert.deepEqual((await api("/api/sites")).json.map((s: { host: string }) => s.host), ["staging.shop-website.dev", "shop-website.dev"]);

  // Only recorded sites and this computer; never the dashboard itself.
  assert.equal(browserTargetFor("https://staging.shop-website.dev/cart")?.dir, app);
  assert.equal(browserTargetFor("https://shop-website.dev/")?.dir, siteDir("shop-website.dev"));
  assert.equal(browserTargetFor("https://news.example.org/"), undefined);
  assert.equal(browserTargetFor(`http://127.0.0.1:${dashboard.port}/api/projects`), undefined);
  assert.equal(browserTargetFor("http://dx.localhost/"), undefined);

  const open = (body: unknown) => api("/api/browser/open", { method: "POST", body });
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "chrome://settings", "https://user:pw@shop-website.dev/"]) {
    assert.equal((await open({ url })).status, 400, url);
  }
  assert.equal((await api("/api/browser")).json.open, false);

  // What the dx browser wrote: a linked site under its project, an unlinked one on its own.
  const at = new Date().toISOString();
  appendActivity([
    { id: Date.now() * 1000, at, dir: app, project: "tiny-app", type: "error", text: "TypeError: boom", from: "dx-browser", site: "staging.shop-website.dev", env: "staging" },
    { id: Date.now() * 1000 + 1, at, dir: siteDir("shop-website.dev"), project: "shop-website.dev", type: "request", text: "GET /api/cart → 200", from: "dx-browser", site: "shop-website.dev", env: "production", status: 200 },
  ]);
  const own = await api("/api/activity?site=shop-website.dev&since=1h");
  assert.deepEqual(own.json.map((e: { text: string }) => e.text), ["GET /api/cart → 200"]);
  assert.equal((await api(`/api/activity?dir=${encodeURIComponent(app)}&env=staging&since=1h`)).json.length, 1);
  assert.equal((await api(`/api/activity?dir=${encodeURIComponent(app)}&env=production&since=1h`)).json.length, 0);
  assert.equal((await api("/api/activity?host=staging.shop-website.dev&since=1h")).json.length, 1);
  assert.equal((await api("/api/activity?site=bad/host")).status, 400);
  const overview = await api("/api/activity/overview?since=1h");
  const entry = overview.json.entries.find((e: { dir: string }) => e.dir === app);
  assert.equal(entry.envs.staging.problems, 1);
  assert.ok(overview.json.entries.some((e: { dir: string }) => e.dir === siteDir("shop-website.dev")));
  assert.equal(overview.json.sites.length, 2);
  assert.equal(typeof overview.json.browser.open, "boolean");
  const report = await api(`/api/activity/report?site=shop-website.dev&id=${own.json[0].id}`);
  assert.equal(report.status, 200);
  assert.equal((await api("/api/activity/clear", { method: "POST", body: { site: "shop-website.dev" } })).status, 200);
  assert.equal((await api("/api/activity?site=shop-website.dev&since=1h")).json.length, 0);

  assert.equal((await api("/api/sites/remove", { method: "POST", body: { host: "shop-website.dev" } })).status, 200);
  assert.equal((await api("/api/sites/remove", { method: "POST", body: { host: "shop-website.dev" } })).status, 404);
  const runs = fs.readFileSync(path.join(home, "runs.jsonl"), "utf8");
  assert.ok(runs.includes("recording staging.shop-website.dev (staging) for tiny-app"));
  assert.ok(!runs.includes(dashboard.token), "never the token");

  // The real browser, headless, through the dashboard: a local page recorded as a staging site.
  if (!findBrowser()) return;
  const page = http.createServer((req, res) => {
    if (req.url === "/api/order") {
      res.writeHead(201, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: 7, token: "t0k" }));
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Staging</title><script>fetch("/api/order", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ qty: 1, password: "p" }) }).then(() => console.error("order failed"));</script>`);
  });
  await new Promise<void>((r) => page.listen(0, "127.0.0.1", r));
  const host = `127.0.0.1:${(page.address() as { port: number }).port}`;
  process.env.DX_BROWSER_HEADLESS = "1";
  try {
    assert.equal((await add({ host, dir: app, env: "staging" })).status, 200);
    const opened = await open({ url: `http://${host}/?token=abc` });
    assert.equal(opened.status, 200, JSON.stringify(opened.json));
    assert.equal(opened.json.open, true);
    let list: any[] = [];
    for (let i = 0; i < 100; i++) {
      list = (await api(`/api/activity?host=${encodeURIComponent(host)}&since=1h`)).json;
      if (list.some((e) => e.type === "request") && list.some((e) => e.type === "console")) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const req = list.find((e) => e.type === "request");
    assert.equal(req?.requestBody, JSON.stringify({ qty: 1, password: "•••" }));
    assert.equal(req?.responseBody, JSON.stringify({ id: 7, token: "•••" }));
    assert.equal(req?.dir, app);
    assert.equal(list.find((e) => e.type === "console")?.text, "order failed");
    assert.equal(list.find((e) => e.type === "page")?.url, "/?token=•••", "masked in the address too");
    const after = fs.readFileSync(path.join(home, "runs.jsonl"), "utf8");
    assert.ok(after.includes(`opened at ${host}`));
    assert.ok(!after.includes("token=abc"), "the address isn't logged, only its host");
    assert.equal((await api("/api/browser/close", { method: "POST" })).json.open, false);
  } finally {
    delete process.env.DX_BROWSER_HEADLESS;
    await api("/api/browser/close", { method: "POST" });
    page.close();
  }
});
