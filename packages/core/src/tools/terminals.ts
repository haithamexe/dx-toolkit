import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { detached, winQuote } from "./detached.js";
import { commandExists } from "./doctor.js";

/**
 * The terminals dx can open a project in. Each is found where it's usually installed (or on PATH),
 * and `terminal` in the config picks one; without it, the first one found here is used, which
 * is what dx always did: Windows Terminal (else Command Prompt), Terminal on macOS, the system's
 * default terminal on Linux.
 */
export interface TerminalInfo {
  id: string;
  name: string;
  installed: boolean;
  /** The one projects open in: the configured one when it's installed, else the first found. */
  selected: boolean;
}

interface Terminal {
  id: string;
  name: string;
  /** The program to run, when it's installed. */
  find(): Promise<string | undefined>;
  /** Opens a window in `dir`; `command`, when given, runs in it and the window stays open after. */
  open(exe: string, dir: string, command?: string, title?: string): Promise<void>;
}

const env = (name: string) => process.env[name] ?? "";
const existing = (...files: string[]) => files.find((f) => f && fs.existsSync(f));
const onPath = async (...names: string[]) => {
  for (const n of names) {
    const found = await commandExists(n);
    if (found) return found;
  }
  return undefined;
};
/** A macOS app bundle, in /Applications or ~/Applications. */
const macApp = (name: string) => existing(path.join("/Applications", `${name}.app`), path.join(os.homedir(), "Applications", `${name}.app`));

/** sh -c script that runs the command, then leaves an interactive shell open. */
const keepOpen = (command: string) => `${command}; exec "\${SHELL:-sh}" -l`;
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const appleScriptString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** `start "title" /D dir <program…>` through cmd.exe: a new classic console window. */
function startConsole(dir: string, title: string | undefined, program: string[]): Promise<void> {
  const args = ["/c", "start", `"${(title ?? "dx").replace(/"/g, "")}"`, "/D", winQuote(dir), ...program];
  return detached("cmd.exe", args, { shell: false, windowsVerbatimArguments: true, windowsHide: true });
}

const WINDOWS: Terminal[] = [
  {
    id: "windows-terminal",
    name: "Windows Terminal",
    find: async () => (await onPath("wt.exe")) ?? existing(path.join(env("LOCALAPPDATA"), "Microsoft", "WindowsApps", "wt.exe")),
    open: (exe, dir, command, title) => detached(exe, ["-w", "new", "-d", dir, ...(title ? ["--title", title] : []), ...(command ? ["cmd", "/k", command] : [])]),
  },
  {
    id: "cmd",
    name: "Command Prompt",
    find: async () => existing(path.join(env("SystemRoot") || "C:\\Windows", "System32", "cmd.exe")) ?? "cmd.exe",
    open: (_exe, dir, command, title) => startConsole(dir, title, ["cmd", "/k", ...(command ? [`"${command}"`] : [])]),
  },
  {
    id: "pwsh",
    name: "PowerShell 7",
    find: async () => (await onPath("pwsh.exe")) ?? existing(path.join(env("ProgramFiles"), "PowerShell", "7", "pwsh.exe")),
    // The quotes keep && and spaces inside the new window's command.
    open: (exe, dir, command, title) => startConsole(dir, title, [winQuote(exe), "-NoExit", ...(command ? ["-Command", `"${command.replace(/"/g, '\\"')}"`] : [])]),
  },
  {
    id: "powershell",
    name: "Windows PowerShell",
    find: async () => (await onPath("powershell.exe")) ?? existing(path.join(env("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")),
    open: (exe, dir, command, title) => startConsole(dir, title, [winQuote(exe), "-NoExit", ...(command ? ["-Command", `"${command.replace(/"/g, '\\"')}"`] : [])]),
  },
  {
    id: "git-bash",
    name: "Git Bash",
    find: async () =>
      existing(
        path.join(env("ProgramFiles"), "Git", "git-bash.exe"),
        path.join(env("ProgramFiles(x86)"), "Git", "git-bash.exe"),
        path.join(env("LOCALAPPDATA"), "Programs", "Git", "git-bash.exe"),
      ),
    open: (exe, dir, command) => detached(exe, [`--cd=${dir}`, ...(command ? ["-c", keepOpen(command)] : [])], { cwd: dir }),
  },
  {
    id: "wezterm",
    name: "WezTerm",
    find: async () => (await onPath("wezterm.exe")) ?? existing(path.join(env("ProgramFiles"), "WezTerm", "wezterm.exe")),
    open: (exe, dir, command) => detached(exe, ["start", "--cwd", dir, ...(command ? ["--", "cmd", "/k", command] : [])]),
  },
  {
    id: "alacritty",
    name: "Alacritty",
    find: async () => (await onPath("alacritty.exe")) ?? existing(path.join(env("ProgramFiles"), "Alacritty", "alacritty.exe")),
    open: (exe, dir, command) => detached(exe, ["--working-directory", dir, ...(command ? ["-e", "cmd", "/k", command] : [])]),
  },
];

const MAC: Terminal[] = [
  {
    id: "terminal",
    name: "Terminal",
    find: async () => "/System/Applications/Utilities/Terminal.app",
    open: (_exe, dir, command) => {
      const line = command ? `cd ${shQuote(dir)} && ${command}` : `cd ${shQuote(dir)}`;
      return detached("osascript", ["-e", `tell application "Terminal" to do script ${appleScriptString(line)}`, "-e", 'tell application "Terminal" to activate']);
    },
  },
  {
    id: "iterm",
    name: "iTerm2",
    find: async () => macApp("iTerm"),
    open: (_exe, dir, command) => {
      const line = command ? `cd ${shQuote(dir)} && ${command}` : `cd ${shQuote(dir)}`;
      return detached("osascript", [
        "-e", 'tell application "iTerm"',
        "-e", "activate",
        "-e", "set w to (create window with default profile)",
        "-e", `tell current session of w to write text ${appleScriptString(line)}`,
        "-e", "end tell",
      ]);
    },
  },
  {
    id: "warp",
    name: "Warp",
    find: async () => macApp("Warp"),
    // Warp opens a folder but can't be handed a command: for one, openTerminal uses the next terminal.
    open: (_exe, dir) => detached("open", ["-a", "Warp", dir]),
  },
  {
    id: "ghostty",
    name: "Ghostty",
    find: async () => macApp("Ghostty"),
    open: (_exe, dir, command) => detached("open", ["-na", "Ghostty", "--args", `--working-directory=${dir}`, ...(command ? ["-e", "/bin/sh", "-c", keepOpen(command)] : [])]),
  },
  {
    id: "kitty",
    name: "kitty",
    find: async () => (macApp("kitty") ? path.join(macApp("kitty")!, "Contents", "MacOS", "kitty") : await onPath("kitty")),
    open: (exe, dir, command) => detached(exe, ["--single-instance", "--directory", dir, ...(command ? ["/bin/sh", "-c", keepOpen(command)] : [])]),
  },
  {
    id: "wezterm",
    name: "WezTerm",
    find: async () => (macApp("WezTerm") ? path.join(macApp("WezTerm")!, "Contents", "MacOS", "wezterm") : await onPath("wezterm")),
    open: (exe, dir, command) => detached(exe, ["start", "--cwd", dir, ...(command ? ["--", "/bin/sh", "-c", keepOpen(command)] : [])]),
  },
  {
    id: "alacritty",
    name: "Alacritty",
    find: async () => (macApp("Alacritty") ? path.join(macApp("Alacritty")!, "Contents", "MacOS", "alacritty") : await onPath("alacritty")),
    open: (exe, dir, command) => detached(exe, ["--working-directory", dir, ...(command ? ["-e", "/bin/sh", "-c", keepOpen(command)] : [])]),
  },
];

/** Linux terminals: each takes the folder its own way, and a command through sh -c. */
const linux = (id: string, name: string, bin: string, folder: (dir: string) => string[], run: string[]): Terminal => ({
  id,
  name,
  find: () => onPath(bin),
  open: (exe, dir, command) => detached(exe, [...folder(dir), ...(command ? [...run, "sh", "-c", keepOpen(command)] : [])], { cwd: dir }),
});

const LINUX: Terminal[] = [
  {
    id: "default",
    name: "The system's default terminal",
    find: () => onPath("x-terminal-emulator"),
    open: (exe, dir, command) => detached(exe, ["-e", "sh", "-c", command ? `cd ${shQuote(dir)} && ${keepOpen(command)}` : `cd ${shQuote(dir)}; exec "\${SHELL:-sh}" -l`], { cwd: dir }),
  },
  linux("gnome-terminal", "GNOME Terminal", "gnome-terminal", (d) => [`--working-directory=${d}`], ["--"]),
  linux("konsole", "Konsole", "konsole", (d) => ["--workdir", d], ["-e"]),
  linux("xfce4-terminal", "Xfce Terminal", "xfce4-terminal", (d) => [`--working-directory=${d}`], ["-x"]),
  linux("tilix", "Tilix", "tilix", (d) => [`--working-directory=${d}`], ["-e"]),
  linux("ghostty", "Ghostty", "ghostty", (d) => [`--working-directory=${d}`], ["-e"]),
  linux("kitty", "kitty", "kitty", (d) => ["--directory", d], []),
  linux("wezterm", "WezTerm", "wezterm", (d) => ["start", "--cwd", d], ["--"]),
  linux("alacritty", "Alacritty", "alacritty", (d) => ["--working-directory", d], ["-e"]),
  linux("xterm", "xterm", "xterm", () => [], ["-e"]),
];

function known(): Terminal[] {
  return process.platform === "win32" ? WINDOWS : process.platform === "darwin" ? MAC : LINUX;
}

/** Which terminals this computer has, the one in use marked. */
export async function listTerminals(configured = loadConfig().terminal): Promise<TerminalInfo[]> {
  const found = await Promise.all(known().map(async (t) => ({ t, exe: await t.find() })));
  const chosen = found.find((f) => f.t.id === configured && f.exe) ?? found.find((f) => f.exe);
  return found.map((f) => ({ id: f.t.id, name: f.t.name, installed: !!f.exe, selected: f.t.id === chosen?.t.id }));
}

/** The ids dx knows on this system, for checking a setting. */
export function terminalIds(): string[] {
  return known().map((t) => t.id);
}

/**
 * Opens a new terminal window in `dir`, optionally running `command` in it and keeping the window
 * open afterwards. `terminal` (or the config's `terminal`) picks which; if that one isn't
 * installed or doesn't start, the first one that works is used.
 */
export async function openTerminal(dir: string, command?: string, title?: string, terminal?: string): Promise<string> {
  const wanted = terminal ?? loadConfig().terminal;
  const order = known();
  const candidates = [...order.filter((t) => t.id === wanted), ...order.filter((t) => t.id !== wanted)];
  let lastError: Error | undefined;
  for (const t of candidates) {
    // Warp can't be handed a command to run: for a command, the next one is used.
    if (command && t.id === "warp") continue;
    const exe = await t.find();
    if (!exe) continue;
    try {
      await t.open(exe, dir, command, title);
      return t.name;
    } catch (err) {
      lastError = err as Error;
    }
  }
  throw new Error(lastError ? `Couldn't open a terminal: ${lastError.message}` : "No terminal found. dx doctor says what to install.");
}
