import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-autonomy-test-"));
const { CAPABILITIES, autoSetupTick, autonomyState, commitMessageParts, defaultConfig, fixPromptParts, levelOf, listProposals, loadConfig, propose, readAiUses, recordAiUse, recordChange, readChanges, saveConfig, setAiOutcome, setLevel, takeProposal, undoChange, withActor, SNOOZE_MS } = await import("../index.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-autonomy-root-"));
saveConfig({ ...defaultConfig(), projectsRoots: [root] });

function project(name: string, files: Record<string, string>): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  const run = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "octocat@example.com");
  run("config", "user.name", "octocat");
  return dir;
}

test("every capability starts at what dx did before, and a choice goes back to the default by itself", () => {
  assert.ok(CAPABILITIES.length >= 4);
  for (const c of CAPABILITIES) assert.equal(levelOf(c.id), c.default, c.id);
  assert.equal(levelOf("deleting-things"), "suggest", "something dx doesn't do on its own does nothing on its own");
  assert.deepEqual(setLevel("git-fetch", "ask"), { previous: "do" });
  assert.equal(levelOf("git-fetch"), "ask");
  assert.deepEqual(loadConfig().autonomy, { "git-fetch": "ask" });
  assert.deepEqual(setLevel("git-fetch", "do"), { previous: "ask" });
  assert.equal(loadConfig().autonomy, undefined, "the default leaves nothing in the file");
  assert.throws(() => setLevel("git-fetch", "always"), /suggest, ask or do/);
  assert.throws(() => setLevel("push-to-main", "do"), /nothing to set/);
  assert.equal(autonomyState().find((c) => c.id === "gitignore-rules")?.level, "do");
});

test("what dx was told to ask about is raised once per project, kept, and put off for a day when you say not now", () => {
  const a = propose({ capability: "gitignore-rules", level: "ask", project: "shop-website", dir: "/path/to/shop-website", what: "Add 2 rules", action: { kind: "gitignore-rules", data: { dir: "/path/to/shop-website", patterns: [".env"] } } });
  assert.ok(a);
  const again = propose({ capability: "gitignore-rules", level: "ask", project: "shop-website", dir: "/PATH/to/shop-website", what: "Add 3 rules", action: a!.action });
  assert.equal(again?.id, a!.id, "the same question isn't asked twice");
  assert.equal(listProposals().length, 1);
  assert.equal(listProposals()[0].what, "Add 3 rules", "it says what's true now");
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(process.env.DX_HOME!, "proposals.json")).mode & 0o777, 0o600);

  assert.ok(takeProposal(a!.id, true));
  assert.equal(listProposals().length, 0);
  assert.equal(propose({ capability: "gitignore-rules", level: "ask", dir: "/path/to/shop-website", what: "x", action: a!.action }), undefined, "not raised again within the day");
  assert.ok(propose({ capability: "gitignore-rules", level: "ask", dir: "/path/to/other", what: "x", action: a!.action }), "another project is another question");
  assert.ok(SNOOZE_MS >= 24 * 3_600_000);
  takeProposal(listProposals()[0].id);
});

test("told to ask or suggest, a new project's setup is put to you and nothing is written", async () => {
  const seen = project("seen-before", { "package.json": "{}" });
  await autoSetupTick([{ dir: seen, name: "seen-before" }]); // the first look only remembers
  setLevel("gitignore-rules", "ask");
  setLevel("claude-setup", "suggest");
  const fresh = project("shop-website", { "package.json": JSON.stringify({ name: "shop-website" }), ".env": "SECRET=1\n" });
  await autoSetupTick([{ dir: fresh, name: "shop-website" }]);
  assert.equal(fs.existsSync(path.join(fresh, ".gitignore")), false, "no rule was written");
  assert.equal(fs.existsSync(path.join(fresh, "CLAUDE.local.md")), false, "no Claude files were written");
  const mine = listProposals().filter((p) => p.dir === fresh);
  assert.deepEqual(mine.map((p) => `${p.capability}:${p.level}`).sort(), ["claude-setup:suggest", "gitignore-rules:ask"]);
  const rules = mine.find((p) => p.capability === "gitignore-rules")!;
  assert.match(rules.what, /Add \d+ rules? to shop-website's \.gitignore/);
  assert.ok((rules.action.data.patterns as string[]).includes(".env"));
  for (const p of mine) takeProposal(p.id);
  setLevel("gitignore-rules", "do");
  setLevel("claude-setup", "do");
});

test("at the default, a new project is set up as before", async () => {
  const fresh = project("todo-app", { "package.json": JSON.stringify({ name: "todo-app" }), ".env": "SECRET=1\n" });
  await autoSetupTick([{ dir: fresh, name: "todo-app" }]);
  assert.match(fs.readFileSync(path.join(fresh, ".gitignore"), "utf8"), /\.env/);
  assert.ok(fs.existsSync(path.join(fresh, "CLAUDE.local.md")));
  assert.ok(readChanges().some((c) => c.dir === fresh && c.kind === "gitignore" && c.by === "dx"), "and listed as dx's, with its Undo");
  assert.equal(listProposals().filter((p) => p.dir === fresh).length, 0);
});

test("a change written as you becomes the agent's while an AI tool is the one asking", () => {
  const asYou = recordChange({ by: "you", kind: "x", what: "by hand" });
  const asAgent = withActor("ai", () => recordChange({ by: "you", kind: "x", what: "through dx_do" }));
  const dx = withActor("ai", () => recordChange({ by: "dx", kind: "x", what: "dx itself" }));
  assert.equal(asYou.by, "you");
  assert.equal(asAgent.by, "ai");
  assert.equal(dx.by, "dx", "only what would have been yours changes hands");
});

test("choosing how much dx does is a change you can take back", async () => {
  const { previous } = setLevel("weekly-summary", "suggest");
  const change = recordChange({ by: "you", kind: "autonomy", what: "dx only suggests: saving your weekly summary", undo: { kind: "autonomy", data: { id: "weekly-summary", previous } } });
  assert.equal(levelOf("weekly-summary"), "suggest");
  await undoChange(change.id);
  assert.equal(levelOf("weekly-summary"), "do");
  const bad = recordChange({ by: "you", kind: "autonomy", what: "x", undo: { kind: "autonomy", data: { id: "weekly-summary", previous: "always" } } });
  await assert.rejects(() => undoChange(bad.id), /nothing to put back/);
});

test("the AI list keeps what was sent as labels and sizes, and what came of it", () => {
  const use = recordAiUse({ feature: "fix", project: "shop-website", tool: "claude", sent: [{ label: "src/cart.ts, lines 20 to 80", bytes: 2100 }, { label: "x".repeat(300), bytes: 12.7 }], outcome: "proposed" });
  assert.equal(use.sent[1].label.length, 120, "a label is clipped");
  assert.equal(use.sent[1].bytes, 13);
  setAiOutcome(use.id, "applied");
  const now = readAiUses().find((u) => u.id === use.id)!;
  assert.equal(now.outcome, "applied");
  assert.ok(readAiUses(Date.now() + 60_000).length === 0, "only since the moment asked");
  assert.ok(!JSON.stringify(readAiUses()).includes("lines 20 to 80\u0000"), "no text of what was sent, only labels");
});

test("what a fix would send is counted by part, and a secrets file isn't one of them", async () => {
  const dir = project("api-gateway", {
    "src/cart.ts": Array.from({ length: 30 }, (_, i) => `export const n${i} = ${i};`).join("\n") + "\n",
    ".env": "SECRET=never-sent\n",
  });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "src", "cart.ts"), fs.readFileSync(path.join(dir, "src", "cart.ts"), "utf8") + "export const added = 1;\n");
  fs.writeFileSync(path.join(dir, ".env"), "SECRET=changed\n");
  const { prompt, sent } = await fixPromptParts(dir, { kind: "runtime", message: "TypeError: x is undefined", file: path.join(dir, "src", "cart.ts"), line: 5, stack: `at total (${path.join(dir, "src", "cart.ts")}:5:3)` });
  const labels = sent.map((s) => s.label);
  assert.ok(labels.includes("The error and its stack"));
  assert.ok(labels.some((l) => l.startsWith("src/cart.ts")), labels.join(" | "));
  assert.ok(labels.some((l) => /^Your uncommitted changes \(1 lines changed\)/.test(l)), labels.join(" | "));
  assert.ok(sent.every((s) => s.bytes > 0));
  assert.ok(!prompt.includes("never-sent") && !prompt.includes("SECRET=changed"), "a .env file is never in what's sent");
  assert.ok(sent.reduce((n, s) => n + s.bytes, 0) <= Buffer.byteLength(prompt), "the parts are inside the prompt");
});

test("what a commit message would send is the diff, the file list and the last subjects", async () => {
  const dir = project("notes", { "a.txt": "1\n" });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "Start"], { cwd: dir });
  await assert.rejects(() => commitMessageParts(dir), /Nothing is staged/);
  fs.writeFileSync(path.join(dir, "a.txt"), "2\n");
  execFileSync("git", ["add", "a.txt"], { cwd: dir });
  const { sent } = await commitMessageParts(dir);
  assert.deepEqual(sent.map((s) => s.label.replace(/\(.*\)/, "()")), ["The staged diff ()", "The list of changed files", "Your last 10 commit subjects"]);
  assert.ok(sent.every((s) => s.bytes > 0));
});
