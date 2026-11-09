import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// The agents on this computer, read from a made-up Claude Code folder (CLAUDE_CONFIG_DIR): a session
// with a subagent that started another, their status, and that nothing a person or a model wrote
// comes out, only names of tools, models, times, titles and folders.
const claude = fs.mkdtempSync(path.join(os.tmpdir(), "dx-claude-home-"));
process.env.CLAUDE_CONFIG_DIR = claude;
process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-agents-home-"));
const { readAgents, agentStatus, agentSummary, claudeProjectsDir } = await import("../index.js");

const SECRET = "the prompt said: delete the production database";
const project = path.join(os.tmpdir(), "shop-website");
const folder = path.join(claude, "projects", "tmp-shop-website");
const SID = "11111111-2222-3333-4444-555555555555";
const sub = path.join(folder, SID, "subagents");
fs.mkdirSync(sub, { recursive: true });

const at = (secs: number) => new Date(Date.now() - secs * 1000).toISOString();
const line = (o: unknown) => JSON.stringify(o) + "\n";
const base = (extra: Record<string, unknown>) => ({ sessionId: SID, cwd: project, gitBranch: "main", entrypoint: "cli", timestamp: at(100), ...extra });
const use = (id: string, name: string, input: unknown = { command: SECRET }) => ({ type: "tool_use", id, name, input });
const assistant = (content: unknown[], stop: string | null, extra: Record<string, unknown> = {}) => base({ type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", stop_reason: stop, content, usage: { input_tokens: 5 } }, effort: "high", ...extra });
const result = (id: string) => base({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: SECRET }] } });

// The session: it asked a subagent (tu1) and ran two tools, one of dx's; Edit is still waiting for its result.
fs.writeFileSync(
  path.join(folder, `${SID}.jsonl`),
  line(base({ type: "user", message: { role: "user", content: SECRET }, permissionMode: "default" })) +
    line({ type: "custom-title", customTitle: "Fix the checkout" }) +
    line(assistant([use("tu1", "Agent", { description: SECRET, prompt: SECRET }), use("tu2", "Bash"), use("tu3", "mcp__dx__dx_do")], "tool_use")) +
    line(result("tu2")) +
    line(result("tu3")) +
    line(assistant([use("tu4", "Edit", { file_path: "C:/secret/file.ts" })], "tool_use")),
);

const meta = (o: Record<string, unknown>) => JSON.stringify({ isBuiltIn: true, launchedWithDefaults: true, ...o });
// A subagent (depth 1) that finished and started one of its own (depth 2, still going).
fs.writeFileSync(path.join(sub, "agent-aaa.meta.json"), meta({ agentType: "Explore", description: "Look for the checkout code", toolUseId: "tu1", spawnDepth: 1, stoppedByUser: false }));
fs.writeFileSync(
  path.join(sub, "agent-aaa.jsonl"),
  line(base({ type: "user", agentId: "aaa", message: { role: "user", content: SECRET } })) + line(assistant([use("tu9", "Agent", { description: SECRET })], "tool_use", { agentId: "aaa" })) + line(result("tu9")) + line(assistant([{ type: "text", text: SECRET }], "end_turn", { agentId: "aaa" })),
);
fs.writeFileSync(path.join(sub, "agent-bbb.meta.json"), meta({ agentType: "general-purpose", description: "Read the cart tests", toolUseId: "tu9", spawnDepth: 2, stoppedByUser: false }));
fs.writeFileSync(path.join(sub, "agent-bbb.jsonl"), line(base({ type: "user", agentId: "bbb", message: { role: "user", content: SECRET } })) + line(assistant([use("tu10", "Read")], "tool_use", { agentId: "bbb" })));
fs.writeFileSync(path.join(sub, "agent-ccc.meta.json"), meta({ agentType: "general-purpose", description: "Cancelled work", toolUseId: "tuX", spawnDepth: 1, stoppedByUser: true }));
fs.writeFileSync(path.join(sub, "agent-ccc.jsonl"), line(base({ type: "user", agentId: "ccc", message: { role: "user", content: SECRET } })));
// The first subagent finished a while ago.
const old = new Date(Date.now() - 5 * 60_000);
fs.utimesSync(path.join(sub, "agent-aaa.jsonl"), old, old);

test("the sessions folder is Claude Code's own, moved by CLAUDE_CONFIG_DIR", () => {
  assert.equal(claudeProjectsDir(), path.join(claude, "projects"));
  assert.deepEqual(readAgents({ sinceHours: 1 }).map((a) => a.id).sort(), ["a:" + SID + ":aaa", "a:" + SID + ":bbb", "a:" + SID + ":ccc", "s:" + SID].sort());
});

test("a session and its subagents are a tree: a subagent hangs under the one that started it", () => {
  const agents = readAgents({ sinceHours: 1, projects: [{ name: "shop-website", dir: project }] });
  const by = (id: string) => agents.find((a) => a.id === `a:${SID}:${id}`)!;
  const session = agents.find((a) => a.id === `s:${SID}`)!;
  assert.deepEqual([session.kind, session.label, session.project, session.branch, session.app, session.model, session.effort, session.permissionMode], ["session", "Fix the checkout", "shop-website", "main", "cli", "claude-opus-5-5", "high", "default"]);
  assert.deepEqual([by("aaa").parent, by("bbb").parent, by("ccc").parent], [`s:${SID}`, `a:${SID}:aaa`, `s:${SID}`], "bbb was started by aaa's call tu9, not by the session");
  assert.deepEqual([by("aaa").depth, by("bbb").depth], [1, 2]);
  assert.deepEqual([by("aaa").label, by("aaa").agentType, by("bbb").label], ["Look for the checkout code", "Explore", "Read the cart tests"]);
  assert.equal(by("aaa").project, "shop-website", "a subagent works in its session's project");
});

test("what each is doing: the tool it waits on, how many calls and how many were dx's own", () => {
  const agents = readAgents({ sinceHours: 1 });
  const session = agents.find((a) => a.id === `s:${SID}`)!;
  assert.deepEqual([session.status, session.tool, session.calls, session.dxCalls], ["working", "Edit", 4, 1]);
  assert.deepEqual(Object.keys(session.tools).sort(), ["Agent", "Bash", "Edit", "mcp__dx__dx_do"]);
  const by = (id: string) => agents.find((a) => a.id === `a:${SID}:${id}`)!;
  assert.deepEqual([by("aaa").status, by("bbb").status, by("bbb").tool, by("ccc").status], ["done", "working", "Read", "stopped"]);
  assert.equal(agentSummary(agents), "2 working, 1 done, 1 stopped");
});

test("only names, models, times, titles and folders come out: never a prompt, a result, a tool's input or a file's path", () => {
  const all = JSON.stringify(readAgents({ sinceHours: 1 }));
  for (const text of [SECRET, "production database", "C:/secret/file.ts", "prompt"]) assert.ok(!all.includes(text), `"${text}" is in the output`);
});

test("status: working while it moves or waits on a tool, waiting for you after a finished turn, done for a subagent", () => {
  const s = (ageMs: number, extra: Parameters<typeof agentStatus>[0] extends infer T ? Partial<T> : never = {}) => ({ ageMs, ...extra });
  assert.equal(agentStatus(s(10_000), "session"), "working");
  assert.equal(agentStatus(s(10 * 60_000, { pending: "Bash" }), "session"), "working", "a long tool call is still work");
  assert.equal(agentStatus(s(2 * 3_600_000, { pending: "Bash" }), "session"), "idle", "but not for ever");
  assert.equal(agentStatus(s(5 * 60_000, { stop: "end_turn", lastEvent: "assistant" }), "session"), "waiting");
  assert.equal(agentStatus(s(5 * 60_000, { stop: "end_turn", lastEvent: "assistant" }), "subagent"), "done");
  assert.equal(agentStatus(s(5 * 60_000, { stop: "tool_use", lastEvent: "user" }), "session"), "idle");
  assert.equal(agentStatus(s(1000, { stopped: true }), "subagent"), "stopped");
});

test("a missing Claude folder is no agents, not an error; old sessions are left out", () => {
  process.env.CLAUDE_CONFIG_DIR = path.join(claude, "nowhere");
  assert.deepEqual(readAgents(), []);
  process.env.CLAUDE_CONFIG_DIR = claude;
  const longAgo = new Date(Date.now() - 3 * 86_400_000);
  for (const f of [path.join(folder, `${SID}.jsonl`), ...fs.readdirSync(sub).map((n) => path.join(sub, n))]) fs.utimesSync(f, longAgo, longAgo);
  assert.deepEqual(readAgents({ sinceHours: 24 }), []);
  assert.equal(readAgents({ sinceHours: 24 * 5 }).length, 4);
});
