import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-autonomy-web-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-autonomy-web-root-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", localDomainsPort: 0, autoConnectAi: false }));

function project(name: string, files: Record<string, string>): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
  const run = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "octocat@example.com");
  run("config", "user.name", "octocat");
  return dir;
}
const shop = project("shop-website", { "package.json": JSON.stringify({ name: "shop-website" }), ".env": "SECRET=1\n" });
const notes = project("notes", { "a.txt": "1\n" });

const { startDashboard } = await import("../server.js");
const { autoSetupTick, propose, listProposals } = await import("@dx/core");
let dashboard: Awaited<ReturnType<typeof startDashboard>>;
before(async () => {
  dashboard = await startDashboard({ port: 0, localDomainPorts: false });
});
after(async () => {
  await dashboard.close();
});

async function api(p: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(new URL(p, dashboard.url), {
    method: init.method ?? "GET",
    headers: { "X-DX-Token": dashboard.token, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as any };
}

test("how much dx does is listed with its level, set through the page, and listed as a change with Undo", async () => {
  const state = await api("/api/autonomy");
  assert.deepEqual(state.json.capabilities.map((c: { id: string }) => c.id), ["gitignore-rules", "claude-setup", "git-fetch", "weekly-summary"]);
  assert.ok(state.json.capabilities.every((c: { level: string; default: string }) => c.level === c.default));

  const set = await api("/api/autonomy", { method: "POST", body: { id: "git-fetch", level: "ask" } });
  assert.deepEqual([set.json.level, set.json.previous], ["ask", "do"]);
  assert.equal((await api("/api/autonomy")).json.capabilities.find((c: { id: string }) => c.id === "git-fetch").level, "ask");
  const change = (await api("/api/changes")).json.changes.find((c: { kind: string }) => c.kind === "autonomy");
  assert.match(change.what, /asks first about: fetching remotes/);
  assert.equal(change.undoable, true);
  await api("/api/undo", { method: "POST", body: { id: change.id } });
  assert.equal((await api("/api/autonomy")).json.capabilities.find((c: { id: string }) => c.id === "git-fetch").level, "do");

  assert.equal((await api("/api/autonomy", { method: "POST", body: { id: "git-fetch", level: "always" } })).status, 400);
  assert.equal((await api("/api/autonomy", { method: "POST", body: { id: "delete-everything", level: "do" } })).status, 404);
});

test("a question dx was told to ask is answered through the page: yes does it and lists it, not now puts it off", async () => {
  await api("/api/autonomy", { method: "POST", body: { id: "gitignore-rules", level: "ask" } });
  await autoSetupTick([{ dir: notes, name: "notes" }]); // the first look only remembers
  await autoSetupTick([{ dir: shop, name: "shop-website" }]);
  assert.equal(fs.existsSync(path.join(shop, ".gitignore")), false, "nothing written while it waits");

  const open = (await api("/api/proposals")).json.proposals.find((p: { capability: string }) => p.capability === "gitignore-rules");
  assert.ok(open, "waiting for you");
  assert.equal(open.level, "ask");
  assert.equal(JSON.stringify(open).includes(shop), false, "the page isn't told a folder");
  assert.equal((await api("/api/home")).json.proposals.some((p: { id: string }) => p.id === open.id), true, "Home lists it");

  const yes = await api("/api/proposals/resolve", { method: "POST", body: { id: open.id, approve: true } });
  assert.match(yes.json.message, /Added \d+ rules? to \.gitignore/);
  assert.match(fs.readFileSync(path.join(shop, ".gitignore"), "utf8"), /\.env/);
  const change = (await api("/api/changes")).json.changes.find((c: { kind: string }) => c.kind === "gitignore");
  assert.equal(change.by, "dx");
  assert.equal(change.undoable, true);
  assert.equal((await api("/api/proposals/resolve", { method: "POST", body: { id: open.id, approve: true } })).status, 404, "answered once");

  const second = propose({ capability: "claude-setup", level: "ask", project: "notes", dir: notes, what: "Point notes at dx", action: { kind: "claude-setup", data: { dir: notes } } })!;
  assert.deepEqual((await api("/api/proposals/resolve", { method: "POST", body: { id: second.id, approve: false } })).json.ok, true);
  assert.equal(listProposals().length, 0);
  assert.equal(propose({ capability: "claude-setup", level: "ask", dir: notes, what: "again", action: second.action }), undefined, "put off for a day");
  await api("/api/autonomy", { method: "POST", body: { id: "gitignore-rules", level: "do" } });
});

test("a proposal for a project that has gone is refused, and stays for another try", async () => {
  const gone = propose({ capability: "claude-setup", level: "ask", project: "gone", dir: path.join(root, "gone"), what: "Point gone at dx", action: { kind: "claude-setup", data: { dir: path.join(root, "gone") } } })!;
  const r = await api("/api/proposals/resolve", { method: "POST", body: { id: gone.id, approve: true } });
  assert.equal(r.status, 404);
  assert.match(r.json.error, /isn't in your projects folders/);
  assert.equal(listProposals().some((p) => p.capability === "claude-setup" && p.dir === path.join(root, "gone")), true, "still there to put off");
});

test("what an AI tool changes through dx is listed as the agent's, from its header", async () => {
  await api("/api/env/gitignore", { method: "POST", body: { dir: notes, patterns: [".env"] }, headers: { "X-DX-Actor": "ai" } });
  await api("/api/env/file", { method: "POST", body: { dir: shop, name: ".env", content: "SECRET=2\n" } });
  const list = (await api("/api/changes")).json.changes;
  assert.equal(list.find((c: { kind: string; project?: string }) => c.kind === "gitignore" && c.project === "notes").by, "ai");
  assert.equal(list.find((c: { kind: string }) => c.kind === "env-file").by, "you");
  const bogus = await api("/api/env/gitignore", { method: "POST", body: { dir: notes, patterns: [".env"] }, headers: { "X-DX-Actor": "root" } });
  assert.equal(bogus.status, 200, "an unknown label is just you");
});

test("what a commit message would send is counted without sending anything", async () => {
  const none = await api("/api/git/suggest/preview", { method: "POST", body: { dir: notes } });
  assert.equal(none.status, 400);
  assert.match(none.json.error, /Nothing is staged/);
  fs.writeFileSync(path.join(notes, "a.txt"), "2\n");
  execFileSync("git", ["add", "a.txt"], { cwd: notes, stdio: "ignore" });
  const r = await api("/api/git/suggest/preview", { method: "POST", body: { dir: notes } });
  assert.equal(r.status, 200);
  assert.equal(r.json.sent.length, 3);
  assert.equal(r.json.bytes, r.json.sent.reduce((n: number, s: { bytes: number }) => n + s.bytes, 0));
  assert.deepEqual(r.json.never, [".env files", "keys and certificates", "lock files"]);
  assert.match(r.json.only, /when you press Send/);
  assert.equal((await api("/api/ai/uses")).json.uses.length, 0, "a preview isn't a use: nothing was sent");
  assert.equal((await api("/api/fix/preview", { method: "POST", body: { dir: notes, source: "elsewhere", id: "x" } })).status, 400);
});
