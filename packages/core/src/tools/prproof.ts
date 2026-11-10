import { readRuns, type RunRecord } from "../runs.js";
import { agentsReadable, readAgents, type AgentNode } from "./agents.js";
import { isProblem, readActivity, type ActivityEvent } from "./activity.js";
import { gitRun, runGh } from "./git.js";
import { foldPath } from "./mocks.js";
import { listVisual, type VisualCommit } from "./visual.js";

/**
 * Proof for the pull request: the "how was this tested" part of a PR, written from what dx saw
 * while the branch was worked on. The branch's commits; the last test run; the pages opened and
 * the calls they made; errors seen, and which still came up after the last commit; what the
 * visual diff, speed and accessibility checks found on the branch's commits; and every other dx
 * check (Gremlins, Chaos, Attack, behaviour diffs, translations, upgrades). Read-only: adding it
 * to the pull request is a separate step (`addProofToPr`), taken only when asked.
 */

export interface ProofCheck {
  tool: string;
  ok: boolean;
  detail: string;
  at: string;
}

export interface ProofPage {
  path: string;
  visits: number;
}

export interface ProofError {
  text: string;
  count: number;
  lastAt: string;
  /** Still came up after the branch's last commit. */
  open: boolean;
}

export interface ProofVisual {
  commit: string;
  subject?: string;
  /** "/cart (the Checkout button, 4%)". */
  changed: string[];
  slower: string[];
  a11yNew: string[];
  a11yFixed: number;
}

/** The AI agents that worked on the branch, from their session files and dx's own run log: counts and models only. */
export interface ProofAgents {
  sessions: number;
  subagents: number;
  /** Models they ran at, by how many agents used each, most first ("opus-5-5"). */
  models: string[];
  /** dx tool calls made while the branch was worked on (the AI lane's records). */
  dxCalls: number;
  /** Times the tests were run through dx (by you or an agent). */
  testRuns: number;
}

export interface PrProof {
  project: string;
  branch?: string;
  /** The branch it's compared with: origin/main, main… */
  base?: string;
  commits: { short: string; subject: string }[];
  /** Files changed and not committed yet. */
  uncommitted: number;
  /** When the work on the branch started: its first commit, else a day ago. */
  since: string;
  tests?: ProofCheck;
  pages: ProofPage[];
  /** Distinct API calls made while testing. */
  calls: number;
  errors: ProofError[];
  visual: ProofVisual[];
  checks: ProofCheck[];
  /** Only when an agent or an agent's dx call shows in the time the branch was worked on. */
  agents?: ProofAgents;
  markdown: string;
}

/** dx's own checks worth naming in a PR, by the tool name they're recorded under. */
const CHECKS: Record<string, string> = {
  gremlins: "Gremlins",
  behaviour: "Behaviour diff",
  attack: "Security check",
  locale: "Translation check",
  "env-probe": "Missing settings",
  upgrade: "Upgrade tried",
  "bug-replay": "Bug replay",
  queries: "Database queries",
  "mcp.check_url": "Page check (AI)",
  "mcp.run_gremlins": "Gremlins (AI)",
  "mcp.security_check": "Security check (AI)",
  "mcp.behaviour_diff": "Behaviour diff (AI)",
};

export const PROOF_START = "<!-- dx:proof:start -->";
export const PROOF_END = "<!-- dx:proof:end -->";

async function git(dir: string, args: string[]): Promise<string> {
  const r = await gitRun(dir, args);
  return r.code === 0 ? r.stdout.trim() : "";
}

/** The branch a PR would go into: the remote's default branch, else main or master. */
export async function baseBranch(dir: string): Promise<string | undefined> {
  const head = await git(dir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head;
  for (const b of ["origin/main", "origin/master", "main", "master"]) if (await git(dir, ["rev-parse", "--verify", "--quiet", `${b}^{commit}`])) return b;
  return undefined;
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const shape = (s: string) => s.split("\n")[0].replace(/https?:\/\/[^/\s]+/g, "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 200);

function pathOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, "http://x").pathname;
  } catch {
    return undefined;
  }
}

/** Gathers the proof for the project's current branch. `events` and `runs` default to dx's own records (for tests). */
export async function prProof(project: { name: string; dir: string }, options: { events?: ActivityEvent[]; runs?: RunRecord[]; visual?: VisualCommit[]; agents?: AgentNode[]; now?: number } = {}): Promise<PrProof> {
  const dir = project.dir;
  const now = options.now ?? Date.now();
  const branch = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])) || undefined;
  const base = await baseBranch(dir);
  const onBase = !!base && !!branch && (base === branch || base.endsWith(`/${branch}`));
  const range = base && !onBase ? `${base}..HEAD` : undefined;
  const log = range ? await git(dir, ["log", "--no-merges", "--format=%h%x09%at%x09%s", range]) : "";
  const commits = log
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [s, at, ...subject] = l.split("\t");
      return { short: s, at: Number(at) * 1000, subject: subject.join("\t") };
    });
  const first = commits.at(-1)?.at;
  const lastCommit = commits[0]?.at ?? (Number(await git(dir, ["log", "-1", "--format=%at"])) * 1000 || now);
  const since = new Date(first ? first - 60 * 60_000 : now - 86_400_000).toISOString();
  const status = await git(dir, ["status", "--porcelain"]);
  const uncommitted = status ? status.split("\n").filter(Boolean).length : 0;

  // What happened in the app since then.
  const events = options.events ?? readActivity({ dir, since: new Date(since), limit: 50_000 });
  const pageCount = new Map<string, number>();
  const calls = new Set<string>();
  const errors = new Map<string, ProofError>();
  for (const e of events) {
    if (e.at < since) continue;
    if (e.type === "page" || e.type === "route") {
      const p = pathOf(e.type === "route" ? (e.page ?? e.url) : (e.url ?? e.page));
      if (p && !p.startsWith("/__dx/")) pageCount.set(foldPath(p), (pageCount.get(foldPath(p)) ?? 0) + 1);
    } else if (e.type === "request" && e.url) {
      const p = pathOf(e.url);
      if (p && !p.startsWith("/__dx/")) calls.add(`${e.method ?? "GET"} ${foldPath(p)}`);
    }
    if (isProblem(e) && e.type !== "server") {
      const key = shape(e.text);
      const err = errors.get(key) ?? { text: short(e.text.split("\n")[0], 160), count: 0, lastAt: e.at, open: false };
      err.count++;
      if (e.at > err.lastAt) err.lastAt = e.at;
      if (Date.parse(e.at) > lastCommit) err.open = true;
      errors.set(key, err);
    }
  }

  // dx's records: the last test run, and its other checks.
  const runs = (options.runs ?? readRuns(0)).filter((r) => r.at >= since && (r.project === project.name || r.detail?.startsWith(`${project.name}:`)));
  const toCheck = (r: RunRecord): ProofCheck => ({ tool: CHECKS[r.tool] ?? r.tool, ok: r.ok, detail: (r.detail ?? "").replace(new RegExp(`^${project.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*`), ""), at: r.at });
  const testRun = runs.filter((r) => r.tool === "test" || r.tool === "mcp.run_tests").at(-1);
  const latest = new Map<string, RunRecord>();
  for (const r of runs) if (CHECKS[r.tool]) latest.set(r.tool.replace(/^mcp\./, ""), r);

  // Visual, speed and accessibility for the branch's commits.
  const mine = new Set(commits.map((c) => c.short));
  const visual: ProofVisual[] = (options.visual ?? listVisual(dir))
    .filter((v) => [...mine].some((s) => v.commit.startsWith(s)))
    .map((v) => ({
      commit: v.commit.slice(0, 7),
      subject: v.subject,
      changed: v.captures.filter((c) => c.changed).map((c) => `${c.path}${c.label ? ` (${c.label}, ${((c.ratio ?? 0) * 100).toFixed(c.ratio && c.ratio < 0.01 ? 1 : 0)}%)` : ""}`),
      slower: v.captures.flatMap((c) => [c.slower, c.heavier].filter((x): x is string => !!x).map((x) => `${c.path}: ${x}`)),
      a11yNew: v.captures.flatMap((c) => (c.a11yNew ?? []).map((i) => `${c.path}: ${i.text}`)),
      a11yFixed: v.captures.reduce((n, c) => n + (c.a11yFixed ?? 0), 0),
    }))
    .filter((v) => v.changed.length || v.slower.length || v.a11yNew.length || v.a11yFixed);

  // The agents: sessions (and their subagents) of this project active since the work began, and what they did through dx.
  const agentList = options.agents ?? (agentsReadable() ? readAgents({ sinceHours: Math.min(24 * 14, Math.max(1, Math.ceil((now - Date.parse(since)) / 3_600_000))), now, projects: [{ name: project.name, dir }] }) : []);
  const mine2 = agentList.filter((a) => a.project === project.name && a.lastAt >= since);
  const modelCount = new Map<string, number>();
  for (const a of mine2) if (a.model) modelCount.set(a.model.replace(/^claude-/, "").replace(/-\d{8}$/, ""), (modelCount.get(a.model.replace(/^claude-/, "").replace(/-\d{8}$/, "")) ?? 0) + 1);
  // Every call an agent made through the MCP server (including dx_do and dx_actions).
  const dxCalls = runs.filter((r) => r.tool.startsWith("mcp.")).length;
  // Every test run is recorded once as "test" (by the dashboard, the CLI or an agent); the agent's call is another record.
  const testRuns = runs.filter((r) => r.tool === "test").length;
  const sessions = mine2.filter((a) => a.kind === "session").length;
  const agents: ProofAgents | undefined = sessions || mine2.length || dxCalls ? { sessions, subagents: mine2.length - sessions, models: [...modelCount].sort((a, b) => b[1] - a[1]).map(([m]) => m), dxCalls, testRuns } : undefined;

  const proof: PrProof = {
    project: project.name,
    branch,
    base,
    commits: commits.map((c) => ({ short: c.short, subject: c.subject })),
    uncommitted,
    since,
    tests: testRun ? toCheck(testRun) : undefined,
    pages: [...pageCount].sort((a, b) => b[1] - a[1]).map(([path, visits]) => ({ path, visits })),
    calls: calls.size,
    errors: [...errors.values()].sort((a, b) => Number(b.open) - Number(a.open) || b.count - a.count),
    visual,
    checks: [...latest.values()].map(toCheck),
    agents,
    markdown: "",
  };
  proof.markdown = proofMarkdown(proof);
  return proof;
}

const ago = (iso: string, now = Date.now()) => {
  const m = Math.round((now - Date.parse(iso)) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

/** The proof as the Markdown section dx puts in a PR description, between its own markers. */
export function proofMarkdown(p: PrProof): string {
  const out: string[] = [PROOF_START, "## How this was tested", ""];
  if (p.tests) out.push(`- ${p.tests.ok ? "✅" : "❌"} **Tests**: ${p.tests.detail} (${ago(p.tests.at)})`);
  else out.push("- ⚪ **Tests**: not run through dx on this branch");
  if (p.agents) {
    const a = p.agents;
    const bits = [
      a.sessions ? `${a.sessions === 1 ? "1 agent session" : `${a.sessions} agent sessions`}${a.subagents ? ` with ${a.subagents === 1 ? "1 subagent" : `${a.subagents} subagents`}` : ""}${a.models.length ? ` (${a.models.slice(0, 3).join(", ")})` : ""}` : a.subagents ? `${a.subagents} subagents` : "",
      a.dxCalls ? `${a.dxCalls === 1 ? "1 call" : `${a.dxCalls} calls`} through dx` : "",
      a.testRuns ? `tests run ${a.testRuns === 1 ? "once" : `${a.testRuns} times`} through dx` : "",
    ].filter(Boolean);
    if (bits.length) out.push(`- 🤖 **Built with AI**: ${bits.join(", ")}`);
  }
  if (p.pages.length) {
    const list = p.pages.slice(0, 8).map((x) => `\`${x.path}\``).join(", ");
    out.push(`- 🖱️ **Tried by hand**: ${p.pages.length === 1 ? "1 page" : `${p.pages.length} pages`} (${list}${p.pages.length > 8 ? ", …" : ""}), ${p.calls === 1 ? "1 API call" : `${p.calls} different API calls`}`);
  }
  const open = p.errors.filter((e) => e.open);
  if (p.errors.length) out.push(`- ${open.length ? "⚠️" : "✅"} **Errors while testing**: ${p.errors.length} seen, ${open.length ? `${open.length} still came up after the last commit` : "none since the last commit"}`);
  else if (p.pages.length) out.push("- ✅ **Errors while testing**: none");
  for (const c of p.checks) out.push(`- ${c.ok ? "✅" : "⚠️"} **${c.tool}**: ${c.detail || (c.ok ? "passed" : "found problems")}`);
  const changed = p.visual.flatMap((v) => v.changed.map((x) => `${x} in ${v.commit}`));
  const slower = p.visual.flatMap((v) => v.slower);
  const a11y = p.visual.flatMap((v) => v.a11yNew);
  const fixed = p.visual.reduce((n, v) => n + v.a11yFixed, 0);
  if (changed.length) out.push(`- 👀 **Looks different**: ${changed.slice(0, 6).join("; ")}${changed.length > 6 ? "; …" : ""}`);
  if (slower.length) out.push(`- 🐢 **Slower**: ${slower.slice(0, 4).join("; ")}`);
  if (a11y.length) out.push(`- ♿ **New accessibility problems**: ${a11y.slice(0, 4).join("; ")}${a11y.length > 4 ? "; …" : ""}`);
  if (fixed) out.push(`- ♿ **Accessibility problems fixed**: ${fixed}`);
  if (open.length) {
    out.push("", "<details><summary>Errors after the last commit</summary>", "");
    for (const e of open.slice(0, 10)) out.push(`- \`${e.text.replace(/`/g, "'")}\` ×${e.count}`);
    out.push("", "</details>");
  }
  if (p.commits.length) {
    out.push("", `<details><summary>${p.commits.length === 1 ? "1 commit" : `${p.commits.length} commits`}${p.base ? ` since ${p.base}` : ""}</summary>`, "");
    for (const c of p.commits.slice(0, 30)) out.push(`- ${c.short} ${c.subject.replace(/[<>]/g, "")}`);
    out.push("", "</details>");
  }
  if (p.uncommitted) out.push("", `_${p.uncommitted === 1 ? "1 file isn't" : `${p.uncommitted} files aren't`} committed yet._`);
  out.push("", "<sub>Recorded locally by dx.</sub>", PROOF_END);
  return out.join("\n");
}

/** The PR body with dx's section put in: replacing the one already there, or added at the end. */
export function withProof(body: string, section: string): string {
  const start = body.indexOf(PROOF_START);
  const end = body.indexOf(PROOF_END);
  if (start >= 0 && end > start) return `${body.slice(0, start)}${section}${body.slice(end + PROOF_END.length)}`;
  return body.trim() ? `${body.trimEnd()}\n\n${section}\n` : `${section}\n`;
}

export interface PrInfo {
  number: number;
  url: string;
  title: string;
  body: string;
}

// Fixed arguments; the body goes in on stdin, never on the command line.
const gh = (dir: string, args: string[], input?: string) => runGh(dir, args, input, 30_000);

/** The open pull request for the current branch, through the GitHub CLI; undefined when there's none. */
export async function currentPr(dir: string): Promise<PrInfo | undefined> {
  const r = await gh(dir, ["pr", "view", "--json", "number,url,title,body"]);
  if (r.code !== 0) {
    if (/gh isn't installed|ENOENT/.test(r.stderr)) throw new Error("The GitHub CLI (gh) isn't installed: copy the text into the pull request instead.");
    if (/no pull requests? found|could not find/i.test(r.stderr)) return undefined;
    if (/auth|login/i.test(r.stderr)) throw new Error("gh isn't signed in: run gh auth login, or copy the text into the pull request.");
    throw new Error(r.stderr.split("\n")[0] || "gh couldn't read the pull request.");
  }
  try {
    const j = JSON.parse(r.stdout) as PrInfo;
    return { number: j.number, url: j.url, title: j.title, body: j.body ?? "" };
  } catch {
    throw new Error("gh's answer couldn't be read.");
  }
}

/** Puts the proof into the branch's pull request description (its own section, replaced on later runs). */
export async function addProofToPr(dir: string, section: string): Promise<PrInfo> {
  const pr = await currentPr(dir);
  if (!pr) throw new Error("This branch has no open pull request yet. Open one first, or copy the text.");
  const body = withProof(pr.body, section);
  const r = await gh(dir, ["pr", "edit", String(pr.number), "--body-file", "-"], body);
  if (r.code !== 0) throw new Error(r.stderr.split("\n")[0] || "gh couldn't change the pull request.");
  return { ...pr, body };
}
