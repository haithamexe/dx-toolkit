#!/usr/bin/env node
// `dx hook pre-bash` runs before every shell command Claude Code makes, so it starts without loading the rest of the CLI.
if (process.argv[2] === "hook") {
  const { runHook } = await import("./hook.js");
  process.exitCode = await runHook(process.argv.slice(3));
} else {
  await import("./main.js");
}
