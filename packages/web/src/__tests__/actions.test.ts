import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The catalog the MCP server offers (dx_actions, dx_do, dx_do_risky): every action is a route the
// dashboard really has, and its inputs are checked before anything is sent.
const { DX_ACTIONS, ACTION_GROUPS, actionRequest, dxAction } = await import("../actions.js");

const dist = fileURLToPath(new URL("..", import.meta.url));
const source = fs
  .readdirSync(dist)
  .filter((f) => f.endsWith(".js"))
  .map((f) => fs.readFileSync(`${dist}/${f}`, "utf8"))
  .join("\n");

test("every action is a route the dashboard has, in a known group, named once", () => {
  const ids = new Set<string>();
  for (const a of DX_ACTIONS) {
    assert.ok(!ids.has(a.id), `${a.id} named twice`);
    ids.add(a.id);
    assert.ok(ACTION_GROUPS[a.group], `${a.id}: group ${a.group}`);
    assert.ok(source.includes(`"${a.method} ${a.path}"`), `${a.id}: the dashboard has no ${a.method} ${a.path}`);
    if (a.fixed?.action) assert.match(source, new RegExp(`["\\s]${String(a.fixed.action).replace(/[-]/g, "\\-")}"?:\\s*\\(`), `${a.id}: no git action ${a.fixed.action}`);
  }
  assert.ok(DX_ACTIONS.length > 150, "the dashboard's actions, not a handful");
});

test("what's risky: deleting, pushing, secrets, stopping processes, the database", () => {
  for (const id of ["git.push", "git.discard", "git.release-create", "env.read", "env.write", "machine.stop", "machine.cleanup-delete", "data.load", "tools.delete", "projects.clone"]) assert.equal(dxAction(id)?.risky, true, id);
  // The maintainer's choice: these ask too, though they stay on this computer and can be undone.
  for (const id of ["git.commit", "git.merge", "git.rebase", "git.revert", "git.cherry-pick", "git.switch", "git.continue", "api.mock-mode", "chaos.set", "run.stop", "run.restart", "tools.save", "tools.import", "api.rule-save", "api.rule-remove", "api.mock-update", "api.mocks-make", "api.mocks-from-spec"]) assert.equal(dxAction(id)?.risky, true, id);
  // An agent must not be able to widen its own freedom: changing what dx does by itself, or saying yes for the person, asks.
  for (const id of ["settings.autonomy-set", "settings.proposal-resolve"]) assert.equal(dxAction(id)?.risky, true, id);
  for (const id of ["settings.autonomy", "settings.proposals", "lookback.ai-uses", "git.suggest-preview", "git.fix-preview"]) assert.ok(!dxAction(id)?.risky, id);
  for (const id of ["git.status", "git.stage", "run.start", "run.check", "tools.run", "api.mocks", "env.project"]) assert.ok(!dxAction(id)?.risky, id);
});

test("every action has a risk tier, and asks / name are exactly the risky ones", () => {
  const seen = new Set<string>();
  for (const a of DX_ACTIONS) {
    assert.ok(a.risk, `${a.id} has no risk tier`);
    seen.add(a.risk);
    assert.equal(a.risk === "asks" || a.risk === "name", a.risky === true, `${a.id}: risk ${a.risk} and risky ${a.risky} disagree`);
    // A read is free, unless it hands over secrets (env.read), which asks.
    if (a.method === "GET" && !a.risky) assert.equal(a.risk, "none", `${a.id}: a read changes nothing`);
  }
  assert.deepEqual([...seen].sort(), ["asks", "name", "none", "reversible"]);
  assert.equal(dxAction("git.release-create")?.risk, "name", "a public release is the one that makes you type its name");
  assert.equal(dxAction("git.push")?.risk, "asks");
  assert.equal(dxAction("git.status")?.risk, "none");
  assert.equal(dxAction("git.stage")?.risk, "reversible");
});

test("inputs are checked: required ones, unknown ones; GETs in the address, POSTs in the body with fixed values", () => {
  const status = dxAction("git.status")!;
  assert.throws(() => actionRequest(status, {}), /git.status needs dir/);
  assert.throws(() => actionRequest(status, { dir: "/x", force: true }), /doesn't take force/);
  assert.deepEqual(actionRequest(status, { dir: "/path/to/todo-app" }), { method: "GET", path: "/api/git/status?dir=%2Fpath%2Fto%2Ftodo-app" });
  assert.deepEqual(actionRequest(dxAction("git.push")!, { dir: "/x", force: true }), { method: "POST", path: "/api/git/action", body: { dir: "/x", force: true, action: "push" } });
  assert.deepEqual(actionRequest(dxAction("run.start")!, { dir: "/x" }).body, { dir: "/x", by: "ai" }, "an agent's server is labelled as the AI's");
  assert.throws(() => actionRequest(dxAction("git.push")!, { dir: "/x", action: "branch-delete" }), /doesn't take action/, "the fixed action can't be swapped");
});
