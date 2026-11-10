import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Check } from "./doctor.js";

/**
 * Developer setup checks for `dx doctor`: the things that make git, GitHub and the shell behave on a
 * new computer. Each check reads settings with fixed commands (git config, gh auth status, reg
 * query) or files, and says the exact command that fixes it. Nothing is changed by looking.
 */

export interface RunResult {
  code: number;
  out: string;
}

export type DevRun = (command: string, args: string[]) => Promise<RunResult>;

/** Runs a command we chose (never one from a request), through cmd.exe for .cmd shims on Windows. */
export const defaultDevRun: DevRun = (command, args) =>
  new Promise((resolve) => {
    const [file, list] = process.platform === "win32" && !["reg", "wsl", "where", "git"].includes(command) ? ["cmd.exe", ["/d", "/s", "/c", [command, ...args].join(" ")]] : [command, args];
    execFile(file, list, { windowsHide: true, timeout: 8000, encoding: "utf8" }, (err, stdout, stderr) => {
      // An exit code, or 127 when the program couldn't start at all.
      // An exit code; 124 when it ran out of time; 127 when the program couldn't start at all.
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : (err as { killed?: boolean }).killed ? 124 : 127) : 0;
      resolve({ code, out: `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}` });
    });
  });

export interface DevSetupOptions {
  run?: DevRun;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** The projects' folders (to see whether any uses an ssh remote or GitHub), and the projects folders. */
  projectDirs?: string[];
  roots?: string[];
  /** Replaceable file reads, for tests. */
  readText?: (file: string) => string | undefined;
  exists?: (file: string) => boolean;
  list?: (dir: string) => string[];
}

const text = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

export async function devSetupChecks(options: DevSetupOptions = {}): Promise<Check[]> {
  const run = options.run ?? defaultDevRun;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const readText = options.readText ?? text;
  const exists = options.exists ?? ((f: string) => fs.existsSync(f));
  const list =
    options.list ??
    ((d: string) => {
      try {
        return fs.readdirSync(d);
      } catch {
        return [];
      }
    });
  const checks: Check[] = [];
  const win = platform === "win32";

  // git itself: without it none of the rest applies.
  const version = await run("git", ["--version"]);
  if (version.code === 124) return [{ name: "Git", status: "warn", detail: "git didn't answer in time, so its settings weren't checked", fix: "dx doctor, again" }];
  if (version.code !== 0) {
    checks.push({ name: "Git", status: "fail", detail: "git isn't installed or isn't on PATH", fix: win ? "winget install --id Git.Git" : platform === "darwin" ? "brew install git" : "sudo apt install -y git" });
    return checks;
  }
  // What git uses, not only ~/.gitconfig: Git for Windows sets core.autocrlf in its system file.
  const config = async (key: string) => ((await run("git", ["config", "--get", key])).out.split(/\r?\n/)[0] ?? "").trim() || undefined;

  const name = await config("user.name");
  const email = await config("user.email");
  checks.push({
    name: "Git identity",
    status: name && email ? "ok" : "warn",
    detail: name && email ? `${name} <${email}>` : `${!name ? "user.name" : ""}${!name && !email ? " and " : ""}${!email ? "user.email" : ""} isn't set, so commits get a guessed author`,
    fix: name && email ? undefined : [!name && 'git config --global user.name "Your Name"', !email && 'git config --global user.email "you@example.com"'].filter(Boolean).join(" && "),
  });

  const crlf = await config("core.autocrlf");
  if (win) {
    checks.push({
      name: "Git line endings",
      status: crlf ? "ok" : "warn",
      detail: crlf ? `core.autocrlf is ${crlf}` : "core.autocrlf isn't set: files can be checked out with different line endings from the ones in the repository, and every line shows as changed",
      fix: crlf ? undefined : "git config --global core.autocrlf true",
    });
    const longGit = await config("core.longpaths");
    const reg = await run("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem", "/v", "LongPathsEnabled"]);
    const longOs = /LongPathsEnabled\s+REG_DWORD\s+0x1\b/i.test(reg.out);
    checks.push({
      name: "Long paths",
      status: longGit === "true" && longOs ? "ok" : "warn",
      detail: longGit === "true" && longOs ? "git and Windows accept paths over 260 characters" : `${longGit === "true" ? "" : "git's core.longpaths is off"}${longGit !== "true" && !longOs ? "; " : ""}${longOs ? "" : "Windows' LongPathsEnabled is off"}: a deep node_modules can fail to install or delete`,
      fix: [longGit === "true" ? "" : "git config --global core.longpaths true", longOs ? "" : 'in an administrator PowerShell: New-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force'].filter(Boolean).join("   then   "),
    });
  } else if (crlf === "true") {
    checks.push({ name: "Git line endings", status: "warn", detail: "core.autocrlf is true on a system that uses LF: it rewrites line endings on checkout", fix: "git config --global core.autocrlf input" });
  }

  // GitHub's own command, which releases and the pull request's proof go through.
  const gh = await run("gh", ["--version"]);
  const ghInstall = win ? "winget install --id GitHub.cli" : platform === "darwin" ? "brew install gh" : "sudo apt install -y gh";
  const onGithub = (options.projectDirs ?? []).some((d) => /github\.com/i.test(readText(path.join(d, ".git", "config")) ?? ""));
  if (gh.code === 0) {
    const auth = await run("gh", ["auth", "status"]);
    // gh asks GitHub: offline or slow isn't "signed out".
    if (auth.code !== 0 && (auth.code === 124 || /timeout|timed out|network|could not resolve|no such host|dial tcp|offline|connection/i.test(auth.out))) checks.push({ name: "GitHub CLI", status: "ok", detail: "installed; couldn't reach GitHub to see whether you're signed in" });
    else checks.push({ name: "GitHub CLI", status: auth.code === 0 ? "ok" : "warn", detail: auth.code === 0 ? "signed in: releases and pull request proof work" : "installed, but not signed in: releases and the pull request proof can't reach GitHub", fix: auth.code === 0 ? undefined : "gh auth login" });
  } else if (onGithub) {
    checks.push({ name: "GitHub CLI", status: "warn", detail: "not installed: releases and the pull request proof need it", fix: `${ghInstall}, then gh auth login` });
  }

  // An SSH key, when a project is cloned over ssh (git@github.com:…), which an https clone doesn't need.
  const usesSsh = (options.projectDirs ?? []).some((d) => /url\s*=\s*(git@|ssh:\/\/)/i.test(readText(path.join(d, ".git", "config")) ?? ""));
  if (usesSsh) {
    const keys = list(path.join(home, ".ssh")).filter((f) => /^id_(rsa|ed25519|ecdsa)$/.test(f));
    checks.push({
      name: "SSH key",
      status: keys.length || env.SSH_AUTH_SOCK ? "ok" : "warn",
      detail: keys.length ? `${keys.join(", ")} in ~/.ssh` : env.SSH_AUTH_SOCK ? "an ssh agent is running" : "a project is cloned over ssh and there's no key in ~/.ssh",
      fix: keys.length || env.SSH_AUTH_SOCK ? undefined : 'ssh-keygen -t ed25519 -C "you@example.com", then gh ssh-key add ~/.ssh/id_ed25519.pub',
    });
  }

  // PATH: folders that don't exist, and two installs of node (which runs depends on the order).
  const sep = win ? ";" : ":";
  const entries = (env[win ? "Path" : "PATH"] ?? env.PATH ?? env.Path ?? "").split(sep).map((e) => e.trim().replace(/^"|"$/g, "")).filter(Boolean);
  const missing = [...new Set(entries.filter((e) => !/%|\$/.test(e) && !exists(e)))];
  const nodes = (await run(win ? "where" : "which", win ? ["node"] : ["-a", "node"])).out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^INFO:|Could not find/i.test(l));
  // /usr/bin/node and /bin/node are one file on a usr-merged system: compare where they really are.
  const real = (f: string) => {
    try {
      return fs.realpathSync(f);
    } catch {
      return f;
    }
  };
  const nodeDirs = [...new Set(nodes.map((n) => path.dirname(options.exists ? n : real(n)).toLowerCase()))];
  checks.push({
    name: "PATH",
    status: missing.length > 3 || nodeDirs.length > 1 ? "warn" : "ok",
    detail: [missing.length > 3 ? `${missing.length} folders on it don't exist (${missing.slice(0, 3).join(", ")}…)` : "", nodeDirs.length > 1 ? `node is installed in ${nodeDirs.length} places (${nodeDirs.slice(0, 3).join(", ")}): the first on PATH runs` : ""].filter(Boolean).join("; ") || `${entries.length} folders, one node`,
    fix: missing.length > 3 || nodeDirs.length > 1 ? (win ? "Remove what you don't use in Settings → System → About → Advanced system settings → Environment Variables → Path; keep one Node (a version manager like fnm or nvm-windows makes that easy)" : "Remove what you don't use from PATH in your shell's startup file, and keep one Node (fnm or nvm make that easy)") : undefined,
  });

  // Linux: the file-watch limit dev servers hit on big projects ("ENOSPC: System limit for number of file watchers reached").
  if (platform === "linux") {
    const limit = Number((readText("/proc/sys/fs/inotify/max_user_watches") ?? "").trim());
    if (limit) {
      checks.push({
        name: "File watchers",
        status: limit >= 65_536 ? "ok" : "warn",
        detail: limit >= 65_536 ? `fs.inotify.max_user_watches is ${limit}` : `fs.inotify.max_user_watches is ${limit}: a dev server on a big project can stop with "ENOSPC: System limit for number of file watchers reached"`,
        fix: limit >= 65_536 ? undefined : "echo fs.inotify.max_user_watches=524288 | sudo tee /etc/sysctl.d/50-dx-watches.conf && sudo sysctl --system",
      });
    }
    // WSL: projects on the Windows drive are slow to watch and to install into.
    const wsl = /microsoft|wsl/i.test(readText("/proc/version") ?? "");
    const onWinDrive = (options.roots ?? []).filter((r) => /^\/mnt\/[a-z](\/|$)/i.test(r));
    if (wsl) {
      checks.push({
        name: "WSL",
        status: onWinDrive.length ? "warn" : "ok",
        detail: onWinDrive.length ? `projects folder ${onWinDrive[0]} is on the Windows drive: file watching and installs are much slower than in Linux's own filesystem` : "running in WSL, projects are in Linux's filesystem",
        fix: onWinDrive.length ? "Move your projects to ~/projects inside WSL and dx config add-root ~/projects" : undefined,
      });
    }
  }
  return checks;
}
