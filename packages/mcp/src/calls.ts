import { maskText, maskUrl, recordRun } from "@dx/core";

/**
 * Every tool call the MCP server handles is written to ~/.dx/runs.jsonl as `mcp.<tool>` with
 * source "mcp": a sentence saying what the agent did, the project, a short summary of the
 * arguments, ok or failed, and how long it took. The dashboard's AI lane and `dx runs` read it.
 *
 * Nothing secret goes in: only arguments on a fixed list are summarised (never a request body,
 * headers, a note, a journal entry or a database query), addresses are masked, and from a result
 * only numbers are kept (a status code, how many problems), never its text, except a failure's
 * first line for tools whose errors can't carry data (not db_query, check_env or set_stack).
 */

export interface CallResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

export interface CallRecord {
  tool: string;
  ok: boolean;
  detail: string;
  project?: string;
  args?: string;
  ms: number;
}

type Args = Record<string, unknown>;

/** Arguments that say what a call was about and can't carry a secret. */
const SAFE_KEYS = new Set([
  "project",
  "name",
  "path",
  "url",
  "port",
  "days",
  "year",
  "since",
  "problems",
  "browser",
  "screenshot",
  "service",
  "part",
  "limit",
  "include_system",
  "all_authors",
  "github",
  "types",
  "failed",
  "all",
  "since_start",
  "since_line",
  "visit",
  "timeout_seconds",
  "max_lines",
  "include_resolved",
  "changed",
  "install",
  "start_dev_server",
  "active_days",
  "site",
  "env",
  "method",
  "on",
  "level",
  "seed",
  "actions",
  "commit",
  "phone",
  "time_zone",
  "action",
  "recipe",
  "read_only",
  "package",
  "version",
  "paths",
]);
/** Arguments whose size is worth knowing but whose content isn't kept. */
const COUNTED_KEYS = new Set(["steps", "files", "services", "query", "note", "text", "body", "headers", "search", "match"]);
/** `query` is a project-name search in these tools; elsewhere (db_query) it's what's never kept. */
const NAME_QUERY_TOOLS = new Set(["list_projects", "audit_dependencies"]);
/** Tools whose error messages can echo data: their failures are recorded as "failed", nothing more. */
const QUIET_FAILURES = new Set(["db_query", "check_env", "set_stack", "add_log_entry", "leave_note"]);

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** "project=shop-website path=/checkout browser steps=[3]": what the agent asked, nothing secret. */
export function summarizeArgs(tool: string, args: Args = {}): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    if (key === "query" && NAME_QUERY_TOOLS.has(tool) && typeof value === "string") {
      parts.push(`query=${clip(maskText(value), 40)}`);
      continue;
    }
    if (COUNTED_KEYS.has(key)) {
      if (Array.isArray(value)) parts.push(`${key}=[${value.length}]`);
      else if (typeof value === "string") parts.push(`${key}=(${value.length} chars)`);
      else if (typeof value === "object") parts.push(`${key}=(${Object.keys(value).length})`);
      continue;
    }
    if (!SAFE_KEYS.has(key)) continue;
    if (typeof value === "boolean") {
      if (value) parts.push(key);
      else parts.push(`${key}=false`);
    } else if (typeof value === "number") parts.push(`${key}=${value}`);
    else if (typeof value === "string") parts.push(`${key}=${clip(key === "url" || key === "path" ? maskUrl(value) : maskText(value), 80)}`);
    else if (Array.isArray(value)) parts.push(`${key}=${clip(value.filter((v) => typeof v === "string").join(","), 60)}`);
  }
  return parts.join(" ");
}

function resultText(result: CallResult | undefined): string {
  return (result?.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

/** Lines starting with "- " under a heading like "Console errors:". */
function countUnder(text: string, heading: string): number {
  const at = text.indexOf(`${heading}:\n`);
  if (at < 0) return 0;
  let n = 0;
  for (const line of text.slice(at + heading.length + 2).split("\n")) {
    if (line.startsWith("- ")) n++;
    else if (!line.startsWith(" ")) break;
  }
  return n;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a check_url call found, in numbers: the status, or how many problems the browser saw. */
function checkOutcome(text: string): string {
  if (/ loaded in headless /.test(text) || / couldn't be loaded in /.test(text)) {
    if (/ couldn't be loaded in /.test(text)) return "couldn't load the page";
    const problems = countUnder(text, "Uncaught exceptions") + countUnder(text, "Console errors") + countUnder(text, "Failed requests");
    const failedStep = /^FAIL {2}\d+\./m.test(text);
    return [problems ? plural(problems, "error") : "no errors", failedStep ? "a step failed" : ""].filter(Boolean).join(", ");
  }
  const status = / → (\d{3})\b/.exec(text)?.[1];
  const serverErrors = countUnder(text.replace(/^Errors .+ logged meanwhile:$/m, "Server errors:"), "Server errors");
  if (!status) return / failed after \d+ ms/.test(text) ? "no answer" : "";
  return serverErrors ? `${status}, ${plural(serverErrors, "server error")}` : status;
}

/** Where the call was aimed, for the sentence: "/checkout on shop-website" or the masked address. */
function target(args: Args, project?: string): string {
  if (typeof args.url === "string" && args.url) return clip(maskUrl(args.url), 80);
  const path = typeof args.path === "string" && args.path ? clip(maskUrl(args.path), 60) : "/";
  return project ? `${path} on ${project}` : path;
}

/** The sentence the AI lane shows: "Started shop-website's dev server", "Checked /checkout on shop-website: 2 errors". */
export function describeCall(tool: string, args: Args, ok: boolean, result?: CallResult, project?: string): string {
  const p = project ?? (typeof args.project === "string" ? args.project : undefined);
  const of = (what: string) => (p ? `${p}'s ${what}` : `the ${what}`);
  const text = resultText(result);
  const sentence = (() => {
    switch (tool) {
      case "start_dev_server":
        return ok ? `Started ${of("dev server")}` : `Tried to start ${of("dev server")}`;
      case "stop_dev_server":
        return `Stopped ${of("dev server")}`;
      case "restart_dev_server":
        return `Restarted ${of("dev server")}`;
      case "dev_servers":
        return "Listed the running dev servers";
      case "dev_logs":
        return `Read ${of("dev server output")}`;
      case "dev_errors":
        return `Read ${of("errors")}`;
      case "wait_for_rebuild":
        return `Waited for ${p ?? "the app"} to rebuild`;
      case "check_url": {
        const verb = args.browser || args.screenshot || (Array.isArray(args.steps) && args.steps.length) ? "Loaded" : "Checked";
        const steps = Array.isArray(args.steps) && args.steps.length ? ` with ${plural(args.steps.length, "step")}` : "";
        const outcome = checkOutcome(text);
        return `${verb} ${target(args, p)}${steps}${outcome ? `: ${outcome}` : ""}`;
      }
      case "activity_log":
        return `Read ${p ? `${p}'s` : "the"} activity log${args.problems ? " (problems only)" : ""}`;
      case "network_log":
        return `Read ${of("network log")}`;
      case "replay_visit":
        return `Replayed a visit on ${p ?? "the app"}`;
      case "db_query":
        return `Queried ${of("database")}`;
      case "run_tests": {
        const m = /: (\d+) passed, (\d+) failed/.exec(text);
        return `Ran ${of("tests")}${m ? `: ${m[1]} passed, ${m[2]} failed` : ""}`;
      }
      case "list_projects":
        return "Listed your projects";
      case "open_project":
        return `Opened ${p ?? "a project"} in the editor${args.start_dev_server ? " and started it in a terminal" : ""}`;
      case "list_ports":
        return typeof args.port === "number" ? `Looked at port ${args.port}` : "Listed the listening ports";
      case "kill_port":
        return `Stopped what was listening on port ${args.port}`;
      case "machine_info":
        return "Read this computer's tools and processes";
      case "add_log_entry":
        return "Added a journal entry";
      case "read_log":
        return "Read your journal";
      case "work_summary":
        return typeof args.year === "number" ? `Wrote your ${args.year} in review` : "Wrote a work summary";
      case "find_cleanup":
        return "Looked for folders to clean up";
      case "audit_dependencies":
        return "Checked dependencies";
      case "fix_dependencies":
        return `Updated ${of("dependencies")}`;
      case "set_stack":
        return `Set ${of("stack")}`;
      case "clone_project":
        return `Cloned ${typeof args.url === "string" ? clip(maskUrl(args.url), 80) : "a repository"}`;
      case "check_env":
        return `Checked ${of(".env files")}`;
      case "unsaved_work":
        return "Looked for unsaved work";
      case "resume_project":
        return `Read where you left off on ${p ?? "a project"}`;
      case "leave_note":
        return `Left a note on ${p ?? "a project"}`;
      case "dx_setup_check":
        return "Checked dx's setup";
      case "visual_diff":
        return `${args.capture ? "Captured and compared" : "Compared"} how ${p ?? "the app"} looks${typeof args.commit === "string" ? ` at ${args.commit.slice(0, 7)}` : ""}`;
      case "project_tour":
        return `Read the tour of ${p ?? "a project"}`;
      case "pr_proof":
        return `Wrote the pull request proof for ${p ?? "a project"}`;
      case "try_upgrade":
        return `Tried ${typeof args.package === "string" ? args.package : "a package"} ${typeof args.version === "string" ? args.version : "latest"} on ${p ?? "a project"}`;
      case "db_queries":
        return args.action === "on" ? `Switched on query logging for ${p ?? "a project"}` : args.action === "off" ? `Switched off query logging for ${p ?? "a project"}` : `Read ${of("database queries")}`;
      case "translation_check":
        return `Checked ${p ? `${p}'s` : "the app's"} pages for other languages`;
      default:
        if (tool.startsWith("git_")) return `Git: ${tool.slice(4).replace(/_/g, " ")}${p ? ` in ${p}` : ""}`;
        return `Called ${tool}${p ? ` on ${p}` : ""}`;
    }
  })();
  // check_url and a test run already say what went wrong, in numbers.
  if (ok || tool === "check_url" || (tool === "run_tests" && sentence.includes(" passed, "))) return sentence;
  const why = QUIET_FAILURES.has(tool) ? "" : clip(maskText(text.split("\n")[0] ?? "").trim(), 120);
  return `${sentence}: failed${why ? ` (${why})` : ""}`;
}

/** The record for one call. Exported for tests. */
export function callRecord(tool: string, args: Args, result: CallResult | undefined, ms: number, project?: string): CallRecord {
  const ok = !!result && !result.isError;
  const record: CallRecord = { tool: `mcp.${tool}`, ok, detail: describeCall(tool, args, ok, result, project), ms };
  const summary = summarizeArgs(tool, args);
  if (summary) record.args = summary;
  const name = project ?? (typeof args.project === "string" ? args.project : typeof args.name === "string" && tool === "open_project" ? args.name : undefined);
  if (name) record.project = name;
  return record;
}

export function recordCall(record: CallRecord): void {
  recordRun(record.tool, record.ok, record.detail, "mcp", { ...(record.project ? { project: record.project } : {}), ms: record.ms, ...(record.args ? { args: record.args } : {}) });
}
