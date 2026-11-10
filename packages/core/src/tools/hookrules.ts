/**
 * Which shell commands dx has a tool for. No imports on purpose: `dx hook pre-bash` runs before every
 * shell command Claude Code makes, so a command that isn't a test or dev command must cost almost nothing.
 */

export type ShellKind = "test" | "dev";

const TEST = [
  /^(?:npx\s+(?:--no-install\s+)?|pnpm\s+(?:exec\s+)?|yarn\s+|bunx\s+)?(?:vitest|jest)\b/,
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::\S+)?\b/,
  /^npm\s+t\b/,
  /^(?:python3?\s+-m\s+)?pytest\b/,
  /^go\s+test\b/,
  /^node\s+(?:\S+\s+)*--test\b/,
];
const DEV = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)(?::\S+)?\b/,
  /^(?:npx\s+)?vite(?:\s+(?!build\b|preview\b)|$)/,
  /^(?:npx\s+)?(?:next|nuxt|astro)\s+dev\b/,
  /^(?:npx\s+)?webpack\s+serve\b/,
];

/** What a shell command is, if it's one dx has a tool for: each part of `a && b | c` is looked at. */
export function classifyCommand(command: string): ShellKind | undefined {
  for (const raw of command.split(/&&|\|\||;|\||\r?\n/)) {
    const part = raw.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
    if (!part) continue;
    if (TEST.some((r) => r.test(part))) return "test";
    if (DEV.some((r) => r.test(part))) return "dev";
  }
  return undefined;
}
