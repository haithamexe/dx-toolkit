/**
 * `dx hook pre-bash`: Claude Code gives the command about to run as JSON on stdin; this answers with one
 * line of guidance for a test or dev command in a dx project, and nothing for anything else. It never
 * fails the command it watches (any problem is silent, exit code 0), and for the vast majority of
 * commands, which aren't tests or dev servers, it stops after a regex without loading dx's code.
 */
export async function runHook(argv: string[]): Promise<number> {
  if (argv[0] !== "pre-bash") return 0;
  try {
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) input += chunk;
    const command = (JSON.parse(input) as { tool_input?: { command?: unknown } }).tool_input?.command;
    if (typeof command !== "string") return 0;
    const { classifyCommand } = await import("@dx/core/hook");
    if (!classifyCommand(command)) return 0;
    const { preBashHook } = await import("@dx/core");
    const out = preBashHook(input);
    if (out) process.stdout.write(`${out}\n`);
  } catch {
    // never get in the way of the command being run
  }
  return 0;
}
