import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Warnings about agents (waiting for you, stuck on one call), how long each ran and when it called
// tools, from a made-up Claude Code folder. Nothing a person or a model wrote comes out.
const claude = fs.mkdtempSync(path.join(os.tmpdir(), "dx-claude-watch-"));
process.env.CLAUDE_CONFIG_DIR = claude;
process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-agentwatch-home-"));
const { readAgents, agentStatus, AgentWatcher, waitingNow, floppyView, newFloppyMemory } = await import("../index.js");

const SECRET = "the prompt said: wire the money to account 12345";
const folder = path.join(claude, "projects", "tmp-todo-app");
const SID = "aaaaaaaa-bbbb-cccc-dddd-000000000001";
const sub = path.join(folder, SID, "subagents");
fs.mkdirSync(sub, { recursive: true });

const NOW = Date.now();
const secs = (n: number) => new Date(NOW - n * 1000).toISOString();
const line = (o: unknown) => JSON.stringify(o) + "\n";
const base = (ts: string, extra: Record<string, unknown> = {}) => ({ sessionId: SID, cwd: "/p/todo-app", gitBranch: "main", entrypoint: "cli", timestamp: ts, ...extra });
const use = (id: string, name: string) => ({ type: "tool_use", id, name, input: { command: SECRET } });
const assistant = (ts: string, content: unknown[], stop: string) => base(ts, { type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", stop_reason: stop, content } });
const touch = (file: string, agoSecs: number) => fs.utimesSync(file, new Date(NOW - agoSecs * 1000), new Date(NOW - agoSecs * 1000));

// A session that began 20 minutes ago, called tools through dx, and ended its turn 3 minutes ago.
const sessionFile = path.join(folder, `${SID}.jsonl`);
fs.writeFileSync(
  sessionFile,
  line(base(secs(1200), { type: "user", message: { role: "user", content: SECRET } })) +
    line({ type: "custom-title", customTitle: "Add the cart" }) +
    line(assistant(secs(600), [use("t1", "Bash"), use("t2", "mcp__dx__dx_do")], "tool_use")) +
    line(assistant(secs(590), [use("t3", "mcp__dx__dx_do")], "tool_use")) +
    line(base(secs(585), { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }, { type: "tool_result", tool_use_id: "t2" }, { type: "tool_result", tool_use_id: "t3" }] } })) +
    line(assistant(secs(180), [{ type: "text", text: SECRET }], "end_turn")),
);
touch(sessionFile, 180);

// A subagent on a Bash call that nothing has come back from for 12 minutes (and one that just started).
fs.writeFileSync(path.join(sub, "agent-hung.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "Run the slow build", toolUseId: "tuA", spawnDepth: 1 }));
const hung = path.join(sub, "agent-hung.jsonl");
fs.writeFileSync(hung, line(base(secs(900), { type: "user", agentId: "hung", message: { role: "user", content: SECRET } })) + line(assistant(secs(720), [use("h1", "Bash")], "tool_use")));
touch(hung, 720);

test("how long each ran, and the calls over the last hour", () => {
  const agents = readAgents({ sinceHours: 1, now: NOW });
  const session = agents.find((a) => a.id === `s:${SID}`)!;
  const child = agents.find((a) => a.id === `a:${SID}:hung`)!;
  assert.ok(Math.abs((session.durationMs ?? 0) - 1020_000) < 2000, `from its first line (20 min before) to its last (3 min before): ${session.durationMs}`);
  assert.ok(Math.abs((child.durationMs ?? 0) - 180_000) < 2000, `${child.durationMs}`);
  const t = session.timeline;
  assert.equal(t.calls.length, 12);
  assert.equal(t.calls.reduce((a, b) => a + b, 0), 3, "three calls");
  assert.equal(t.dx.reduce((a, b) => a + b, 0), 2, "two of them through dx");
  assert.equal(t.calls[10], 3, "the calls were about 10 minutes ago: the second-to-last five minutes");
});

test("an agent on one call for 12 minutes with nothing new is stuck, and a session that finished its turn is not", () => {
  const agents = readAgents({ sinceHours: 1, now: NOW });
  assert.deepEqual(agents.find((a) => a.id === `a:${SID}:hung`)?.stuck, { tool: "Bash", minutes: 12 });
  assert.equal(agents.find((a) => a.id === `s:${SID}`)?.stuck, undefined);
});

test("a question for you is waiting at once, not after a quiet minute", () => {
  assert.equal(agentStatus({ ageMs: 20_000, pending: "AskUserQuestion", stop: "tool_use", lastEvent: "assistant" }, "session"), "waiting");
  assert.equal(agentStatus({ ageMs: 20_000, pending: "ExitPlanMode" }, "session"), "waiting");
  assert.equal(agentStatus({ ageMs: 5_000, pending: "AskUserQuestion" }, "session"), "working", "the question was only just asked");
  assert.equal(agentStatus({ ageMs: 20_000, pending: "Bash" }, "session"), "working");
});

test("waiting for you: said once per turn, after 90 seconds, and not for what has waited since before dx looked", () => {
  const watcher = new AgentWatcher();
  const said: string[] = [];
  const first = watcher.check(readAgents({ sinceHours: 1, now: NOW }), NOW, (a) => said.push(a.kind));
  // The session has waited 3 minutes: news. The subagent on one call for 12 minutes was already there when dx first looked: not news.
  assert.deepEqual(first.map((a) => a.kind), ["waiting"]);
  // Newly stuck (dx saw it before, and it passed 10 minutes since): said once, and for the subagent, not its session.
  const later = watcher.check(readAgents({ sinceHours: 1, now: NOW }).map((a) => (a.id.endsWith(":hung") ? { ...a, lastAt: new Date(NOW - 9 * 60_000).toISOString(), stuck: undefined } : a)), NOW);
  assert.deepEqual(later, [], "nothing new yet");
  const fresh = watcher.check(readAgents({ sinceHours: 1, now: NOW }), NOW + 1000);
  assert.deepEqual(fresh.map((a) => a.kind), ["stuck"]);
  const waiting = first.find((a) => a.kind === "waiting")!;
  first.push(...fresh);
  assert.deepEqual([waiting.project, waiting.label, waiting.minutes], [undefined, "Add the cart", 3]);
  assert.match(waiting.title, /an agent is waiting for you/);
  const stuck = first.find((a) => a.kind === "stuck")!;
  assert.match(stuck.text, /on Bash for 12 min/);
  assert.ok(!JSON.stringify(first).includes("account 12345"), "no prompt, no input");
  assert.deepEqual(watcher.check(readAgents({ sinceHours: 1, now: NOW + 5000 }), NOW + 5000), [], "not again");
  assert.equal(watcher.alerts.length, 2);
  assert.equal(watcher.since(NOW - 1000).length, 2);

  // A new reply from the agent and another quiet spell is another turn.
  fs.appendFileSync(sessionFile, line(assistant(secs(1), [{ type: "text", text: "done again" }], "end_turn")));
  touch(sessionFile, 100);
  const again = watcher.check(readAgents({ sinceHours: 1, now: NOW }), NOW);
  assert.deepEqual(again.map((a) => a.kind), ["waiting"]);
  assert.deepEqual(waitingNow(readAgents({ sinceHours: 1, now: NOW }), NOW).map((w) => [w.label, w.minutes]), [["Add the cart", 1]]);

  // Under 90 seconds: not yet. And an old wait is only remembered on the first look.
  touch(sessionFile, 40);
  assert.deepEqual(waitingNow(readAgents({ sinceHours: 1, now: NOW }), NOW), []);
  touch(sessionFile, 25 * 60);
  const late = new AgentWatcher();
  assert.deepEqual(late.check(readAgents({ sinceHours: 1, now: NOW }), NOW).filter((a) => a.kind === "waiting"), [], "waiting for 25 minutes before dx looked: not news");
});

test("Floppy's line says an agent is waiting, how long, and says it once", () => {
  let mem = newFloppyMemory(NOW);
  const step = (waiting?: { key: string; project?: string; minutes: number }[]) => {
    const r = floppyView({ dashboard: true, servers: [], waiting }, mem, NOW);
    mem = r.memory;
    return r.view;
  };
  let v = step([{ key: "s:1", project: "todo-app", minutes: 4 }]);
  assert.deepEqual([v.status.text, v.status.icon, v.announce], ["todo-app: agent waiting 4 min", "warn", true]);
  v = step([{ key: "s:1", project: "todo-app", minutes: 5 }, { key: "s:2", minutes: 2 }]);
  assert.deepEqual([v.status.text, v.announce], ["todo-app: agent waiting 5 min (+1)", false]);
  v = step(undefined);
  assert.doesNotMatch(v.status.text, /waiting/);
  v = step([{ key: "s:1", project: "todo-app", minutes: 6 }]);
  assert.equal(v.announce, true, "answered, then waiting again: said again");
});
