import { spawn, type SpawnOptions } from "node:child_process";
import net from "node:net";

/** Starts a program without tying it to this process: dx can exit and the program keeps running. */
function detached(command: string, args: string[], options: SpawnOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const opts: SpawnOptions = { detached: true, stdio: "ignore", windowsHide: false, ...options };
    // With shell: true the whole command line is in `command`; passing an args array as well is deprecated.
    const child = opts.shell ? spawn(command, opts) : spawn(command, args, opts);
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

/** Quotes one argument for cmd.exe. */
function winQuote(arg: string): string {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/**
 * Opens a folder in the editor. `editor` is a command such as "code" or "cursor" (both are .cmd
 * files on Windows, so they go through the shell) or a full path in quotes.
 */
export async function openInEditor(dir: string, editor = "code"): Promise<void> {
  if (isWin) {
    await detached(`${editor} ${winQuote(dir)}`, [], { shell: true, windowsHide: true });
    return;
  }
  await detached(editor, [dir], { shell: false });
}

/** Opens a URL in the default browser. */
export async function openUrl(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw new Error(`Only http(s) URLs can be opened: ${url}`);
  if (isWin) return detached("rundll32.exe", ["url.dll,FileProtocolHandler", url]);
  if (isMac) return detached("open", [url]);
  return detached("xdg-open", [url]);
}

/** Opens the folder in File Explorer / Finder / the Linux file manager. */
export async function revealInFileManager(dir: string): Promise<void> {
  if (isWin) return detached("explorer.exe", [dir]);
  if (isMac) return detached("open", [dir]);
  return detached("xdg-open", [dir]);
}

/**
 * Opens a new terminal window in `dir`, optionally running `command` in it and keeping the window
 * open afterwards. Uses Windows Terminal when installed, plain cmd.exe otherwise.
 */
export async function openTerminal(dir: string, command?: string, title?: string): Promise<void> {
  if (isWin) {
    const wtArgs = ["-w", "new", "-d", dir];
    if (title) wtArgs.push("--title", title);
    if (command) wtArgs.push("cmd", "/k", command);
    try {
      await detached("wt.exe", wtArgs);
      return;
    } catch {
      // Windows Terminal isn't installed: fall back to a classic console window.
      // `start "title" /D dir cmd /k "command"`; the quotes keep && inside the new window's command.
      const args = ["/c", "start", `"${(title ?? "dx").replace(/"/g, "")}"`, "/D", winQuote(dir), "cmd", "/k"];
      if (command) args.push(`"${command}"`);
      await detached("cmd.exe", args, { shell: false, windowsVerbatimArguments: true, windowsHide: true });
      return;
    }
  }
  if (isMac) {
    const script = command
      ? `tell application "Terminal" to do script "cd ${escapeAppleScript(dir)} && ${escapeAppleScript(command)}"`
      : `tell application "Terminal" to do script "cd ${escapeAppleScript(dir)}"`;
    await detached("osascript", ["-e", script, "-e", 'tell application "Terminal" to activate']);
    return;
  }
  const shellCmd = command ? `cd '${dir}' && ${command}; exec $SHELL` : `cd '${dir}'; exec $SHELL`;
  await detached("x-terminal-emulator", ["-e", "sh", "-c", shellCmd]);
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** True if something accepts TCP connections on localhost:port (IPv4 or IPv6). */
export async function isPortOpen(port: number, timeoutMs = 400): Promise<boolean> {
  for (const host of ["127.0.0.1", "::1"]) {
    if (await tryConnect(host, port, timeoutMs)) return true;
  }
  return false;
}

/** Waits until localhost:port accepts connections. Resolves false on timeout or abort. */
export async function waitForPort(
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    if (await isPortOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 750));
  }
  return false;
}

function tryConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
