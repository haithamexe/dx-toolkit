// The dx app: the dashboard in a window of its own. dx runs this folder with the Electron it
// installs in ~/.dx/app (core/src/tools/appshell.ts); web/src/app.ts starts it.
//
// The page is the dashboard itself, loaded from its own address on this computer, with the same
// token, CSP and checks as in a browser. This file only gives it a window, a taskbar icon and a
// Start menu entry, and keeps everything else out:
// - only the dashboard's own http address on loopback loads in the window (shellrules.js);
//   other http(s) addresses open in your browser, and nothing else opens at all;
// - the page runs sandboxed with context isolation: no Node, no preload, no <webview>;
// - no permission is granted but the clipboard, for the Copy buttons (shellrules' allowPermission);
// - the token is never seen here: it stays in ~/.dx/dashboard.json and the page's meta tag.
import { app, BrowserWindow, Menu, clipboard, nativeTheme, screen, session, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ID, RETRY_URL, WINDOW_SIZE, allowPermission, dashboardOrigin, isDashboardPage, outsideUrl, readShellArgs, stoppedPage, windowBounds } from "../dist/shellrules.js";

const home = process.env.DX_HOME || path.join(os.homedir(), ".dx");
const appDir = path.join(home, "app");
const ensureScript = fileURLToPath(new URL("../dist/ensure.js", import.meta.url));
const args = readShellArgs(process.argv);

app.setName("dx");
// Linux names the window by its launcher entry (dx writes ~/.local/share/applications/dx.desktop).
if (process.platform === "linux") app.setDesktopName("dx.desktop");
// Electron's own data (cache, local storage) next to the rest of the app, not in AppData\Roaming\Electron.
app.setPath("userData", path.join(appDir, "data"));
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

/** @type {BrowserWindow | undefined} */
let win;
/** The dashboard origin the window shows, once it shows one. */
let origin;
let stopped = false;

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};
const launchInfo = () => readJson(path.join(appDir, "launch.json")) ?? {};

/** Runs dx's ensure.js with dx's own node: the dashboard's address, started in the background if needed. */
function findDashboard() {
  return new Promise((resolve, reject) => {
    const node = launchInfo().node;
    if (!node || !fs.existsSync(node)) return reject(new Error("dx couldn't find Node.js. Open dx once with dx ui in a terminal."));
    if (!fs.existsSync(ensureScript)) return reject(new Error("dx isn't installed where this app was set up. Open dx with dx ui in a terminal."));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const child = spawn(node, [ensureScript], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.once("error", reject);
    child.once("close", () => {
      let answer;
      try {
        answer = JSON.parse(out.trim().split(/\r?\n/).pop() ?? "");
      } catch {
        // not JSON: say what it printed instead
      }
      if (answer?.url && dashboardOrigin(answer.url)) resolve(answer.url);
      else reject(new Error(answer?.error || err.trim().split(/\r?\n/)[0] || "The dashboard didn't start."));
    });
  });
}

/** Shows the dashboard: at `url` when dx gave one, otherwise wherever it runs (starting it). */
async function show(url) {
  let target = url && dashboardOrigin(url) ? url : undefined;
  if (!target) {
    try {
      target = await findDashboard();
    } catch (err) {
      showStopped(err.message);
      return;
    }
  }
  if (!win || win.isDestroyed()) return;
  stopped = false;
  origin = dashboardOrigin(target);
  try {
    await win.loadURL(target);
  } catch {
    // did-fail-load says what happened
  }
}

function showStopped(message) {
  if (!win || win.isDestroyed()) return;
  stopped = true;
  origin = undefined;
  void win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(stoppedPage(message, nativeTheme.shouldUseDarkColors))).catch(() => undefined);
}

function openOutside(url) {
  const safe = outsideUrl(url);
  if (safe) void shell.openExternal(safe).catch(() => undefined);
}

function iconPath() {
  const icon = launchInfo().icon;
  return typeof icon === "string" && fs.existsSync(icon) ? icon : undefined;
}

/** The Start menu entry, written by the app itself so it carries the taskbar id: a pinned dx stays one icon. */
function writeStartMenuEntry(icon) {
  if (process.platform !== "win32" || process.env.DX_HOME) return;
  const file = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "dx.lnk");
  const want = { target: process.execPath, args: `"${app.getAppPath()}"`, cwd: os.homedir(), description: "dx: your projects, dev servers and tools", appUserModelId: APP_ID, ...(icon ? { icon, iconIndex: 0 } : {}) };
  try {
    const have = fs.existsSync(file) ? shell.readShortcutLink(file) : undefined;
    if (have && have.target === want.target && have.args === want.args && have.appUserModelId === APP_ID && (have.icon ?? "") === (want.icon ?? "")) return;
    shell.writeShortcutLink(file, have ? "replace" : "create", want);
  } catch {
    // the Start menu is a convenience; the app works without it
  }
}

function saveWindow() {
  if (!win || win.isDestroyed()) return;
  try {
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, "window.json"), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }) + "\n");
  } catch {
    // next time it opens at the usual size
  }
}

function createWindow() {
  const saved = readJson(path.join(appDir, "window.json"));
  const bounds = windowBounds(saved, screen.getAllDisplays().map((d) => d.workArea), screen.getPrimaryDisplay().workArea);
  const icon = iconPath();
  win = new BrowserWindow({
    ...bounds,
    minWidth: WINDOW_SIZE.minWidth,
    minHeight: WINDOW_SIZE.minHeight,
    title: "dx",
    icon,
    show: false,
    // The desk teal behind the page, so it doesn't flash white while it loads.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#002828" : "#008080",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      // Electron's spellchecker downloads dictionaries on some systems; dx makes no requests of its own.
      spellcheck: false,
      safeDialogs: true,
      navigateOnDragDrop: false,
    },
  });
  // The menu is there for its shortcuts (reload, zoom, developer tools), not to be seen.
  win.setMenuBarVisibility(false);
  if (process.platform === "win32") {
    win.setAppDetails({ appId: APP_ID, relaunchCommand: `"${process.execPath}" "${app.getAppPath()}"`, relaunchDisplayName: "dx", ...(icon ? { appIconPath: icon, appIconIndex: 0 } : {}) });
  }

  let shown = false;
  // Windows gives a program's first window the show state the program was started with (hidden
  // or minimised, when a hidden launcher like Floppy's started it), whatever the window asks for;
  // the calls after it do what they say. So: show, then put it in the state it asked for.
  const settle = () => {
    if (win.isDestroyed()) return;
    if (args.minimized) {
      if (!win.isMinimized()) win.minimize();
      return;
    }
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    if (saved?.maximized && !win.isMaximized()) win.maximize();
    win.focus();
  };
  const reveal = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    if (args.minimized) win.minimize();
    else if (saved?.maximized) win.maximize();
    else win.show();
    settle();
    setTimeout(settle, 150);
  };
  win.once("ready-to-show", reveal);
  setTimeout(reveal, 4000);
  win.on("close", saveWindow);

  const contents = win.webContents;
  contents.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
    // -3 is a load that was replaced by another one, not a failure.
    if (!isMainFrame || code === -3 || stopped) return;
    showStopped(`Couldn't reach the dashboard at ${url} (${description}).`);
  });
  contents.on("render-process-gone", (_e, details) => {
    if (details.reason !== "clean-exit") contents.reload();
  });
  contents.on("context-menu", (_e, p) => {
    const items = [];
    if (p.isEditable) {
      items.push({ role: "cut", enabled: p.editFlags.canCut }, { role: "copy", enabled: p.editFlags.canCopy }, { role: "paste", enabled: p.editFlags.canPaste }, { type: "separator" }, { role: "selectAll" });
    } else if (p.selectionText) items.push({ role: "copy" });
    const link = p.linkURL && outsideUrl(p.linkURL);
    if (link) {
      if (items.length) items.push({ type: "separator" });
      items.push({ label: "Open in your browser", click: () => openOutside(link) }, { label: "Copy link address", click: () => clipboard.writeText(link) });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  void show(args.url);
  writeStartMenuEntry(icon);
}

// Every window and frame, whichever made it: nothing navigates away from the dashboard.
app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (e) => e.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (e, url) => {
    if (url === RETRY_URL) {
      e.preventDefault();
      void show();
      return;
    }
    if (isDashboardPage(url, origin)) return;
    e.preventDefault();
    openOutside(url);
  });
  contents.on("will-redirect", (e, url) => {
    if (!isDashboardPage(url, origin)) e.preventDefault();
  });
});

/** The dashboard can move (started again on another port) or stop; the window follows it. */
function watchDashboard() {
  setInterval(() => {
    if (!win || win.isDestroyed() || stopped || !origin) return;
    const info = readJson(path.join(home, "dashboard.json"));
    const running = info && typeof info.pid === "number" && alive(info.pid) ? dashboardOrigin(info.url ?? "") : undefined;
    if (!running) showStopped("The dashboard stopped. Its dev servers stopped with it.");
    else if (running !== origin) void show(info.url);
  }, 3000).unref();
}

function start() {
  // The clipboard for the Copy buttons, on the dashboard's own page; everything else is refused.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => callback(allowPermission(permission, details, origin)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission, _origin, details) => allowPermission(permission, details, origin));

  const view = { label: "View", submenu: [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] };
  Menu.setApplicationMenu(Menu.buildFromTemplate([...(process.platform === "darwin" ? [{ role: "appMenu" }] : []), { role: "editMenu" }, view, { role: "windowMenu" }]));

  createWindow();
  watchDashboard();
}

if (!app.requestSingleInstanceLock({ url: args.url })) {
  // dx is already open: the first one comes forward (below) and this one goes.
  app.quit();
} else {
  app.on("second-instance", (_e, argv, _cwd, data) => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    const url = (data && typeof data.url === "string" && dashboardOrigin(data.url) ? data.url : undefined) ?? readShellArgs(argv).url;
    if (stopped || (url && dashboardOrigin(url) !== origin)) void show(url);
  });
  app.on("window-all-closed", () => app.quit());
  app.on("activate", () => {
    if (!win || win.isDestroyed()) createWindow();
  });
  app.whenReady().then(start, (err) => {
    console.error(err);
    app.quit();
  });
}
