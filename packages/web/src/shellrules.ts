/**
 * What the dx app's window (web/shell/main.js, run by Electron) allows, as plain functions with no
 * imports, so the window can load them and the tests can check them. The window shows the
 * dashboard and nothing else: only its own http address on loopback is loaded in it; other
 * http(s) addresses open in your browser; anything else goes nowhere.
 */

/** The taskbar id the app's window and its Start menu entry share, so a pinned dx stays one icon. */
export const APP_ID = "dx.dashboard";

/** The link on the "dx isn't running" page. `.invalid` never resolves; the window catches it before any request. */
export const RETRY_URL = "http://dx-app.invalid/start";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The dashboard's origin, when `url` is one the window may load: http, on loopback, without user:password. */
export function dashboardOrigin(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" || !LOOPBACK.has(u.hostname) || u.username || u.password) return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

/** A page of the dashboard the window is showing (another port is another program). */
export function isDashboardPage(url: string, origin: string | undefined): boolean {
  return !!origin && dashboardOrigin(url) === origin;
}

/** An address to hand to your browser: http(s) only, without user:password. Anything else is dropped. */
export function outsideUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.href === RETRY_URL) return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

/**
 * The one permission the window grants: the clipboard, for the Copy buttons, to the dashboard's
 * own page and not its frames. Electron asks for "clipboard-read" even for a write
 * (navigator.clipboard.writeText), so that's the name allowed; the page never reads the clipboard.
 */
export function allowPermission(permission: string, details: { isMainFrame?: boolean; requestingUrl?: string } | undefined, origin: string | undefined): boolean {
  return (permission === "clipboard-read" || permission === "clipboard-sanitized-write") && details?.isMainFrame !== false && isDashboardPage(details?.requestingUrl ?? "", origin);
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SavedWindow {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  maximized?: boolean;
}

export const WINDOW_SIZE = { width: 1320, height: 880, minWidth: 720, minHeight: 520 };

/**
 * Where the window opens: where you left it, if its title bar is still on a screen you have
 * (screens come and go with laptops), and no bigger than that screen; otherwise centred on the
 * main screen at the usual size.
 */
export function windowBounds(saved: SavedWindow | undefined, screens: Rect[], primary: Rect): Rect {
  const num = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  if (saved && num(saved.x) && num(saved.y) && num(saved.width) && num(saved.height)) {
    const bar = { x: saved.x, y: saved.y, width: saved.width, height: 32 };
    const on = screens.find((s) => overlap(bar, s) >= Math.min(bar.width, 160) * 16);
    if (on) {
      const width = Math.round(Math.max(WINDOW_SIZE.minWidth, Math.min(saved.width, on.width)));
      const height = Math.round(Math.max(WINDOW_SIZE.minHeight, Math.min(saved.height, on.height)));
      return { x: Math.round(saved.x), y: Math.round(saved.y), width, height };
    }
  }
  const width = Math.min(WINDOW_SIZE.width, Math.max(WINDOW_SIZE.minWidth, primary.width - 48));
  const height = Math.min(WINDOW_SIZE.height, Math.max(WINDOW_SIZE.minHeight, primary.height - 48));
  return { x: Math.round(primary.x + (primary.width - width) / 2), y: Math.round(primary.y + (primary.height - height) / 2), width, height };
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The arguments dx passes the window: the dashboard's address, and whether to start on the taskbar. */
export function readShellArgs(argv: string[]): { url?: string; minimized: boolean } {
  let url: string | undefined;
  for (const a of argv) if (a.startsWith("--url=")) url = a.slice(6);
  return { url: url && dashboardOrigin(url) ? url : undefined, minimized: argv.includes("--minimized") };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The page the window shows when the dashboard isn't running: static, no script, its own
 * locked-down policy; its one link is RETRY_URL, which the window takes as "start it".
 */
export function stoppedPage(message: string, dark: boolean): string {
  const [desk, sheet, ink, dim, accent] = dark ? ["#002828", "#0d1a1a", "#e6f2f1", "#9bb5b3", "#6fcbc5"] : ["#008080", "#ffffff", "#0f1f1f", "#4d6362", "#006a6a"];
  return [
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\">",
    "<title>dx</title><style>",
    `html,body{height:100%;margin:0}body{background:${desk};display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;color:${ink}}`,
    `main{background:${sheet};padding:32px 40px;max-width:440px;border:1px solid rgb(0 0 0 / .25);box-shadow:4px 4px 0 rgb(0 0 0 / .25)}`,
    `h1{font-size:20px;margin:0 0 8px}p{margin:0 0 20px;color:${dim}}`,
    `a{display:inline-block;background:${accent};color:${dark ? "#002828" : "#ffffff"};text-decoration:none;padding:8px 16px;font-weight:600}a:focus-visible{outline:2px solid ${ink};outline-offset:2px}`,
    "</style></head><body><main>",
    "<h1>dx isn't running</h1>",
    `<p>${escapeHtml(message)}</p>`,
    `<a href="${RETRY_URL}">Start dx</a>`,
    "</main></body></html>",
  ].join("");
}
