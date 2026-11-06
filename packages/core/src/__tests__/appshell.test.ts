import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The dx app's Electron: finding it, runtime folders and the `current` link, removing old
// versions, the fixed install and naming arguments, the icons, and the sign-in entries on each
// system (in temp folders posing as APPDATA and HOME). Nothing is downloaded or run.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-appshell-home-"));
process.env.DX_HOME = home;
const shell = await import("../tools/appshell.js");
const { ELECTRON_VERSION, RCEDIT_VERSION, APP_PROGRAM } = shell;
const { writeFloppySprites } = await import("../tools/floppy.js");

after(() => fs.rmSync(home, { recursive: true, force: true }));

/** An Electron install as npm and Electron's own step leave it, in npm folder `dir`. */
function fakeElectron(dir: string, version: string, rel = "electron.exe"): string {
  const pkg = path.join(dir, "node_modules", "electron");
  fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "electron", version }));
  fs.writeFileSync(path.join(pkg, "path.txt"), rel);
  const program = path.join(pkg, "dist", rel);
  if (!rel.includes("..")) {
    fs.mkdirSync(path.dirname(program), { recursive: true });
    fs.writeFileSync(program, "");
  }
  return program;
}

function fakeRcedit(dir: string): void {
  const bin = path.join(dir, "node_modules", "rcedit", "bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const f of ["rcedit.exe", "rcedit-x64.exe"]) fs.writeFileSync(path.join(bin, f), "");
}

test("Electron is found by its own path.txt, never outside its folder", () => {
  assert.equal(shell.appHome(), path.join(home, "app"));
  const dir = path.join(home, "found");
  assert.equal(shell.findElectron(dir), undefined, "nothing installed");
  const program = fakeElectron(dir, ELECTRON_VERSION);
  assert.deepEqual(shell.findElectron(dir, "linux"), { path: program, version: ELECTRON_VERSION, current: true, dir, dist: path.dirname(program) });
  fs.rmSync(program);
  assert.equal(shell.findElectron(dir), undefined, "the program itself must be there");
  const odd = path.join(home, "odd");
  fakeElectron(odd, ELECTRON_VERSION, "../../outside.exe");
  assert.equal(shell.findElectron(odd), undefined);
});

test("each version has its runtime folder; the pinned one comes first, then the newest", () => {
  const app = path.join(home, "versions");
  fakeElectron(app, "43.1.0"); // the layout before runtime folders
  fakeElectron(shell.runtimeDir("44.10.2", app), "44.10.2");
  assert.equal(shell.findElectron(app)?.version, "44.10.2", "newest when the pinned one isn't there");
  assert.equal(shell.findElectron(app)?.current, false);
  fakeElectron(shell.runtimeDir(ELECTRON_VERSION, app), ELECTRON_VERSION);
  fs.mkdirSync(path.join(app, "runtime", "not-a-version"), { recursive: true });
  assert.deepEqual(shell.listElectrons(app).map((e) => e.version), [ELECTRON_VERSION, "44.10.2", "43.1.0"]);
  assert.equal(shell.findElectron(app)?.dir, shell.runtimeDir(ELECTRON_VERSION, app));
});

test("the app is named dx.exe on Windows and dx.app on macOS once it's been named", () => {
  const dir = path.join(home, "named");
  const original = fakeElectron(dir, ELECTRON_VERSION);
  const dist = path.dirname(original);
  fs.writeFileSync(path.join(dist, APP_PROGRAM.file), "");
  assert.equal(shell.findElectron(dir, "win32")?.path, path.join(dist, APP_PROGRAM.file));
  assert.equal(shell.findElectron(dir, "linux")?.path, original);
  const mac = path.join(dist, APP_PROGRAM.bundle, "Contents", "MacOS", "Electron");
  fs.mkdirSync(path.dirname(mac), { recursive: true });
  fs.writeFileSync(mac, "");
  assert.equal(shell.findElectron(dir, "darwin")?.path, mac);
});

test("`current` points at the Electron in use, and shortcuts start the app through it", () => {
  const app = path.join(home, "linked");
  fakeElectron(shell.runtimeDir("44.10.2", app), "44.10.2");
  const old = shell.findElectron(app)!;
  assert.equal(shell.linkedProgram(old, app), old.path, "no link yet: the program itself");
  assert.equal(shell.pointCurrentAt(old, app), true);
  assert.equal(shell.linkedProgram(old, app), path.join(shell.currentLink(app), path.basename(old.path)));
  fakeElectron(shell.runtimeDir(ELECTRON_VERSION, app), ELECTRON_VERSION);
  const now = shell.findElectron(app)!;
  assert.equal(shell.linkedProgram(now, app), now.path, "the link still points at the old one");
  assert.equal(shell.pointCurrentAt(now, app), true, "moved");
  assert.equal(shell.linkedProgram(now, app), path.join(shell.currentLink(app), path.basename(now.path)));
  assert.ok(fs.existsSync(path.join(shell.currentLink(app), path.basename(now.path))));
  assert.ok(fs.existsSync(old.path), "moving the link leaves the old Electron where it was");

  const blocked = path.join(home, "blocked");
  fakeElectron(shell.runtimeDir(ELECTRON_VERSION, blocked), ELECTRON_VERSION);
  fs.mkdirSync(shell.currentLink(blocked), { recursive: true });
  fs.writeFileSync(path.join(shell.currentLink(blocked), "keep.txt"), "mine");
  assert.equal(shell.pointCurrentAt(shell.findElectron(blocked)!, blocked), false, "a real folder named current is left alone");
  assert.ok(fs.existsSync(path.join(shell.currentLink(blocked), "keep.txt")));
});

test("old versions go once the pinned one is in place, the layout before runtimes included", () => {
  const app = path.join(home, "prune");
  fakeElectron(app, "43.1.0");
  fs.writeFileSync(path.join(app, "package.json"), "{}");
  fs.writeFileSync(path.join(app, "window.json"), "{}");
  fakeElectron(shell.runtimeDir("44.10.2", app), "44.10.2");
  assert.deepEqual(shell.pruneElectrons(app), [], "nothing goes before the pinned one is there");
  fakeElectron(shell.runtimeDir(ELECTRON_VERSION, app), ELECTRON_VERSION);
  assert.deepEqual(shell.pruneElectrons(app).sort(), ["43.1.0", "44.10.2"]);
  assert.deepEqual(shell.listElectrons(app).map((e) => e.version), [ELECTRON_VERSION]);
  assert.equal(fs.existsSync(path.join(app, "node_modules")), false);
  assert.equal(fs.existsSync(path.join(app, "package.json")), false);
  assert.ok(fs.existsSync(path.join(app, "window.json")), "the window's own settings stay");
});

test("the install is npm with fixed words and pinned versions, into its own runtime folder, and does nothing when it's there", async () => {
  assert.equal(shell.electronInstallArgs()[0], "install");
  assert.ok(shell.electronInstallArgs("linux").includes(`electron@${ELECTRON_VERSION}`));
  assert.ok(shell.electronInstallArgs("win32").includes(`rcedit@${RCEDIT_VERSION}`), "rcedit, to name the program, on Windows");
  assert.ok(!shell.electronInstallArgs("darwin").some((a) => a.startsWith("rcedit")));
  for (const v of [ELECTRON_VERSION, RCEDIT_VERSION]) assert.ok(/^\d+\.\d+\.\d+$/.test(v), "exact versions, never a range");
  for (const a of shell.electronInstallArgs("win32")) assert.ok(/^[\w@.=-]+$/.test(a), `nothing a shell would read: ${a}`);
  assert.equal(shell.runtimeDir("1.2.3", "/x"), path.join("/x", "runtime", "1.2.3"));
  const app = path.join(home, "ready");
  const dir = shell.runtimeDir(ELECTRON_VERSION, app);
  fakeElectron(dir, ELECTRON_VERSION);
  fakeRcedit(dir);
  assert.equal(shell.appReady(app), true);
  const r = await shell.installElectron({ home: app });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(dir, "package.json")), false, "npm never ran");
  assert.equal(shell.electronInstalling(app), false);
});

test("dx's name and Floppy's icon go in with fixed arguments: rcedit on Windows, plutil and codesign on macOS", async () => {
  const args = shell.nameProgramArgs("C:\\x\\dx.exe.tmp", "C:\\x\\floppy.ico");
  assert.deepEqual(args.slice(0, 3), ["C:\\x\\dx.exe.tmp", "--set-icon", "C:\\x\\floppy.ico"]);
  const fields: Record<string, string> = {};
  for (let i = 3; i < args.length; i += 3) {
    assert.equal(args[i], "--set-version-string");
    fields[args[i + 1]] = args[i + 2];
  }
  assert.deepEqual(fields, { FileDescription: "dx", ProductName: "dx", CompanyName: "dx", InternalName: "dx", OriginalFilename: "dx.exe" });
  assert.ok(!args.join(" ").includes("Electron"), "Electron's name isn't written; its copyright stays as it was");
  assert.deepEqual(Object.fromEntries(shell.macPlistValues()), { CFBundleName: "dx", CFBundleDisplayName: "dx", CFBundleIdentifier: APP_PROGRAM.id, CFBundleIconFile: "dx.icns" });

  const dir = path.join(home, "unnamed");
  fakeElectron(dir, ELECTRON_VERSION);
  const e = shell.findElectron(dir)!;
  assert.equal((await shell.nameAppProgram(path.join(home, "missing.ico"), e, "win32")).message, "Floppy's icon isn't there.");
  const ico = path.join(home, "floppy.ico");
  fs.writeFileSync(ico, "icon");
  assert.equal((await shell.nameAppProgram(ico, e, "win32")).message, "rcedit isn't installed.");
  assert.equal((await shell.nameAppProgram(ico, e, "darwin")).message, "Floppy's icon isn't there.", "macOS wants the .icns");
  assert.equal((await shell.nameAppProgram(ico, e, "linux")).ok, true, "Linux names it through its launcher entry");
});

test("Floppy's icons: every size Windows asks for, and macOS's from 16 to 1024 pixels", () => {
  const dir = path.join(home, "sprites");
  const m = writeFloppySprites(dir, "navy");
  const ico = fs.readFileSync(path.join(dir, m.icon));
  const count = ico.readUInt16LE(4);
  assert.deepEqual(Array.from({ length: count }, (_, i) => ico[6 + i * 16] || 256), [16, 32, 48, 64, 128, 256]);
  for (let i = 0; i < count; i++) assert.equal(ico.subarray(ico.readUInt32LE(6 + i * 16 + 12) + 1, ico.readUInt32LE(6 + i * 16 + 12) + 4).toString("ascii"), "PNG");
  assert.equal(fs.readFileSync(path.join(dir, "floppy-256.png")).readUInt32BE(16), 256);

  const icns = fs.readFileSync(path.join(dir, "floppy.icns"));
  assert.equal(icns.subarray(0, 4).toString("ascii"), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
  const found: Record<string, number> = {};
  for (let at = 8; at < icns.length; ) {
    const type = icns.subarray(at, at + 4).toString("ascii");
    const len = icns.readUInt32BE(at + 4);
    assert.equal(icns.subarray(at + 9, at + 12).toString("ascii"), "PNG");
    found[type] = icns.readUInt32BE(at + 8 + 16); // the PNG's width
    at += len;
  }
  assert.deepEqual(found, { icp4: 16, icp5: 32, ic11: 32, icp6: 64, ic12: 64, ic07: 128, ic08: 256, ic13: 256, ic09: 512, ic14: 512, ic10: 1024 });
});

test("macOS opens it at sign-in with a LaunchAgent, Linux with an autostart entry, both minimised", () => {
  const env = { HOME: path.join(home, "user") };
  const launch = { command: "/home/me/.dx/app/current/electron", args: ["/opt/dx & co/shell"], icon: "/home/me/.dx/floppy/sprites/floppy-256.png" };

  const agent = shell.appSignInEntry(env, "darwin")!;
  assert.equal(agent, path.join(env.HOME, "Library", "LaunchAgents", `${APP_PROGRAM.id}.plist`));
  assert.equal(shell.setAppStartup(true, launch, env, "darwin").ok, true);
  const plist = fs.readFileSync(agent, "utf8");
  assert.ok(plist.includes(`<string>${APP_PROGRAM.id}</string>`));
  assert.ok(plist.includes("<string>/opt/dx &amp; co/shell</string>"), "escaped for XML");
  assert.ok(plist.includes("<string>--minimized</string>") && plist.includes("<key>RunAtLoad</key>"));
  assert.equal(shell.appStartsAtSignIn(env, "darwin"), true);
  assert.equal(shell.setAppStartup(false, undefined, env, "darwin").ok, true);
  assert.equal(shell.appStartsAtSignIn(env, "darwin"), false);

  const autostart = shell.appSignInEntry(env, "linux")!;
  assert.equal(autostart, path.join(env.HOME, ".config", "autostart", "dx.desktop"));
  assert.equal(shell.setAppStartup(true, launch, env, "linux").ok, true);
  const entry = fs.readFileSync(autostart, "utf8");
  assert.ok(entry.startsWith("[Desktop Entry]\n"));
  assert.ok(entry.includes('Exec=/home/me/.dx/app/current/electron "/opt/dx & co/shell" --minimized\n'));
  assert.ok(entry.includes("StartupWMClass=dx\n") && entry.includes("Name=dx\n") && entry.includes("Icon=/home/me/.dx/floppy/sprites/floppy-256.png\n"));
  assert.equal(shell.appSignInEntry({ ...env, XDG_CONFIG_HOME: "/xdg" }, "linux"), path.join("/xdg", "autostart", "dx.desktop"));

  shell.writeAppLauncherEntry(launch, env, "linux");
  const launcher = fs.readFileSync(shell.appLauncherEntry(env), "utf8");
  assert.ok(!launcher.includes("--minimized"), "the launcher opens it as usual");
  assert.equal(shell.appLauncherEntry(env), path.join(env.HOME, ".local", "share", "applications", "dx.desktop"));
});

test("an Exec line's arguments are quoted and escaped as the Desktop Entry spec asks", () => {
  assert.equal(shell.desktopExecArg("/plain/path"), "/plain/path");
  assert.equal(shell.desktopExecArg("/with space"), '"/with space"');
  assert.equal(shell.desktopExecArg('/a"b'), '"/a\\\\"b"', 'a " is escaped, then the backslash doubled for the file');
  assert.equal(shell.desktopExecArg("/cost$1"), '"/cost\\\\$1"');
  assert.equal(shell.desktopExecArg("/100%"), "/100%%");
  assert.equal(shell.desktopExecArg(""), '""');
});

test("on Windows the Startup shortcut opens the app minimised, and removing the app takes everything but what `current` points at", { skip: process.platform === "win32" ? false : "Windows only" }, () => {
  const env = { APPDATA: path.join(home, "AppData", "Roaming") };
  const startup = shell.appSignInEntry(env, "win32")!;
  assert.ok(startup.endsWith(path.join("Programs", "Startup", "dx.lnk")));
  assert.ok(shell.appStartMenuShortcut(env)!.endsWith(path.join("Start Menu", "Programs", "dx.lnk")));
  assert.equal(shell.setAppStartup(true, undefined, env, "win32").ok, false, "nothing to start before Electron is installed");
  assert.equal(shell.setAppStartup(true, { command: process.execPath, args: [path.join(home, "web shell")] }, env, "win32").ok, true);
  assert.equal(shell.appStartsAtSignIn(env, "win32"), true);
  fs.writeFileSync(shell.appStartMenuShortcut(env)!, "");

  const app = path.join(home, "removed");
  fakeElectron(shell.runtimeDir(ELECTRON_VERSION, app), ELECTRON_VERSION);
  const outside = path.join(home, "outside-dist");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "keep.txt"), "not dx's");
  fs.symlinkSync(outside, shell.currentLink(app), "junction");
  assert.equal(shell.removeApp(env, app, "win32").ok, true);
  assert.equal(fs.existsSync(app), false);
  assert.ok(fs.existsSync(path.join(outside, "keep.txt")), "only the link went, never what it points at");
  assert.equal(shell.appStartsAtSignIn(env, "win32"), false);
  assert.equal(fs.existsSync(shell.appStartMenuShortcut(env)!), false);
});
