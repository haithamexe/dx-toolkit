import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// dx's state on another computer: two made-up computers, each its own dx home and projects folder,
// switched with DX_HOME. Export on one, import on the other, then undo. Nothing real is touched.
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const homeA = tmp("dx-state-a-");
const homeB = tmp("dx-state-b-");
const rootA = tmp("dx-state-projects-a-");
const rootB = tmp("dx-state-projects-b-");
process.env.DX_HOME = homeA;
const core = await import("../index.js");
const { remoteKey, mergeJournalText, parseJournal, exportState, readState, planStateImport, importState, undoStateImport, lastStateImport, scanProjects, loadConfig, saveConfig, saveTool, loadTools, saveMocks, loadMocks, putRule, loadRules, saveSpec, loadSpec, setChaos, loadChaos, saveScene, listScenes, leaveNote, readSession, addSite, addJournalEntry, journalPath, summariesDir, StateError } = core;

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
function makeProject(root: string, name: string, remote?: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, scripts: { dev: "node server.js" } }));
  if (remote) {
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", remote);
  }
  return dir;
}
function useComputer(home: string, root: string) {
  process.env.DX_HOME = home;
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false }));
}

test("a remote is named host/owner/repo, never with a user or password; one on this computer has no name", () => {
  assert.equal(remoteKey("https://octocat:secret-token@github.com/Octocat/Shop-Website.git"), "github.com/octocat/shop-website");
  assert.equal(remoteKey("git@github.com:octocat/shop-website.git"), "github.com/octocat/shop-website");
  assert.equal(remoteKey("ssh://git@gitlab.example.com/team/api-gateway"), "gitlab.example.com/team/api-gateway");
  assert.equal(remoteKey("file:///srv/git/shop.git"), undefined);
  assert.equal(remoteKey("../shop.git"), undefined);
});

test("journal entries from elsewhere slot in under their day, in time order, and nothing written by hand moves", () => {
  const text = "# Work journal\n\nSome notes I wrote by hand.\n\n## 2026-11-02\n- 09:00 started the cart\n- 17:00 cart done\n\n## 2026-11-05\n- 10:00 checkout\n";
  const { text: out, added } = mergeJournalText(text, [
    { date: "2026-11-02", time: "12:30", text: "lunch fix" },
    { date: "2026-11-02", time: "09:00", text: "started the cart" },
    { date: "2026-11-03", time: "08:00", text: "a new day" },
    { date: "2026-11-06", time: "", text: "the newest" },
  ]);
  assert.equal(added, 3);
  assert.ok(out.includes("Some notes I wrote by hand."));
  assert.deepEqual(
    parseJournal(out).map((e) => `${e.date} ${e.time} ${e.text}`),
    ["2026-11-02 09:00 started the cart", "2026-11-02 12:30 lunch fix", "2026-11-02 17:00 cart done", "2026-11-03 08:00 a new day", "2026-11-05 10:00 checkout", "2026-11-06  the newest"],
  );
  assert.equal(mergeJournalText(out, parseJournal(out)).added, 0, "nothing twice");
  assert.ok(mergeJournalText("", [{ date: "2026-11-01", time: "09:00", text: "first" }]).text.startsWith("# Work journal"));
});

test("everything dx keeps goes from one computer to another, matched by remote or name, the file winning; undo puts it all back", async () => {
  // Computer A: a project with a remote (with a password in it) and one without git, each with things kept.
  useComputer(homeA, rootA);
  const shopA = makeProject(rootA, "shop-website", "https://octocat:secret-token@github.com/octocat/shop-website.git");
  const todoA = makeProject(rootA, "todo-app");
  const configA = loadConfig();
  configA.editor = "cursor";
  configA.activityDays = 3;
  configA.projectAlerts = { [path.resolve(shopA).toLowerCase()]: { osOff: true } };
  saveConfig(configA);
  saveTool(shopA, { name: "Failed orders", kind: "view", source: { request: { method: "GET", path: "/api/orders" } }, steps: [{ get: "orders" }, { filter: { field: "status", is: "failed" } }], display: { as: "table" } });
  const mocks = loadMocks(shopA, "shop-website");
  mocks.on = true;
  mocks.endpoints = [{ id: "a1b2c3d4e5", method: "GET", path: "/api/orders", status: 200, delayMs: 0, contentType: "application/json", body: '{"orders":[]}', enabled: true, recorded: { status: 200, contentType: "application/json", body: '{"orders":[]}', at: "2026-11-01T00:00:00.000Z", eventId: 1 }, updatedAt: "2026-11-01T00:00:00.000Z" }];
  saveMocks(mocks);
  putRule(shopA, "shop-website", { name: "Slow orders", method: "GET", path: "/api/orders", delayMs: 2000 });
  saveSpec(shopA, "pasted", { openapi: "3.0.0", info: { title: "Shop" }, paths: { "/api/orders": { get: { responses: { 200: { description: "ok" } } } } } });
  setChaos(shopA, "shop-website", { on: true, level: "blackfriday" });
  saveScene(shopA, { format: "dx-scene", version: 1, name: "Big customer", kind: "made", createdAt: "2026-11-01T00:00:00.000Z", order: ["users"], rows: { users: [{ id: 1, email: "ada@example.com" }] } });
  saveScene(shopA, { format: "dx-scene", version: 1, name: "Backup before", kind: "backup", createdAt: "2026-11-01T00:00:00.000Z", order: ["users"], rows: { users: [{ id: 9, email: "real@example.com" }] } });
  leaveNote(todoA, "todo-app", "Next: the filters", "you");
  addSite({ host: "shop-website.example.com", project: shopA, env: "production" });
  addSite({ host: "docs.example.com" });
  addJournalEntry("cart done", new Date(2026, 10, 2, 17, 0));
  fs.mkdirSync(summariesDir(), { recursive: true });
  fs.writeFileSync(path.join(summariesDir(), "2026-11-01.md"), "# Week\n");
  fs.mkdirSync(path.join(homeA, "templates", "starter", "src"), { recursive: true });
  fs.writeFileSync(path.join(homeA, "templates", "starter", "src", "index.js"), "console.log('{{name}}')\n");
  fs.mkdirSync(path.join(homeA, "templates", "starter", "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(homeA, "templates", "starter", "node_modules", "x", "big.js"), "left out");

  const state = await exportState({ projects: scanProjects(loadConfig()), page: { theme: "dark", project: shopA, activitySel: `p:${shopA}` } });
  const text = JSON.stringify(state);
  assert.ok(!text.includes("secret-token"), "never a password from a remote");
  assert.ok(!text.toLowerCase().includes(rootA.toLowerCase().replace(/\\/g, "\\\\")) && !text.toLowerCase().includes(rootA.toLowerCase()), "never a path of this computer");
  assert.ok(!text.includes("real@example.com"), "backup scenes stay behind");
  assert.deepEqual(state.templates.map((t) => [t.name, t.files.map((f) => f.path)]), [["starter", ["src/index.js"]]], "a template's node_modules stays behind");
  assert.deepEqual(state.page, { theme: "dark" }, "only preferences that hold no path");
  const shop = state.projects.find((p) => p.name === "shop-website")!;
  assert.equal(shop.remote, "github.com/octocat/shop-website");
  assert.equal(shop.mocks!.endpoints.length, 1);
  assert.ok(!("on" in (shop.chaos ?? {})), "Chaos mode's switch is this computer's");
  assert.deepEqual(shop.sites, [{ host: "shop-website.example.com", env: "production" }]);
  assert.equal(state.sites.length, 1);

  // Computer B: the same repository at another path (its remote without a password), and a todo-app by name.
  useComputer(homeB, rootB);
  const shopB = makeProject(rootB, "shop", "git@github.com:octocat/shop-website.git");
  const todoB = makeProject(rootB, "todo-app");
  makeProject(rootB, "other-shop", "https://github.com/someone-else/shop-website.git");
  addJournalEntry("home entry", new Date(2026, 10, 1, 20, 0));
  const journalBefore = fs.readFileSync(journalPath(), "utf8");
  const read = readState(text);
  const plan = await planStateImport(read, scanProjects(loadConfig()));
  const match = (name: string) => plan.projects.find((p) => p.name === name)!.match;
  assert.equal(match("shop-website")?.by, "remote");
  assert.equal(path.resolve(match("shop-website")!.dir), path.resolve(shopB));
  assert.equal(match("todo-app")?.by, "name");
  assert.deepEqual(plan.settings.map((s) => s.key).sort(), ["activityDays", "editor"]);
  assert.equal(plan.journal.adds, 1);
  assert.deepEqual(plan.templates, [{ name: "starter", status: "new" }]);

  const r = await importState(read, { projects: scanProjects(loadConfig()) });
  assert.match(r.backup, /\.json$/);
  assert.deepEqual(r.skipped, []);
  assert.equal(loadTools(shopB)[0].name, "Failed orders");
  assert.equal(loadMocks(shopB).endpoints[0].id, "a1b2c3d4e5");
  assert.equal(loadMocks(shopB).on, false, "mock mode stays switched as it was here");
  assert.equal(loadRules(shopB).rules[0].name, "Slow orders");
  assert.equal(loadSpec(shopB)?.source, "pasted");
  assert.equal(loadChaos(shopB).level, "blackfriday");
  assert.equal(loadChaos(shopB).on, false);
  assert.deepEqual(listScenes(shopB).map((s) => s.name), ["Big customer"]);
  assert.equal(readSession(todoB)?.note, "Next: the filters");
  const configB = loadConfig();
  assert.equal(configB.editor, "cursor");
  assert.equal(configB.activityDays, 3);
  assert.deepEqual(configB.projectAlerts?.[path.resolve(shopB).toLowerCase()], { osOff: true });
  assert.equal(path.resolve(configB.sites!.find((s) => s.host === "shop-website.example.com")!.project!), path.resolve(shopB));
  assert.ok(fs.readFileSync(journalPath(), "utf8").includes("cart done") && fs.readFileSync(journalPath(), "utf8").includes("home entry"));
  assert.equal(fs.readFileSync(path.join(homeB, "templates", "starter", "src", "index.js"), "utf8"), "console.log('{{name}}')\n");
  assert.equal(fs.readFileSync(path.join(summariesDir(), "2026-11-01.md"), "utf8"), "# Week\n");
  assert.deepEqual(r.page, { theme: "dark" });

  // Undo: every file as it was, the new ones gone.
  assert.ok(lastStateImport());
  undoStateImport();
  assert.deepEqual(loadTools(shopB), []);
  assert.deepEqual(loadMocks(shopB).endpoints, []);
  assert.equal(loadSpec(shopB), undefined);
  assert.deepEqual(listScenes(shopB), []);
  assert.equal(readSession(todoB)?.note, undefined);
  assert.equal(loadConfig().editor, "code");
  assert.equal(loadConfig().sites, undefined);
  assert.equal(fs.readFileSync(journalPath(), "utf8"), journalBefore);
  assert.ok(!fs.existsSync(path.join(homeB, "templates", "starter", "src", "index.js")));
  assert.equal(lastStateImport(), undefined, "nothing left to undo");
  assert.throws(() => undoStateImport(), StateError);
});

test("a state file is read strictly: unknown fields, code in a tool, odd paths and commands are refused or left out", () => {
  const base = { format: "dx-state", version: 1, exportedAt: "2026-11-01T00:00:00.000Z", settings: {}, sites: [], journal: [], summaries: [], templates: [], projects: [] };
  const bad = (v: unknown, message: RegExp) => assert.throws(() => readState(JSON.stringify(v)), (e: Error) => e instanceof StateError && message.test(e.message));
  bad({ ...base, format: "dx-tools" }, /isn't a dx state file/);
  bad({ ...base, version: 2 }, /newer dx/);
  bad({ ...base, token: "x" }, /"token", which isn't something/);
  bad({ ...base, projects: [{ name: "shop", tools: [{ name: "x", kind: "view", source: { request: { method: "GET", path: "/" } }, code: "alert(1)" }] }] }, /tool 1/);
  bad({ ...base, projects: [{ name: "shop", dir: "C:\\x" }] }, /"dir", which isn't something/);
  bad({ ...base, projects: [{ name: "shop", remote: "https://octocat:pw@github.com/octocat/shop" }] }, /host\/owner\/repo/);
  bad({ ...base, projects: [{ name: "shop", mocks: { endpoints: [{ id: "abcdef12", method: "GET", path: "/x", status: 900, contentType: "application/json", body: "" }] } }] }, /status/);
  bad({ ...base, projects: [{ name: "shop", spec: { source: "file:../../secret.yaml", doc: { openapi: "3.0.0", paths: {} } } }] }, /source/);
  bad({ ...base, templates: [{ name: "starter", files: [{ path: "../../evil.js", data: "" }] }] }, /won't write/);
  bad({ ...base, templates: [{ name: "starter", files: [{ path: ".git/config", data: "" }] }] }, /won't write/);
  bad({ ...base, summaries: [{ name: "../x.md", text: "" }] }, /summary/);
  const s = readState(JSON.stringify({ ...base, settings: { editor: "calc.exe & del", projectsRoots: ["C:\\Users\\octocat\\code", "~/code", "~/../etc"], scanDepth: 99, envAlerts: false }, page: { theme: "dark", project: "C:\\x" } }));
  assert.deepEqual(s.settings, { envAlerts: false, projectsRoots: ["~/code"] }, "an unknown editor command, a path outside home and odd numbers are left out");
  assert.deepEqual(s.page, { theme: "dark" });
});

test("a file never says where dx writes, two clones of one repository don't both land on the one here, and an import that stops part-way is put back", async () => {
  const base = { format: "dx-state", version: 1, exportedAt: "2026-11-01T00:00:00.000Z", settings: {}, sites: [], journal: [], summaries: [], templates: [], projects: [] };
  const s = readState(JSON.stringify({ ...base, settings: { templatesDir: "~/.config" } }));
  assert.equal((s.settings as Record<string, unknown>).templatesDir, undefined, "the templates folder isn't a setting a file can bring");

  const { matchProjects } = core;
  const local = [{ name: "shop", dir: "/x/shop" }] as Parameters<typeof matchProjects>[1];
  const remotes = new Map([["/x/shop", "github.com/octocat/shop"]]);
  const two = readState(JSON.stringify({ ...base, projects: [{ name: "shop-hotfix", remote: "github.com/octocat/shop", note: { text: "a", by: "you", at: "2026-11-01T00:00:00.000Z" } }, { name: "shop", remote: "github.com/octocat/shop", note: { text: "b", by: "you", at: "2026-11-01T00:00:00.000Z" } }] }));
  assert.deepEqual(matchProjects(two, local, remotes).map((m) => m?.name), [undefined, "shop"]);
  const one = readState(JSON.stringify({ ...base, projects: [{ name: "shop-at-work", remote: "github.com/octocat/shop", note: { text: "a", by: "you", at: "2026-11-01T00:00:00.000Z" } }] }));
  assert.deepEqual(matchProjects(one, local, remotes).map((m) => m?.by), ["remote"], "a lone clone under another name is still found");

  useComputer(homeB, rootB);
  const before = lastStateImport();
  const tools = loadTools(path.join(rootB, "todo-app")).length;
  const broken = readState(JSON.stringify({ ...base, projects: [{ name: "todo-app", tools: [{ name: "Ping", kind: "view", source: { request: { method: "GET", path: "/" } } }] }], templates: [{ name: "clash", files: [{ path: "a", data: "" }, { path: "a/b", data: "" }] }] }));
  await assert.rejects(importState(broken, { projects: scanProjects(loadConfig()) }), (e: Error) => e instanceof StateError && /Nothing was imported/.test(e.message));
  assert.equal(loadTools(path.join(rootB, "todo-app")).length, tools, "what it wrote went back");
  assert.ok(!fs.existsSync(path.join(homeB, "templates", "clash", "a")));
  assert.deepEqual(lastStateImport(), before, "and it left nothing to undo");
});

test("an imported journal entry doesn't land between an entry and the lines under it; the reflog reader finds each commit", () => {
  const text = "## 2026-11-02\n- 09:14 fixed X\n  - details of X\n- 11:00 lunch\n";
  const out = mergeJournalText(text, [{ date: "2026-11-02", time: "10:00", text: "meeting" }]).text;
  assert.equal(out, "## 2026-11-02\n- 09:14 fixed X\n  - details of X\n- 10:00 meeting\n- 11:00 lunch\n");

  const { commitsInReflog } = core;
  const file = path.join(tmp("dx-reflog-"), "HEAD");
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const c = "c".repeat(40);
  const first = `0000000000000000000000000000000000000000 ${a} octocat <octocat@example.com> 1 +0000\tcommit (initial): start\n`;
  fs.writeFileSync(file, first + `${a} ${b} octocat <octocat@example.com> 2 +0000\tcommit: add .env\n${b} ${c} octocat <octocat@example.com> 3 +0000\trebase (finish): returning to refs/heads/main\n${c} ${a} octocat <octocat@example.com> 4 +0000\tcheckout: moving from main to old\n`);
  assert.deepEqual(commitsInReflog(file, Buffer.byteLength(first), fs.statSync(file).size), [b], "the commit before a rebase and a checkout");
});
