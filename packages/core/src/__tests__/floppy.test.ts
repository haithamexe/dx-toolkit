import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { after, test } from "node:test";

// Floppy: the PNG writer, the pixel art and its frames, the mood for what dx is doing, the
// Startup shortcut (in a temp folder posing as APPDATA) and the window script's syntax.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-floppy-home-"));
process.env.DX_HOME = home;
const { crc32, encodePng, pngToIco, parseColor } = await import("../tools/png.js");
const { FLOPPY_MOODS, FLOPPY_SPRITE, composeFloppy, floppyIcon16, writeFloppySprites, floppyView, newFloppyMemory, setFloppyStartup, floppyStartsWithWindows, floppyShortcutPath, openAppWindow, FLOPPY_SLEEP_MS } = await import("../tools/floppy.js");
const { FLOPPY_WINDOW_PS } = await import("../tools/floppyWindow.js");
type Snap = import("../tools/floppy.js").FloppySnapshot;

after(() => fs.rmSync(home, { recursive: true, force: true }));

test("PNG: the standard CRC, a valid header, and rows that inflate back to the pixels", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  const png = encodePng(2, 1, new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0]));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
  assert.equal(png.readUInt32BE(16), 2);
  assert.equal(png.readUInt32BE(20), 1);
  assert.equal(png[24], 8);
  assert.equal(png[25], 6, "RGBA");
  const idat = png.indexOf("IDAT");
  const len = png.readUInt32BE(idat - 4);
  assert.deepEqual([...zlib.inflateSync(png.subarray(idat + 4, idat + 4 + len))], [0, 255, 0, 0, 255, 0, 0, 0, 0]);
  assert.throws(() => encodePng(2, 2, new Uint8Array(4)), /Expected 16 bytes/);
  const ico = pngToIco(png, 2, 1);
  assert.equal(ico.readUInt16LE(2), 1, "an icon");
  assert.equal(ico.readUInt32LE(6 + 12), 22, "the PNG starts after the header and one entry");
  assert.deepEqual(parseColor("#00b000"), [0, 176, 0, 255]);
  assert.deepEqual(parseColor("rgba(0,0,0,0.28)"), [0, 0, 0, 71]);
});

test("every frame of every mood fits the 32 × 30 sprite, and the white edge only goes round the outside", () => {
  assert.deepEqual(FLOPPY_MOODS.map((m) => m.key), ["idle", "starting", "good", "error", "ai", "sleep", "held"]);
  for (const m of FLOPPY_MOODS) {
    assert.ok(m.frames.length >= 2, m.key);
    for (const f of m.frames) {
      const g = composeFloppy(f, true);
      assert.equal(g.length, FLOPPY_SPRITE.height);
      assert.ok(g.every((row) => row.length === FLOPPY_SPRITE.width));
      assert.ok(f.ms >= 70 && f.ms <= 700, `${m.key}: ${f.ms} ms`);
    }
  }
  const plain = composeFloppy(FLOPPY_MOODS[0].frames[0]);
  const edged = composeFloppy(FLOPPY_MOODS[0].frames[0], true);
  let added = 0;
  plain.forEach((row, y) => row.forEach((k, x) => {
    if (k !== edged[y][x]) {
      added++;
      assert.equal(edged[y][x], "O", "only edge pixels are added");
      assert.ok(k === "." || k === "x", "and only where there was nothing (or the shadow)");
    }
  }));
  assert.ok(added > 60);
  // The cut corner: top right of the body is empty, top left isn't.
  assert.equal(plain[5 + 1][2 + 21], ".");
  assert.equal(plain[5 + 1][2 + 2], "K");
  assert.equal(floppyIcon16().length, 18);
  // Starting fills the label's bar pixel by pixel.
  const bar = (i: number) => composeFloppy(FLOPPY_MOODS[1].frames[i])[5 + 20].filter((k) => k === "A").length;
  assert.deepEqual([bar(0), bar(4), bar(9)], [1, 5, 10]);
});

test("the frames are written once as PNGs with a manifest, and again only when the colours change", () => {
  const dir = path.join(home, "sprites");
  const m = writeFloppySprites(dir, "navy");
  assert.equal(m.moods.length, 7);
  assert.equal(m.width, 32);
  for (const mood of m.moods) for (const f of mood.frames) assert.equal(fs.readFileSync(path.join(dir, f.file)).subarray(1, 4).toString("ascii"), "PNG");
  assert.ok(fs.existsSync(path.join(dir, "floppy.ico")));
  const first = path.join(dir, m.moods[0].frames[0].file);
  const before = fs.statSync(first).mtimeMs;
  fs.utimesSync(first, new Date(1000), new Date(1000));
  writeFloppySprites(dir, "navy");
  assert.notEqual(fs.statSync(first).mtimeMs, before, "untouched the second time");
  assert.equal(writeFloppySprites(dir, "maroon").colourway, "maroon");
  assert.ok(fs.statSync(first).mtimeMs > 1_000_000, "drawn again for new colours");
});

test("the mood follows dx: starting, up (once), errors until you look, the AI, quiet and asleep", () => {
  const t = Date.parse("2026-11-06T10:00:00Z");
  const server = (status: "starting" | "ready" | "failed", extra = {}) => ({ project: "todo-app", dir: "/p/todo-app", status, startedBy: "dashboard", errorCount: 0, url: "http://todo-app.localhost", ...extra });
  let mem = newFloppyMemory(t);
  const step = (snap: Snap, at = t) => {
    const r = floppyView(snap, mem, at);
    mem = r.memory;
    return r.view;
  };

  // `status` is the line always beside Floppy: what's happening, and in which project.
  let v = step({ dashboard: false, servers: [] });
  assert.match(v.tip.text, /dx isn't running/);
  assert.deepEqual(v.status, { text: "dx isn't running", icon: "quiet" });
  v = step({ dashboard: true, servers: [server("starting", { step: "Install packages" })] });
  assert.deepEqual([v.mood, v.announce, v.tip.text, v.status.text], ["starting", true, "Install packages…", "todo-app: Install packages…"]);
  v = step({ dashboard: true, servers: [server("starting"), server("starting", { project: "api-gateway", dir: "/p/api-gateway" })] });
  assert.equal(v.announce, false, "said once");
  assert.equal(v.status.text, "Starting todo-app… (+1)");
  v = step({ dashboard: true, servers: [server("ready")] });
  assert.deepEqual([v.play, v.mood, v.tip.title, v.status.text], ["good", "idle", "todo-app is up", "todo-app is up at todo-app.localhost"]);
  v = step({ dashboard: true, servers: [server("ready")] });
  assert.equal(v.play, undefined, "the moment plays once");
  assert.match(v.tip.text, /1 server running: todo-app/);
  assert.deepEqual(v.status, { text: "todo-app running", icon: "ok" });
  const three = ["shop-website", "api-gateway"].map((p) => server("ready", { project: p, dir: `/p/${p}` }));
  assert.equal(step({ dashboard: true, servers: [server("ready"), three[0]] }).status.text, "todo-app, shop-website running");
  assert.equal(step({ dashboard: true, servers: [server("ready"), ...three] }).status.text, "3 servers running");
  assert.deepEqual(step({ dashboard: true, servers: [] }).status, { text: "Nothing running", icon: "quiet" });

  const broken: Snap = { dashboard: true, servers: [server("ready", { errorCount: 1 })], error: { project: "todo-app", dir: "/p/todo-app", id: "e1", message: "TypeError: cart is undefined\n    at x", file: "/p/todo-app/src/cart.ts", line: 42 } };
  v = step(broken);
  assert.deepEqual([v.mood, v.sticky, v.announce], ["error", true, true]);
  assert.equal(v.tip.text, "TypeError: cart is undefined · cart.ts:42. Click me to see it.");
  assert.deepEqual(v.status, { text: "todo-app: error in cart.ts:42", icon: "error" });
  assert.equal(step(broken).announce, false);
  mem = { ...mem, seen: ["/p/todo-app|e1"] };
  v = step(broken);
  assert.equal(v.mood, "idle", "looked at: no longer shown");
  assert.deepEqual(v.status, { text: "todo-app running · 1 error", icon: "error" }, "but still counted beside it");
  v = step({ dashboard: true, servers: [server("failed")] });
  assert.deepEqual([v.tip.title, v.status.text], ["todo-app stopped", "todo-app didn't start"]);

  v = step({ dashboard: true, servers: [], ai: { active: true, text: "Checked /health on api-gateway: 200" } });
  assert.deepEqual([v.mood, v.tip.text, v.status.text], ["ai", "Checked /health on api-gateway: 200", "AI: Checked /health on api-gateway: 200"]);
  assert.equal(step({ dashboard: true, servers: [], ai: { active: true, project: "api-gateway" } }).status.text, "AI agent on api-gateway");

  mem = { ...mem, quietUntil: t + 60 * 60_000 };
  v = step({ dashboard: true, servers: [server("ready")] });
  assert.equal(v.mood, "sleep");
  assert.match(v.status.text, /^Quiet until .+ · todo-app running$/);
  assert.equal(step({ dashboard: true, servers: [] }).mood, "sleep");
  assert.equal(step({ ...broken, error: { ...broken.error!, id: "e2" } }).mood, "error", "errors wake it");
  mem = { ...mem, quietUntil: undefined };
  step({ dashboard: true, servers: [] }, t);
  assert.equal(step({ dashboard: true, servers: [] }, t + FLOPPY_SLEEP_MS - 1000).mood, "idle");
  assert.equal(step({ dashboard: true, servers: [] }, t + FLOPPY_SLEEP_MS + 1000).mood, "sleep");
});

test("the Startup shortcut goes in the Startup folder and comes out again", { skip: process.platform === "win32" ? false : "Windows only" }, () => {
  const env = { APPDATA: path.join(home, "AppData", "Roaming") };
  const file = floppyShortcutPath(env)!;
  assert.ok(file.endsWith(path.join("Programs", "Startup", "dx Floppy.lnk")));
  const r = setFloppyStartup(true, { command: process.execPath, args: [path.join(home, "floppy app.js"), "--detach"] }, env);
  assert.equal(r.ok, true, r.message);
  assert.equal(floppyStartsWithWindows(env), true);
  assert.equal(setFloppyStartup(false, undefined, env).ok, true);
  assert.equal(floppyStartsWithWindows(env), false);
});

test("the window script parses, and only addresses on this computer open as an app window", async () => {
  assert.ok(!FLOPPY_WINDOW_PS.includes("`"), "no backticks: they'd end the template string");
  assert.ok(!FLOPPY_WINDOW_PS.includes("${"));
  await assert.rejects(openAppWindow("https://example.com/"), /on this computer/);
  if (process.platform !== "win32") return;
  const file = path.join(home, "floppy-window.ps1");
  fs.writeFileSync(file, FLOPPY_WINDOW_PS);
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:DX_PS, [ref]$null, [ref]$e); $e.Count"], { encoding: "utf8", env: { ...process.env, DX_PS: file }, windowsHide: true });
  assert.equal(r.stdout.trim(), "0", r.stdout + r.stderr);
});
