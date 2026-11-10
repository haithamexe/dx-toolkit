// Floppy's window on macOS and Linux, run by the Electron dx installs for the app (~/.dx/app). On
// Windows the window is WPF (core's floppyWindow.ts); both speak the same JSON lines with
// Floppy's controller (web/src/floppyapp.ts): moods, tips and menu state come in on stdin, and
// clicks, moves and menu choices go out on stdout, by name only. Nothing that arrives is run.
//
// The window is a transparent strip along the bottom of the screen, always on top, with no Dock
// or taskbar button, that lets clicks through everywhere but Floppy, its balloon and its line
// (macOS: forwarded mouse events; Linux: the window's shape). The page is dx's own file, loaded
// sandboxed with context isolation, no Node, and a CSP that allows only its own script, style and
// the frames as data: images; it can't navigate or open windows. Its preload hands it two calls.
import { app, BrowserWindow, ipcMain, Menu, screen } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const spritesDir = process.env.DX_FLOPPY_DIR ?? "";
const home = process.env.DX_HOME || path.join(os.homedir(), ".dx");
const HEIGHT = 260;

app.setName("dx Floppy");
app.setPath("userData", path.join(home, "app", "floppy-data"));
// Transparent windows need the compositor; on Linux without one, the window is black, so ask for it.
if (process.platform === "linux") app.commandLine.appendSwitch("enable-transparent-visuals");

const send = (obj) => {
  try {
    process.stdout.write(JSON.stringify(obj) + "\n");
  } catch {
    // the controller is gone; stdin closing ends us
  }
};

/** The frames as data: URLs, read from dx's own sprites folder (a manifest dx wrote). */
function readFrames() {
  const manifest = JSON.parse(fs.readFileSync(path.join(spritesDir, "manifest.json"), "utf8"));
  const moods = manifest.moods.map((m) => ({
    key: String(m.key),
    once: !!m.once,
    frames: m.frames
      .filter((f) => /^[\w.-]+\.png$/.test(f.file))
      .map((f) => ({ src: `data:image/png;base64,${fs.readFileSync(path.join(spritesDir, f.file)).toString("base64")}`, ms: Number(f.ms) || 120 })),
  }));
  return { width: manifest.width, height: manifest.height, baseline: manifest.baseline, moods };
}

let win;
let menuState = { quiet: false, startup: false };

function place() {
  const area = screen.getPrimaryDisplay().workArea;
  win.setBounds({ x: area.x, y: area.y + area.height - HEIGHT, width: area.width, height: HEIGHT });
  return area;
}

function create() {
  win = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  });
  // Above other windows but, by default, not over a full-screen app's space: out of the way of a
  // video, a game or a presentation, as on Windows.
  win.setAlwaysOnTop(true, "floating");
  if (process.platform === "darwin") win.setVisibleOnAllWorkspaces(true);
  const area = place();
  if (process.platform !== "linux") win.setIgnoreMouseEvents(true, { forward: true });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  win.webContents.once("did-finish-load", () => {
    const startX = Number(process.env.DX_FLOPPY_X);
    win.webContents.send("floppy", { type: "init", sprite: readFrames(), x: Number.isFinite(startX) && process.env.DX_FLOPPY_X ? startX - area.x : undefined, width: area.width, height: HEIGHT });
    win.showInactive();
    send({ event: "ready", scale: screen.getPrimaryDisplay().scaleFactor });
  });
  win.loadFile(path.join(here, "index.html"));
  screen.on("display-metrics-changed", () => {
    const a = place();
    win.webContents.send("floppy", { type: "resize", width: a.width, height: HEIGHT });
  });
}

/** Events from the page, checked by name: nothing it sends is run. */
ipcMain.on("floppy", (_e, ev) => {
  if (!ev || typeof ev !== "object") return;
  if (ev.event === "hit" && process.platform !== "linux") win.setIgnoreMouseEvents(!ev.on, { forward: true });
  else if (ev.event === "shape" && process.platform === "linux" && Array.isArray(ev.rects)) {
    const rects = ev.rects
      .slice(0, 8)
      .map((r) => ({ x: Math.round(Number(r.x)), y: Math.round(Number(r.y)), width: Math.round(Number(r.width)), height: Math.round(Number(r.height)) }))
      .filter((r) => [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0);
    win.setShape(rects);
  } else if (ev.event === "click") send({ event: "click" });
  else if (ev.event === "moved" && Number.isFinite(ev.x)) send({ event: "moved", x: Math.round(ev.x + screen.getPrimaryDisplay().workArea.x) });
  else if (ev.event === "menu") {
    const item = (label, action, extra = {}) => ({ label, ...extra, click: (mi) => send({ event: "menu", action, checked: !!mi.checked }) });
    Menu.buildFromTemplate([
      item("Open dx", "open"),
      { type: "separator" },
      item("Quiet for an hour", "quiet", { type: "checkbox", checked: menuState.quiet }),
      item(process.platform === "darwin" ? "Open at login" : "Start when you sign in", "startup", { type: "checkbox", checked: menuState.startup }),
      { type: "separator" },
      item("Quit Floppy", "quit"),
    ]).popup({ window: win });
  }
});

app.whenReady().then(() => {
  // No Dock icon: Floppy is a sprite on the desktop, not an app you switch to.
  app.dock?.hide();
  create();
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg?.type === "menu") menuState = { quiet: !!msg.quiet, startup: !!msg.startup };
    if (msg?.type === "quit") return app.quit();
    if (msg && typeof msg.type === "string") win?.webContents.send("floppy", msg);
  });
  // The controller gone means Floppy goes too. (Electron's main process on Windows sees stdin end at
  // once, which is one reason Windows has its own window; there this file only runs in a smoke test.)
  if (process.platform !== "win32") process.stdin.on("end", () => app.quit());
});
app.on("window-all-closed", () => app.quit());
