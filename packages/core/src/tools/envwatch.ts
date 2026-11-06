import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { appStartMenuShortcut } from "./appshell.js";
import { findEnvFiles, isExampleFile } from "./envaudit.js";
import { gitRun } from "./git.js";

/**
 * Warnings about a project's .env files: one changed, one staged for the next commit, or one in a
 * commit just made. The dashboard looks every few seconds with cheap reads (the files' times, git's
 * index and reflog times); git itself runs only when the index or HEAD moved. A first look at a
 * project only remembers, so nothing is said about what was already there.
 */

export type EnvAlertKind = "changed" | "staged" | "committed";

export interface EnvAlert {
  id: number;
  at: string;
  project: string;
  dir: string;
  kind: EnvAlertKind;
  files: string[];
  commit?: string;
  /** The warning in words, for the dashboard, Floppy and the system's notification. */
  title: string;
  text: string;
}

/** Whether a project's alerts are on, and its system notifications: on unless turned off (globally with envAlerts, or for the project). */
export function alertSettings(dir: string, config: { envAlerts?: boolean; projectAlerts?: Record<string, { off?: boolean; osOff?: boolean }> }): { on: boolean; os: boolean } {
  const p = config.projectAlerts?.[path.resolve(dir).toLowerCase()];
  const on = config.envAlerts !== false && !p?.off;
  return { on, os: on && !p?.osOff };
}

/** A .env file, by its name: `.env`, `.env.local`, `config/.env.production`, not the examples. */
export function isEnvFileName(rel: string): boolean {
  const base = rel.split(/[\\/]/).pop() ?? rel;
  return /^\.env(\..+)?$/.test(base) && !isExampleFile(base);
}

interface Seen {
  files: Map<string, string>;
  looks: number;
  gitDir?: string | null;
  index?: number;
  /** How far into git's log of HEAD (logs/HEAD, only ever appended to) the last look read. */
  reflogSize?: number;
  staged: Set<string>;
}

const mtimeOf = (file: string): number | undefined => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
};

/** The words for a warning: what happened, and what to do about it. */
export function envAlertWords(project: string, kind: EnvAlertKind, files: string[], commit?: string): { title: string; text: string } {
  const names = files.slice(0, 3).join(", ") + (files.length > 3 ? ` and ${files.length - 3} more` : "");
  if (kind === "committed") return { title: `${project}: a .env file was committed`, text: `${names} went into commit ${commit?.slice(0, 7) ?? ""}. Take it out of git (git rm --cached) and change the secrets in it.` };
  if (kind === "staged") return { title: `${project}: a .env file is staged`, text: `${names} would go into the next commit. Unstage it before you commit, and add it to .gitignore.` };
  return { title: `${project}: a .env file changed`, text: `${names} changed just now.` };
}

export class EnvWatcher {
  private seen = new Map<string, Seen>();
  private seq = 0;
  private lastSaid = new Map<string, number>();
  readonly alerts: EnvAlert[] = [];

  constructor(private readonly onAlert: (a: EnvAlert) => void = () => {}) {}

  /** Forgets a project (its alerts were turned off): its next look only remembers again. */
  forget(dir: string): void {
    this.seen.delete(path.resolve(dir).toLowerCase());
  }

  /** One look at these projects; returns what's new. */
  async check(projects: { name: string; dir: string; hasGit?: boolean }[]): Promise<EnvAlert[]> {
    const out: EnvAlert[] = [];
    for (const p of projects) {
      try {
        out.push(...(await this.look(p)));
      } catch {
        // a project that went away, or a git that's busy: next time
      }
    }
    return out;
  }

  private async look(p: { name: string; dir: string; hasGit?: boolean }): Promise<EnvAlert[]> {
    const key = path.resolve(p.dir).toLowerCase();
    const first = !this.seen.has(key);
    const s: Seen = this.seen.get(key) ?? { files: new Map(), looks: 0, staged: new Set() };
    this.seen.set(key, s);
    const said: EnvAlert[] = [];

    // The files: found again every sixth look (a folder walk), their times every look.
    const names = s.looks % 6 === 0 ? findEnvFiles(p.dir).filter(isEnvFileName) : [...s.files.keys()];
    s.looks++;
    const changed: string[] = [];
    const now = new Map<string, string>();
    for (const rel of names) {
      try {
        const st = fs.statSync(path.join(p.dir, rel));
        const sig = `${st.mtimeMs}:${st.size}`;
        now.set(rel, sig);
        if (!first && s.files.get(rel) !== sig) changed.push(rel);
      } catch {
        // deleted
      }
    }
    s.files = now;
    if (changed.length) said.push(...this.say(p, "changed", changed));

    // git: the index (staged) and HEAD (committed), only when their files moved.
    if (p.hasGit === false) return said;
    if (s.gitDir === undefined) {
      const r = await gitRun(p.dir, ["rev-parse", "--absolute-git-dir"]);
      s.gitDir = r.code === 0 ? r.stdout.trim() : null;
    }
    if (!s.gitDir) return said;
    const index = mtimeOf(path.join(s.gitDir, "index"));
    if (index !== s.index) {
      s.index = index;
      const r = await gitRun(p.dir, ["diff", "--cached", "--name-only", "-z", "--relative"]);
      const staged = new Set(r.code === 0 ? r.stdout.split("\0").filter((f) => f && isEnvFileName(f)) : []);
      const fresh = [...staged].filter((f) => !s.staged.has(f));
      s.staged = staged;
      if (!first && fresh.length) said.push(...this.say(p, "staged", fresh));
    }
    // Every commit made here since the last look (commit, amend, merge), not a checkout or a pull,
    // by the reflog's own word: the lines git added to logs/HEAD, so a commit followed at once by a
    // pull --rebase or a checkout still counts. Shrunk (expired or cleaned): read from here on.
    const reflogFile = path.join(s.gitDir, "logs", "HEAD");
    let size = 0;
    try {
      size = fs.statSync(reflogFile).size;
    } catch {
      // no commits yet
    }
    if (size !== s.reflogSize) {
      const from = s.reflogSize !== undefined && size > s.reflogSize ? s.reflogSize : undefined;
      s.reflogSize = size;
      if (!first && from !== undefined) {
        for (const commit of commitsInReflog(reflogFile, from, size)) {
          const r = await gitRun(p.dir, ["show", "--name-only", "--format=", "--relative", "-z", commit]);
          const files = r.code === 0 ? r.stdout.split("\0").map((f) => f.trim()).filter((f) => f && isEnvFileName(f)) : [];
          if (files.length) said.push(...this.say(p, "committed", files, commit));
        }
      }
    }
    return said;
  }

  /** Keeps the warning (the last 50) and says it, at most once in 10 seconds for a project and kind. */
  private say(p: { name: string; dir: string }, kind: EnvAlertKind, files: string[], commit?: string): EnvAlert[] {
    const k = `${p.dir.toLowerCase()}|${kind}`;
    const nowMs = Date.now();
    if (nowMs - (this.lastSaid.get(k) ?? 0) < 10_000 && kind === "changed") return [];
    this.lastSaid.set(k, nowMs);
    const a: EnvAlert = { id: ++this.seq, at: new Date(nowMs).toISOString(), project: p.name, dir: p.dir, kind, files, ...(commit ? { commit } : {}), ...envAlertWords(p.name, kind, files, commit) };
    this.alerts.push(a);
    if (this.alerts.length > 50) this.alerts.splice(0, this.alerts.length - 50);
    this.onAlert(a);
    return [a];
  }
}

/** The commits that lines added to a reflog file (from one size to another) record: at most the last 20, read up to 1 MB. */
export function commitsInReflog(file: string, from: number, to: number): string[] {
  const start = Math.max(from, to - 1024 * 1024);
  const buf = Buffer.alloc(to - start);
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, buf.length, start);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  // A line: <old> <new> <who> <when> <zone>\t<what>; only the new commit and the "what" are read.
  return buf
    .toString("utf8")
    .split("\n")
    .flatMap((line) => {
      const tab = line.indexOf("\t");
      const next = line.split(" ")[1] ?? "";
      return tab > 0 && /^commit\b/.test(line.slice(tab + 1)) && /^[0-9a-f]{40,64}$/.test(next) ? [next] : [];
    })
    .slice(-20);
}

// ------------------------------------------------------------------ the system's notifications

const WINDOWS_TOAST = [
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
  "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
  "$t = [Security.SecurityElement]::Escape($env:DX_NOTE_TITLE)",
  "$b = [Security.SecurityElement]::Escape($env:DX_NOTE_TEXT)",
  "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
  "$xml.LoadXml('<toast><visual><binding template=\"ToastGeneric\"><text>' + $t + '</text><text>' + $b + '</text></binding></visual><audio src=\"ms-winsoundevent:Notification.Default\"/></toast>')",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:DX_NOTE_APP).Show([Windows.UI.Notifications.ToastNotification]::new($xml))",
].join("\n");

/** Windows PowerShell's own id, for when the dx app (and its Start menu entry) isn't installed. */
const POWERSHELL_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

/**
 * A notification from the system itself: a Windows toast (as the dx app when it's installed), a
 * macOS notification, or notify-send on Linux. The words go in as data (environment variables or
 * arguments), never as part of a command. Not while DX_HOME is set: tests and demo homes stay quiet.
 */
export function notifyOs(title: string, text: string, options: { platform?: NodeJS.Platform; run?: (file: string, args: string[], env: NodeJS.ProcessEnv, input?: string) => void } = {}): boolean {
  if (process.env.DX_HOME && !options.run) return false;
  const platform = options.platform ?? process.platform;
  const run =
    options.run ??
    ((file: string, args: string[], env: NodeJS.ProcessEnv, input?: string) => {
      try {
        const child = spawn(file, args, { env, windowsHide: true, stdio: [input === undefined ? "ignore" : "pipe", "ignore", "ignore"] });
        child.on("error", () => {});
        if (input !== undefined) child.stdin?.end(input);
        child.unref();
      } catch {
        // no notifier on this system
      }
    });
  // A project named "-x…" mustn't read as an option to osascript or notify-send.
  const word = (v: string, max: number) => v.slice(0, max).replace(/^-/, " -");
  const t = word(title, 120);
  const b = word(text, 400);
  if (platform === "win32") {
    const shortcut = appStartMenuShortcut();
    const app = shortcut && fs.existsSync(shortcut) ? "dx.dashboard" : POWERSHELL_APP_ID;
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], { ...process.env, DX_NOTE_TITLE: t, DX_NOTE_TEXT: b, DX_NOTE_APP: app }, WINDOWS_TOAST);
    return true;
  }
  if (platform === "darwin") {
    run("/usr/bin/osascript", ["-e", "on run argv", "-e", 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Basso"', "-e", "end run", t, b], process.env);
    return true;
  }
  run("notify-send", ["--urgency=critical", "--app-name=dx", "--", t, b], process.env);
  return true;
}
