import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * On macOS and Linux, a program started from the Dock, Finder, a launcher or at sign-in gets the
 * system's bare PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), not the one your shell builds: no
 * Homebrew, nvm, fnm, volta, Docker Desktop or editors' command-line tools. The dashboard behind
 * the dx app, and the MCP server an AI app starts, then couldn't find `npm`, `docker` or `code`,
 * so Run, terminals and the editor failed. This asks your login shell for its PATH once (what
 * VS Code does) and puts it in front, then adds the usual install folders that exist.
 *
 * Only PATH is taken, nothing else from the shell. The shell is the one in $SHELL (an absolute
 * path to a program that exists), run with fixed arguments; nothing from a request reaches it.
 */

const MARK = "__DX_PATH__";

/** Joins PATH lists in order, keeping each folder once and dropping empty entries. */
export function mergePath(...lists: (string | undefined)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of (list ?? "").split(":")) {
      const dir = raw.trim();
      if (!dir || seen.has(dir)) continue;
      seen.add(dir);
      out.push(dir);
    }
  }
  return out.join(":");
}

/** Folders tools are usually installed in on macOS and Linux, the ones that exist. */
export function wellKnownBinDirs(home = os.homedir(), platform: NodeJS.Platform = process.platform, exists: (dir: string) => boolean = fs.existsSync): string[] {
  const dirs = [
    ...(platform === "darwin" ? ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/Applications/Docker.app/Contents/Resources/bin"] : ["/home/linuxbrew/.linuxbrew/bin", "/snap/bin"]),
    "/usr/local/bin",
    "/usr/local/sbin",
    path.join(home, ".docker", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".deno", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, "go", "bin"),
    path.join(home, ".local", "share", "pnpm"),
    path.join(home, "Library", "pnpm"),
  ];
  return dirs.filter((d) => exists(d));
}

/** The text between the two marks, as the shell printed it. */
export function pathFromShellOutput(out: string): string | undefined {
  const start = out.indexOf(MARK);
  const end = out.indexOf(MARK, start + MARK.length);
  if (start < 0 || end < 0) return undefined;
  const value = out.slice(start + MARK.length, end).trim();
  return value.includes("/") ? value : undefined;
}

/** The arguments for the login shell: interactive too for shells that read nvm's lines from their rc file. */
export function shellPathArgs(shell: string): string[] {
  const name = path.basename(shell);
  const script = `printf '%s' '${MARK}'; printenv PATH; printf '%s' '${MARK}'`;
  return /^(bash|zsh|fish|ksh|mksh)$/.test(name) ? ["-ilc", script] : ["-lc", script];
}

/** Your login shell's PATH, or undefined when it can't be read in time. */
export function loginShellPath(env: NodeJS.ProcessEnv = process.env, timeoutMs = 6000): Promise<string | undefined> {
  const shell = env.SHELL && path.isAbsolute(env.SHELL) && fs.existsSync(env.SHELL) ? env.SHELL : process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
  if (!fs.existsSync(shell)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (value: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // oh-my-zsh and similar ask about updates at start; there's nobody to answer.
      child = spawn(shell, shellPathArgs(shell), { stdio: ["ignore", "pipe", "ignore"], env: { ...env, DISABLE_AUTO_UPDATE: "true", DX_SHELL_PATH: "1" }, detached: true });
    } catch {
      return resolve(undefined);
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish(pathFromShellOutput(out));
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      out += d;
      if (pathFromShellOutput(out)) finish(pathFromShellOutput(out));
    });
    child.once("error", () => finish(undefined));
    child.once("close", () => finish(pathFromShellOutput(out)));
  });
}

let adopted: Promise<{ changed: boolean; added: string[] }> | undefined;

/**
 * Puts your shell's PATH (and the usual install folders) into this process's PATH, once. Nothing
 * on Windows, where programs started from the Start menu get the full PATH. The shell isn't run
 * under DX_HOME (tests, demos) or with DX_NO_SHELL_PATH set; the known folders are still added.
 */
export function adoptShellPath(env: NodeJS.ProcessEnv = process.env): Promise<{ changed: boolean; added: string[] }> {
  if (process.platform === "win32") return Promise.resolve({ changed: false, added: [] });
  adopted ??= (async () => {
    const before = env.PATH ?? "";
    const shell = env.DX_HOME || env.DX_NO_SHELL_PATH ? undefined : await loginShellPath(env).catch(() => undefined);
    const next = mergePath(shell, before, wellKnownBinDirs().join(":"));
    const had = new Set(before.split(":"));
    const added = next.split(":").filter((d) => !had.has(d));
    if (next !== before) env.PATH = next;
    return { changed: next !== before, added };
  })();
  return adopted;
}
