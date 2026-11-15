/**
 * What needs the person's attention, as one model: built from facts about each project (its dev
 * server, unsaved work, .env exposure, the last test run, agents waiting) and nothing else, so the
 * Home page, a project's next steps and (later) Floppy and the MCP tools read the same list.
 *
 * Pure: no files, no git. The web layer gathers the facts; this decides what they mean and in which
 * order, and what each item offers as its one main action.
 */

/** What an action does when pressed: go to a page (`go`, a hash route) or call the dashboard's API (`post`). */
export interface AttentionAction {
  label: string;
  primary?: boolean;
  go?: string;
  post?: { path: string; body: Record<string, unknown> };
  /** How the page words the button after a `post` succeeds: the button itself says it (no toast). */
  after?: "push" | "fix" | "tests";
}

export type AttentionKind = "errors" | "agent" | "unpushed" | "env" | "tests" | "site";

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  /** 1 needs you now, 2 should be looked at, 3 worth knowing. */
  severity: 1 | 2 | 3;
  project: string;
  dir: string;
  title: string;
  detail: string;
  /** dx can do the main action itself, and it can be taken back or is harmless. */
  dxCanFix?: boolean;
  actions: AttentionAction[];
}

export interface ProjectFacts {
  name: string;
  dir: string;
  server?: { status: string; errorCount: number; url?: string; recorded?: boolean; notRecorded?: string };
  unsaved?: { unpushed: number; changed: number; untracked: number; noRemote: boolean; branch?: string };
  /** .env files git would pick up (`tracked` or not ignored) and the secret rules .gitignore lacks. */
  env?: { exposed: { name: string; tracked: boolean }[]; missingRules: string[] };
  tests?: { ok: boolean; passed: number; failed: number; at: string; firstFailure?: string };
  waiting?: { label: string; minutes: number }[];
  /** A website project: what its recorded calls and its last check say. dx makes no calls of its own to learn it. */
  site?: { problems: number; failedCheck?: { at: string; what: string } };
}

const route = (page: string, dir: string) => `#/${page}?dir=${encodeURIComponent(dir)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function ago(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** The items for one project, unsorted. */
export function projectItems(f: ProjectFacts, now = Date.now()): AttentionItem[] {
  const items: AttentionItem[] = [];
  const base = { project: f.name, dir: f.dir };

  if (f.server && f.server.status !== "stopped" && f.server.errorCount > 0) {
    items.push({
      ...base,
      id: `errors:${f.dir}`,
      kind: "errors",
      severity: 1,
      title: plural(f.server.errorCount, "error") + " in the running app",
      detail: f.server.url ? `Running at ${f.server.url.replace(/^https?:\/\//, "")}` : "Running",
      actions: [{ label: "Open errors", primary: true, go: route("overview", f.dir) }],
    });
  }

  if (f.site && f.site.problems > 0) {
    items.push({
      ...base,
      id: `site-errors:${f.dir}`,
      kind: "errors",
      severity: 1,
      title: plural(f.site.problems, "problem") + " on the site in the last hour",
      detail: "Errors and failed requests the dx browser recorded",
      actions: [{ label: "Open activity", primary: true, go: route("activity", f.dir) }],
    });
  }
  if (f.site?.failedCheck && now - Date.parse(f.site.failedCheck.at) < 24 * 3_600_000) {
    items.push({
      ...base,
      id: `site-check:${f.dir}`,
      kind: "site",
      severity: 2,
      title: `The last ${f.site.failedCheck.what} check of the site found a problem`,
      detail: `Checked ${ago(now - Date.parse(f.site.failedCheck.at))}`,
      actions: [{ label: "Open the site", primary: true, go: route("overview", f.dir) }],
    });
  }

  for (const w of f.waiting ?? []) {
    items.push({
      ...base,
      id: `agent:${f.dir}:${w.label}`,
      kind: "agent",
      severity: 2,
      title: `an agent is waiting, ${w.minutes} min`,
      detail: w.label ? `“${w.label}”` : "It has stopped and is waiting for your reply",
      actions: [{ label: "Open the agent", primary: true, go: "#/agents" }],
    });
  }

  if (f.unsaved && f.unsaved.unpushed > 0) {
    items.push({
      ...base,
      id: `unpushed:${f.dir}`,
      kind: "unpushed",
      severity: 2,
      title: `${plural(f.unsaved.unpushed, "commit")} not pushed anywhere`,
      detail: f.unsaved.branch ? `on ${f.unsaved.branch}, no remote has ${f.unsaved.unpushed === 1 ? "it" : "them"} yet` : "No remote has them yet",
      actions: [
        { label: "Push", primary: true, post: { path: "/api/git/action", body: { dir: f.dir, action: "push" } }, after: "push" },
        { label: "Review", go: route("git", f.dir) },
      ],
    });
  }

  if (f.env && f.env.exposed.length > 0) {
    const tracked = f.env.exposed.some((e) => e.tracked);
    // Rules can only be added for a file git doesn't have yet; one already committed needs a person.
    const fixable = !tracked && f.env.missingRules.length > 0;
    items.push({
      ...base,
      id: `env:${f.dir}`,
      kind: "env",
      severity: 2,
      title: tracked ? ".env is committed to git" : ".env isn't ignored by git",
      detail: fixable ? `Adds ${plural(f.env.missingRules.length, "line")} to .gitignore. It shows under Recent changes.` : tracked ? "Its values are in the repository's history." : "Open it to see what's missing.",
      dxCanFix: fixable,
      actions: [
        ...(fixable ? [{ label: "Fix it", primary: true, post: { path: "/api/env/gitignore", body: { dir: f.dir, patterns: f.env.missingRules } }, after: "fix" as const }] : []),
        { label: fixable ? "Show me" : "Open", primary: !fixable, go: route("env", f.dir) },
      ],
    });
  }

  if (f.tests && !f.tests.ok && f.tests.failed > 0 && now - Date.parse(f.tests.at) < 24 * 3_600_000) {
    items.push({
      ...base,
      id: `tests:${f.dir}`,
      kind: "tests",
      severity: 3,
      title: `${plural(f.tests.failed, "test")} failed, ${ago(now - Date.parse(f.tests.at))}`,
      detail: f.tests.firstFailure ?? `${f.tests.passed} passed`,
      actions: [
        { label: "Run it again", primary: true, post: { path: "/api/tests", body: { dir: f.dir } }, after: "tests" },
        { label: "Open", go: route("overview", f.dir) },
      ],
    });
  }
  return items;
}

/** Everything that needs attention across projects, the most urgent first. */
export function attentionItems(facts: ProjectFacts[], now = Date.now()): AttentionItem[] {
  // Within a level, what blocks work first (an agent waiting), then what could leak or be lost.
  const rank: Record<AttentionKind, number> = { errors: 0, site: 0, agent: 1, env: 2, unpushed: 3, tests: 4 };
  return facts.flatMap((f) => projectItems(f, now)).sort((a, b) => a.severity - b.severity || rank[a.kind] - rank[b.kind] || a.project.localeCompare(b.project));
}

export interface NextStep {
  label: string;
  go?: string;
  post?: { path: string; body: Record<string, unknown> };
  after?: AttentionAction["after"];
}

/** What to do next in one project: its items as short chips, then what the work itself suggests. */
export function nextSteps(f: ProjectFacts, now = Date.now()): NextStep[] {
  const steps: NextStep[] = [];
  for (const item of projectItems(f, now)) {
    const main = item.actions.find((a) => a.primary) ?? item.actions[0];
    const label =
      item.kind === "errors" ? `Look at ${f.server?.errorCount === 1 ? "the error" : `${f.server?.errorCount} errors`}` :
      item.kind === "unpushed" ? `Push ${plural(f.unsaved?.unpushed ?? 0, "commit")}` :
      item.kind === "tests" ? `Run the ${f.tests?.failed === 1 ? "failing test" : "failing tests"} again` :
      item.kind === "env" ? (item.dxCanFix ? "Keep .env out of git" : "Look at .env") :
      main.label;
    steps.push({ label, go: main.go, post: main.post, after: main.after });
  }
  const changed = (f.unsaved?.changed ?? 0) + (f.unsaved?.untracked ?? 0);
  if (changed > 0) steps.push({ label: `Commit ${plural(changed, "change")}`, go: route("git", f.dir) });
  return steps.slice(0, 4);
}

export interface StartedStep {
  label: string;
  done: boolean;
  go?: string;
}

/** The "Get started" checklist, from what is already true: nothing to remember between runs. */
export function startedSteps(state: { projects: number; claudeConnected: boolean; ranAnApp: boolean; ranTests: boolean }): StartedStep[] {
  return [
    { label: state.projects ? `Projects found (${state.projects})` : "Find your projects", done: state.projects > 0, go: "#/health" },
    { label: "Claude connected to dx", done: state.claudeConnected, go: "#/health" },
    { label: "Run an app", done: state.ranAnApp, go: "#/projects" },
    { label: "Run your tests through dx", done: state.ranTests, go: "#/projects" },
  ];
}
