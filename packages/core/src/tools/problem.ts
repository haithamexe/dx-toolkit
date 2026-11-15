/**
 * One shape for "it didn't work": a stable `code` (what kind of thing), a `message` in plain words
 * (what happened and to what), and up to two ways out. Every part of dx that fails tells the page
 * the same way, so the page can show the reason and the fix on the thing that failed instead of in
 * a separate alert.
 *
 * A fix is data: a dashboard route to go to, a dashboard call to make on the button, or a command
 * to copy. dx never runs a copied command itself.
 */

export interface ProblemFix {
  label: string;
  /** A dashboard route, e.g. "#/ports". */
  go?: string;
  /** A dashboard call made when the button is pressed. */
  post?: { path: string; body: Record<string, unknown> };
  /** A command to copy, for something dx doesn't run for you. */
  command?: string;
}

export interface Problem {
  code: string;
  message: string;
  fixes?: ProblemFix[];
}

/** What the page knows about whatever failed: its project, the port it wanted, who has that port. */
export interface FailureContext {
  dir?: string;
  port?: number;
  owner?: { pid: number; name?: string; startedAgo?: string };
  /** False for a stack, which can't be moved to another port as one. */
  canMove?: boolean;
}

const text = (lines: string[]) => lines.join("\n");

const DOCKER = /Cannot connect to the Docker daemon|docker daemon is not running|failed to connect to the docker API|error during connect.*docker|Is Docker running/i;
const PORT = /EADDRINUSE|address already in use|port \d+ is (?:already )?in use|Port \d+ is already allocated|port is already allocated|is already in use/i;
const MODULE = /Cannot find (?:module|package) ['"]([^'"]+)['"]|Module not found: (?:Error: )?Can't resolve ['"]([^'"]+)['"]/i;
const COMMAND = /['"]?([\w.@/-]+)['"]? is not recognized as an internal or external command|([\w.@/-]+): command not found|spawn ([\w.@/-]+) ENOENT/i;
const PREPARED = /didn't start: (.+)$/im;

/** The port a line of output complains about: "...:3000", "port 3000", "0.0.0.0:3000". */
function portIn(output: string): number | undefined {
  const m = /EADDRINUSE[^\n]*?:(\d{2,5})\b/i.exec(output) ?? /address already in use[^\n]*?:(\d{2,5})\b/i.exec(output) ?? /[Pp]ort (\d{2,5})\b/.exec(output) ?? /:(\d{2,5})\b[^\n]*(?:in use|allocated)/i.exec(output);
  const n = m ? Number(m[1]) : undefined;
  return n && n > 0 && n < 65536 ? n : undefined;
}

/**
 * What went wrong with a dev server, from the end of its output. The first thing that matches
 * wins, most specific first; "it stopped" with nothing recognisable has no fix to offer.
 */
export function classifyFailure(lines: string[], context: FailureContext = {}): Problem {
  const output = text(lines.slice(-120));
  if (DOCKER.test(output)) {
    return {
      code: "docker-not-running",
      message: "Docker isn't running, so the parts that need it can't start. Start Docker Desktop, then run it again.",
      fixes: [{ label: "Show Docker", go: "#/machine" }],
    };
  }
  if (PORT.test(output)) {
    const port = context.port ?? portIn(output);
    const owner = context.owner;
    const who = owner ? ` by ${owner.name ?? "another program"} (process ${owner.pid}${owner.startedAgo ? `, started ${owner.startedAgo}` : ""})` : "";
    const fixes: ProblemFix[] = [];
    if (context.dir && context.canMove !== false) fixes.push({ label: "Use another port", post: { path: "/api/dev/start", body: { dir: context.dir, ownPort: true } } });
    fixes.push({ label: "Show that process", go: "#/ports" });
    return { code: "port-in-use", message: port ? `Port ${port} is in use${who}.` : "The port it wants is already in use.", fixes };
  }
  const missing = MODULE.exec(output);
  if (missing) {
    const name = missing[1] ?? missing[2];
    return { code: "module-missing", message: `It can't find ${name}. The packages may not be installed.`, fixes: [{ label: "Copy npm install", command: "npm install" }] };
  }
  const command = COMMAND.exec(output);
  if (command) {
    const name = command[1] ?? command[2] ?? command[3];
    return { code: "command-missing", message: `The command ${name} isn't installed or isn't on your PATH.`, fixes: [{ label: "Show this computer's tools", go: "#/machine" }] };
  }
  const prepared = PREPARED.exec(output);
  if (prepared) return { code: "prepare-failed", message: prepared[1].replace(/\s+$/, "") };
  const exited = /Exited with (\S+)\./.exec(output);
  if (exited) return { code: "exited", message: `It stopped with ${/^\d+$/.test(exited[1]) ? `code ${exited[1]}` : exited[1]}. The output has the reason.` };
  return { code: "failed", message: "It didn't start. The output has the reason." };
}

/** Any error as a Problem: its own, when it carries one, else a code from what kind of error it is. */
export function problemOf(err: unknown, fallbackCode = "error"): Problem {
  const e = err as { problem?: Problem; code?: unknown; message?: unknown } | undefined;
  if (e?.problem && typeof e.problem.code === "string" && typeof e.problem.message === "string") return e.problem;
  return { code: typeof e?.code === "string" && /^[a-z][a-z0-9-]{1,40}$/.test(e.code) ? e.code : fallbackCode, message: typeof e?.message === "string" ? e.message : String(err) };
}
