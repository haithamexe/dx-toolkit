import { execFile, spawnSync } from "node:child_process";

/**
 * Some builders (a project's tour) read git at several points in code that is written to run in one go.
 * For the dashboard, which also proxies your dev servers, `withPrefetchedGit` asks git for those
 * answers first, in parallel and without waiting on the main thread, then runs the builder with
 * them in hand. Anything it didn't prefetch is asked for the usual synchronous way.
 */
let active: Map<string, string> | undefined;

const key = (dir: string, args: string[]) => `${dir}\0${args.join("\0")}`;

/** git's stdout for these arguments (a prefetched answer if this is one), or "" when git fails. */
export function gitStdout(dir: string, args: string[], maxBuffer = 64 * 1024 * 1024): string {
  const hit = active?.get(key(dir, args));
  if (hit !== undefined) return hit;
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true, maxBuffer, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  return r.status === 0 ? r.stdout : "";
}

function gitAsync(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: dir, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (err, stdout) => resolve(err ? "" : stdout));
  });
}

/** Asks git for each argument list at once, then runs `fn` (which reads them through gitStdout) without any wait in between. */
export async function withPrefetchedGit<T>(dir: string, argLists: string[][], fn: () => T): Promise<T> {
  const answers = await Promise.all(argLists.map((args) => gitAsync(dir, args)));
  const map = new Map<string, string>();
  argLists.forEach((args, i) => map.set(key(dir, args), answers[i]));
  // `fn` runs to its end before anything else can: nothing else sees (or loses) the prefetched answers.
  active = map;
  try {
    return fn();
  } finally {
    active = undefined;
  }
}
