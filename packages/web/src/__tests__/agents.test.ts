import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// The Agents page's route against a made-up Claude folder: a session working in one of dx's
// projects, with the project named from its folder, and the answer without any message text.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-agents-web-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-agents-web-projects-"));
const claude = fs.mkdtempSync(path.join(os.tmpdir(), "dx-agents-web-claude-"));
process.env.DX_HOME = home;
process.env.CLAUDE_CONFIG_DIR = claude;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0 }));

const app = path.join(root, "shop-website");
fs.mkdirSync(path.join(app, "src"), { recursive: true });
fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "shop-website", scripts: { dev: "node server.js" } }));

const SID = "99999999-8888-7777-6666-555555555555";
const folder = path.join(claude, "projects", "shop");
fs.mkdirSync(path.join(folder, SID, "subagents"), { recursive: true });
const now = () => new Date().toISOString();
const base = { sessionId: SID, cwd: path.join(app, "src"), gitBranch: "main", entrypoint: "cli", timestamp: now() };
fs.writeFileSync(
  path.join(folder, `${SID}.jsonl`),
  JSON.stringify({ ...base, type: "user", message: { role: "user", content: "a private instruction" } }) + "\n" + JSON.stringify({ type: "custom-title", customTitle: "Fix the cart" }) + "\n" + JSON.stringify({ ...base, type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "mcp__dx__dx_do", input: { secret: "x" } }] } }) + "\n",
);
fs.writeFileSync(path.join(folder, SID, "subagents", "agent-z1.meta.json"), JSON.stringify({ agentType: "Explore", description: "Look at the cart", toolUseId: "t0", spawnDepth: 1 }));
fs.writeFileSync(path.join(folder, SID, "subagents", "agent-z1.jsonl"), JSON.stringify({ ...base, agentId: "z1", type: "assistant", message: { role: "assistant", model: "claude-haiku-5-5", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t5", name: "Read", input: {} }] } }) + "\n");

const { startDashboard } = await import("../server.js");
let dashboard: Awaited<ReturnType<typeof startDashboard>>;
const get = async (p: string) => {
  const res = await fetch(new URL(p, dashboard.url), { headers: { "X-DX-Token": dashboard.token } });
  return { status: res.status, text: await res.text() };
};
before(async () => {
  dashboard = await startDashboard({ port: 0 });
});
after(async () => {
  await dashboard.close();
});

test("GET /api/agents: the sessions and subagents, each in its project, metadata only", async () => {
  const r = await get("/api/agents");
  assert.equal(r.status, 200);
  const data = JSON.parse(r.text);
  assert.equal(data.hours, 24);
  const session = data.agents.find((a: { id: string }) => a.id === `s:${SID}`);
  const sub = data.agents.find((a: { id: string }) => a.id === `a:${SID}:z1`);
  assert.deepEqual([session.label, session.project, session.status, session.tool, session.dxCalls], ["Fix the cart", "shop-website", "working", "mcp__dx__dx_do", 1], "a folder inside the project is the project's");
  assert.deepEqual([sub.parent, sub.label, sub.agentType, sub.model], [`s:${SID}`, "Look at the cart", "Explore", "claude-haiku-5-5"]);
  assert.match(data.summary, /2 working/);
  assert.ok(!r.text.includes("private instruction") && !r.text.includes('"secret"'), "no message and no tool input");
});

test("how far back is the caller's to choose, within limits; the token is needed", async () => {
  assert.equal(JSON.parse((await get("/api/agents?hours=9999")).text).hours, 336);
  assert.equal(JSON.parse((await get("/api/agents?hours=nope")).text).hours, 24);
  const res = await fetch(new URL("/api/agents", dashboard.url));
  assert.equal(res.status, 401);
});

test("GET /api/agents/alerts: the warnings since a moment (the session here is working, so none)", async () => {
  const r = await get("/api/agents/alerts?since=2020-01-01T00:00:00Z");
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.text), { alerts: [] });
  assert.equal((await fetch(new URL("/api/agents/alerts", dashboard.url))).status, 401);
});
