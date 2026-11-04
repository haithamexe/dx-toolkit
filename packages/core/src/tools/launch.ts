import net from "node:net";
import { detached, winQuote } from "./detached.js";

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

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

/**
 * Opens a file in the editor at a line. VS Code and its relatives (Cursor, Windsurf, VSCodium)
 * jump to the line with `-g file:line:column`; other editors open the file.
 */
export async function openFileInEditor(file: string, line?: number, column?: number, editor = "code"): Promise<void> {
  const name = editor.replace(/^"|"$/g, "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const goto = /^(code|code-insiders|cursor|windsurf|codium|vscodium)(\.cmd|\.exe)?$/.test(name.split(/\s+/)[0]) && line;
  const target = goto ? `${file}:${line}${column ? `:${column}` : ""}` : file;
  const args = goto ? ["-g", target] : [target];
  if (isWin) {
    await detached(`${editor} ${args.map(winQuote).join(" ")}`, [], { shell: true, windowsHide: true });
    return;
  }
  await detached(editor, args, { shell: false });
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
