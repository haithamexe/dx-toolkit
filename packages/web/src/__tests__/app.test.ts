import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

// The dx app's window: what it loads, what it hands to the browser, where it opens, and that
// web/shell/main.js parses and uses only what shellrules exports. Electron itself never runs here.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-app-home-"));
process.env.DX_HOME = home;
const rules = await import("../shellrules.js");
const { appShellDir, canWriteShortcuts, openDxApp } = await import("../app.js");

after(() => fs.rmSync(home, { recursive: true, force: true }));

test("the window loads the dashboard's own http address on loopback, and nothing else", () => {
  assert.equal(rules.dashboardOrigin("http://127.0.0.1:4646/#/projects"), "http://127.0.0.1:4646");
  assert.equal(rules.dashboardOrigin("http://localhost:4646/"), "http://localhost:4646");
  assert.equal(rules.dashboardOrigin("http://[::1]:4646/"), "http://[::1]:4646");
  for (const bad of ["https://127.0.0.1:4646/", "http://shop.localhost/", "http://192.168.1.4:4646/", "http://user:pw@127.0.0.1:4646/", "file:///C:/dx/index.html", "javascript:alert(1)", "data:text/html,hi", "not a url"]) {
    assert.equal(rules.dashboardOrigin(bad), undefined, bad);
  }
  const origin = "http://127.0.0.1:4646";
  assert.equal(rules.isDashboardPage("http://127.0.0.1:4646/#/git", origin), true);
  assert.equal(rules.isDashboardPage("http://127.0.0.1:4647/", origin), false, "another port is another program");
  assert.equal(rules.isDashboardPage("http://127.0.0.1:4646/", undefined), false, "nothing loads before the dashboard is known");
});

test("links out go to your browser only when they're http(s)", () => {
  assert.equal(rules.outsideUrl("https://github.com/octocat/todo-app/pull/7"), "https://github.com/octocat/todo-app/pull/7");
  assert.equal(rules.outsideUrl("http://shop.localhost/cart"), "http://shop.localhost/cart");
  for (const bad of ["file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "ms-settings:privacy", "vscode://file/x", "http://user:pw@example.com/", rules.RETRY_URL, "nope"]) {
    assert.equal(rules.outsideUrl(bad), undefined, bad);
  }
});

test("the clipboard, for the Copy buttons on the dashboard's own page, is the only permission", () => {
  const origin = "http://127.0.0.1:4646";
  const page = { isMainFrame: true, requestingUrl: "http://127.0.0.1:4646/#/projects" };
  assert.equal(rules.allowPermission("clipboard-read", page, origin), true, "Electron's name for writeText");
  assert.equal(rules.allowPermission("clipboard-sanitized-write", page, origin), true);
  for (const other of ["geolocation", "notifications", "media", "openExternal", "fullscreen", "hid", "serial", "usb"]) assert.equal(rules.allowPermission(other, page, origin), false, other);
  assert.equal(rules.allowPermission("clipboard-read", { isMainFrame: false, requestingUrl: page.requestingUrl }, origin), false, "not a frame");
  assert.equal(rules.allowPermission("clipboard-read", { isMainFrame: true, requestingUrl: "http://127.0.0.1:5173/" }, origin), false, "not another page");
  assert.equal(rules.allowPermission("clipboard-read", page, undefined), false, "not before the dashboard is known");
  assert.equal(rules.allowPermission("clipboard-read", undefined, origin), false);
});

test("the window opens where you left it, on a screen you still have, or centred", () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };
  const second = { x: 1920, y: 0, width: 1280, height: 984 };
  assert.deepEqual(rules.windowBounds(undefined, [primary], primary), { x: 300, y: 80, width: 1320, height: 880 });
  assert.deepEqual(rules.windowBounds({ x: 2000, y: 40, width: 1100, height: 700 }, [primary, second], primary), { x: 2000, y: 40, width: 1100, height: 700 });
  assert.deepEqual(rules.windowBounds({ x: 2000, y: 40, width: 1100, height: 700 }, [primary], primary), { x: 300, y: 80, width: 1320, height: 880 }, "its screen is gone");
  assert.deepEqual(rules.windowBounds({ x: 10, y: 10, width: 5000, height: 300 }, [primary], primary), { x: 10, y: 10, width: 1920, height: 520 }, "no bigger than the screen, no smaller than the minimum");
  const small = { x: 0, y: 0, width: 1024, height: 700 };
  assert.deepEqual(rules.windowBounds(undefined, [small], small), { x: 24, y: 24, width: 976, height: 652 });
  assert.deepEqual(rules.windowBounds({ x: Number.NaN, y: 0, width: 1, height: 1 } as never, [primary], primary).width, 1320);
});

test("dx's arguments: only a dashboard address, and whether to start on the taskbar", () => {
  assert.deepEqual(rules.readShellArgs(["electron.exe", "C:\\dx\\shell", "--url=http://127.0.0.1:4646/", "--minimized"]), { url: "http://127.0.0.1:4646/", minimized: true });
  assert.deepEqual(rules.readShellArgs(["electron.exe", "shell", "--url=https://example.com/"]), { url: undefined, minimized: false });
});

test("the stopped page is static and locked down, and escapes what it says", () => {
  const html = rules.stoppedPage(`Couldn't reach <script>alert(1)</script> "here"`, false);
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(!html.includes("<script"), "no script, even from the message");
  assert.ok(html.includes("&#60;script&#62;"));
  assert.ok(html.includes(`href="${rules.RETRY_URL}"`));
  assert.ok(rules.stoppedPage("x", true).includes("#002828"), "dark when the system is");
});

test("the window's code parses and imports only what shellrules exports", () => {
  const shell = appShellDir();
  const main = path.join(shell, "main.js");
  const pkg = JSON.parse(fs.readFileSync(path.join(shell, "package.json"), "utf8"));
  assert.equal(pkg.main, "main.js");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.version, undefined, "no version to forget at release time");
  const check = spawnSync(process.execPath, ["--check", main], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  const source = fs.readFileSync(main, "utf8");
  const imported = /import \{([^}]+)\} from "\.\.\/dist\/shellrules\.js"/.exec(source);
  assert.ok(imported, "it loads the rules from dist");
  for (const name of imported[1].split(",").map((s) => s.trim()).filter(Boolean)) assert.ok(name in rules, `shellrules exports ${name}`);
  assert.ok(fs.existsSync(fileURLToPath(new URL("../ensure.js", import.meta.url))), "ensure.js is built next to it");
  for (const unsafe of ["nodeIntegration: true", "contextIsolation: false", "sandbox: false", "webSecurity: false", "allowRunningInsecureContent"]) assert.ok(!source.includes(unsafe), unsafe);
});

test("only addresses on this computer open in the app, and shortcuts wait for the everyday ~/.dx", async () => {
  await assert.rejects(openDxApp("http://example.com/"), /this computer/);
  assert.equal(canWriteShortcuts(), false, "DX_HOME is set in tests");
});

test("the window's taskbar id is the one the program and its Start menu entry carry", async () => {
  const { APP_PROGRAM } = await import("@dx/core");
  assert.equal(rules.APP_ID, APP_PROGRAM.id);
});
