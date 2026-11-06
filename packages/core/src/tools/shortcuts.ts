import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Windows shortcuts (.lnk) in the user's own Start menu folders: the Startup shortcuts for Floppy
 * and the dx app. They're made through WScript.Shell, with every value passed in the environment,
 * so nothing in a path is ever read as PowerShell.
 */

/** What a shortcut starts: a program, its arguments, and the icon it shows. */
export interface ShortcutLaunch {
  command: string;
  args: string[];
  icon?: string;
}

/** The user's own Start menu Programs folder. */
export function startMenuFolder(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const appData = env.APPDATA || (env.USERPROFILE ? path.join(env.USERPROFILE, "AppData", "Roaming") : undefined);
  return appData ? path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs") : undefined;
}

/** Where Windows looks for programs to start when you sign in. */
export function startupFolder(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const programs = startMenuFolder(env);
  return programs ? path.join(programs, "Startup") : undefined;
}

const quoteArg = (a: string) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

/** The arguments as one command line, the way the shortcut stores them. */
export function shortcutArgs(args: string[]): string {
  return args.map(quoteArg).join(" ");
}

/** Writes a shortcut, minimised when `minimised`. Windows only. */
export function writeShortcut(file: string, launch: ShortcutLaunch, description: string, options: { minimised?: boolean } = {}): { ok: boolean; message: string } {
  if (process.platform !== "win32") return { ok: false, message: "Shortcuts are Windows-only for now." };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const script = [
    "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:DX_LNK)",
    "$s.TargetPath = $env:DX_LNK_TARGET",
    "$s.Arguments = $env:DX_LNK_ARGS",
    "$s.WorkingDirectory = $env:DX_LNK_DIR",
    "$s.WindowStyle = [int]$env:DX_LNK_STYLE",
    "$s.Description = $env:DX_LNK_DESC",
    "if ($env:DX_LNK_ICON) { $s.IconLocation = $env:DX_LNK_ICON }",
    "$s.Save()",
  ].join("; ");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      DX_LNK: file,
      DX_LNK_TARGET: launch.command,
      DX_LNK_ARGS: shortcutArgs(launch.args),
      DX_LNK_DIR: os.homedir(),
      DX_LNK_STYLE: options.minimised ? "7" : "1",
      DX_LNK_DESC: description,
      DX_LNK_ICON: launch.icon ?? "",
    },
  });
  if (r.status !== 0 || !fs.existsSync(file)) return { ok: false, message: `Couldn't add the shortcut: ${(r.stderr || r.error?.message || "PowerShell failed").trim().split("\n")[0]}` };
  return { ok: true, message: "Shortcut written." };
}
