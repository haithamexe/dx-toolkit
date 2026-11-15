import assert from "node:assert/strict";
import { test } from "node:test";
import { attentionItems, nextSteps, startedSteps, type ProjectFacts } from "../tools/attention.js";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const shop: ProjectFacts = {
  name: "shop-website",
  dir: "/code/shop-website",
  server: { status: "ready", errorCount: 2, url: "http://localhost:3000", recorded: true },
  unsaved: { unpushed: 0, changed: 2, untracked: 0, noRemote: false, branch: "main" },
  tests: { ok: false, passed: 47, failed: 1, at: minutesAgo(12) },
};
const todo: ProjectFacts = { name: "todo-app", dir: "/code/todo-app", waiting: [{ label: "Which migration first?", minutes: 4 }] };
const gateway: ProjectFacts = { name: "api-gateway", dir: "/code/api-gateway", unsaved: { unpushed: 3, changed: 0, untracked: 0, noRemote: false, branch: "main" } };
const docs: ProjectFacts = { name: "docs-site", dir: "/code/docs-site", env: { exposed: [{ name: ".env", tracked: false }], missingRules: [".env", ".env.*", "*.pem"] } };
const quiet: ProjectFacts = { name: "archive", dir: "/code/archive" };

test("what needs you is one list, the most urgent first, each with one main action", () => {
  const items = attentionItems([quiet, docs, gateway, todo, shop], NOW);
  assert.deepEqual(items.map((i) => `${i.severity}:${i.kind}:${i.project}`), [
    "1:errors:shop-website",
    "2:agent:todo-app",
    "2:env:docs-site",
    "2:unpushed:api-gateway",
    "3:tests:shop-website",
  ]);
  assert.ok(items.every((i) => i.actions.filter((a) => a.primary).length === 1), "exactly one primary action each");
  assert.ok(!items.some((i) => i.project === "archive"), "a quiet project has nothing listed");
});

test("an action is a page to go to or a call to make, and says how its button reads afterwards", () => {
  const items = attentionItems([docs, gateway, shop], NOW);
  const push = items.find((i) => i.kind === "unpushed")!.actions[0];
  assert.deepEqual(push.post, { path: "/api/git/action", body: { dir: "/code/api-gateway", action: "push" } });
  assert.equal(push.after, "push");
  const fix = items.find((i) => i.kind === "env")!;
  assert.equal(fix.dxCanFix, true);
  assert.deepEqual(fix.actions[0].post?.body.patterns, [".env", ".env.*", "*.pem"], "only the rules the project lacks");
  assert.equal(fix.actions[0].after, "fix");
  assert.match(items.find((i) => i.kind === "errors")!.actions[0].go ?? "", /^#\/overview\?dir=%2Fcode%2Fshop-website$/);
});

test("a .env that's already committed isn't something dx can quietly fix", () => {
  const [item] = attentionItems([{ ...docs, env: { exposed: [{ name: ".env", tracked: true }], missingRules: [".env"] } }], NOW);
  assert.equal(item.title, ".env is committed to git");
  assert.equal(item.dxCanFix, false);
  assert.equal(item.actions[0].post, undefined, "no one-click fix: it needs a person");
});

test("old test failures, stopped servers and clean projects raise nothing", () => {
  assert.deepEqual(attentionItems([{ ...shop, server: { status: "stopped", errorCount: 5 }, tests: { ok: false, passed: 1, failed: 1, at: minutesAgo(60 * 30) } }], NOW).map((i) => i.kind), []);
  assert.deepEqual(attentionItems([{ ...shop, server: undefined, tests: { ok: true, passed: 48, failed: 0, at: minutesAgo(1) }, unsaved: undefined }], NOW), []);
});

test("a project's next steps are short chips, then what the work suggests", () => {
  const steps = nextSteps(shop, NOW).map((s) => s.label);
  assert.deepEqual(steps, ["Look at 2 errors", "Run the failing test again", "Commit 2 changes"]);
  assert.deepEqual(nextSteps(gateway, NOW).map((s) => s.label), ["Push 3 commits"]);
  assert.deepEqual(nextSteps(quiet, NOW), []);
});

test("the Get started checklist is read from what is already true", () => {
  const steps = startedSteps({ projects: 22, claudeConnected: true, ranAnApp: true, ranTests: false });
  assert.deepEqual(steps.map((s) => s.done), [true, true, true, false]);
  assert.equal(steps[0].label, "Projects found (22)");
  assert.equal(startedSteps({ projects: 0, claudeConnected: false, ranAnApp: false, ranTests: false }).every((s) => !s.done), true);
});
