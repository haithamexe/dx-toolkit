import { parseArgs } from "node:util";
import { appStartsAtSignIn, autoConnectAiTools, ELECTRON_VERSION, findElectron, installElectron, loadConfig, openUrl, recordRun, removeApp, saveConfig, setAppStartup } from "@dx/core";
import { startDashboard } from "@dx/web";
import { appLauncher, canWriteShortcuts, openDxApp, settleAppStartup, settleElectron } from "@dx/web/app";
import { dxVersion, ensureDashboard, findDashboard, olderVersion, type DashboardClient } from "@dx/web/link";
import type { Command } from "../command.js";
import { c, info, ok, UsageError, warn } from "../ui.js";

export const uiCommand: Command = {
  name: "ui",
  aliases: ["dashboard", "app"],
  summary: "Open dx: the dashboard, every dx tool with buttons, in a window of its own",
  usage: [
    "dx ui                 open dx in its own window (the first time, dx gets the app ready)",
    "dx ui --browser       open it in your browser instead, this once",
    "dx ui --startup       open dx on your taskbar (or Dock) when you sign in",
    "dx ui --no-startup    stop opening it when you sign in",
    "dx ui --stop          stop the dashboard and the dev servers it runs",
    "dx ui --background    start the dashboard without a window; it stops itself when idle for 30 minutes",
    "dx ui --no-open       run the dashboard in this terminal, without a window (Ctrl+C stops it)",
    "dx ui --port 5000     run it in this terminal on another port (default 4646)",
    "dx ui --remove-app    remove the app; dx ui then opens the dashboard in your browser",
    "dx ui --app           the app again, after --remove-app",
    "",
    `The app is Electron ${ELECTRON_VERSION.split(".")[0]}, a 100 MB download, installed once into ~/.dx/app, so dx itself stays small.`,
    "It shows the dashboard from this computer only (127.0.0.1); links to anything else open in your browser.",
    "AI tools connected to dx start the dashboard in the background when they need a dev server.",
  ].join("\n"),
  async run(argv) {
    const { values } = parseArgs({
      args: argv,
      allowNegative: true,
      options: {
        port: { type: "string", short: "p" },
        open: { type: "boolean", default: true },
        app: { type: "boolean" },
        browser: { type: "boolean" },
        background: { type: "boolean" },
        stop: { type: "boolean" },
        startup: { type: "boolean" },
        "remove-app": { type: "boolean" },
      },
    });
    const port = values.port === undefined ? undefined : Number(values.port);
    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new UsageError("--port must be a port number.");
    if (values.app && values.browser) throw new UsageError("--app or --browser, not both.");

    const running = await findDashboard();
    if (values.stop) {
      if (!running) {
        info("The dashboard isn't running.");
        return;
      }
      await running.post("/api/shutdown");
      ok("Dashboard stopped");
      return;
    }

    if (values["remove-app"]) {
      const r = removeApp();
      if (!r.ok) {
        warn(r.message);
        return 1;
      }
      saveConfig({ ...loadConfig(), dashboard: { ...(loadConfig().dashboard ?? {}), open: "browser", startup: false } });
      recordRun("app", true, "removed");
      ok(r.message);
      info(c.dim("dx ui --app brings it back."));
      return;
    }

    if (values.app && loadConfig().dashboard?.open === "browser") saveConfig({ ...loadConfig(), dashboard: { ...(loadConfig().dashboard ?? {}), open: "app" } });
    const wantApp = !values.browser && loadConfig().dashboard?.open !== "browser";

    if (values.startup !== undefined) return setStartup(values.startup);

    const open = async (url: string) => {
      if (!wantApp) return openDefault(url);
      await openApp(url);
    };

    // One left in the background by an older dx (after an update) is replaced by this version's.
    const old = running && olderVersion(running.info.version, dxVersion());
    if (running && old && running.info.background) {
      const client = await ensureDashboard();
      saidReplaced(client);
      if (values.open) await open(client.url);
      return;
    }
    if (running) {
      ok(`The dx dashboard is running at ${c.cyan(running.url)}${running.info.background ? c.dim(" (in the background)") : ""}`);
      if (old) info(c.dim(`It runs dx ${running.info.version ?? "from before 1.7.3"}, and this is ${dxVersion()}. Stop it (Ctrl+C where it runs) and run dx ui again to use this one.`));
      if (values.open) await open(running.url);
      return;
    }

    // The app is the window; the dashboard behind it runs in the background, so the terminal is free.
    if (values.background || (wantApp && values.open && port === undefined)) {
      const client = await ensureDashboard();
      if (client.replaced) saidReplaced(client);
      else ok(`dx dashboard running in the background at ${c.cyan(client.url)}`);
      info(c.dim("It stops itself after 30 minutes with no dev servers and no window open. dx ui --stop stops it now."));
      if (values.open) await open(client.url);
      return;
    }

    const dashboard = await startDashboard({ port });
    ok(`dx dashboard running at ${c.cyan(dashboard.url)}`);
    info(c.dim("Ctrl+C to stop. Dev servers started from the dashboard stop with it."));
    recordRun("ui", true, dashboard.url);
    void autoConnectAiTools()
      .then((results) => {
        const done = results.filter((r) => r.ok);
        if (done.length) info(c.dim(`Connected dx to ${done.map((r) => r.name).join(", ")}.`));
      })
      .catch(() => undefined);
    if (values.open) await open(dashboard.url);

    await new Promise<void>((resolve) => {
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        console.log("");
        info("Stopping the dashboard…");
        void dashboard.close().then(resolve, resolve);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      void dashboard.closed.then(resolve);
    });
    ok("Dashboard stopped");
  },
};

async function openDefault(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch (err) {
    warn(`Couldn't open the browser: ${(err as Error).message}. Open ${url} yourself.`);
  }
}

async function openApp(url: string): Promise<void> {
  const onLine = (line: string) => console.log(c.dim(`  ${line}`));
  try {
    const have = findElectron();
    if (!have) info(`Getting the dx app ready: Electron ${ELECTRON_VERSION}, a 100 MB download, once. ${c.dim("It goes in ~/.dx/app.")}`);
    else if (!have.current) info(`Updating the dx app's Electron ${have.version} to ${ELECTRON_VERSION}, next to the one there. ${c.dim("An open dx window carries on; the next one is on the new Electron.")}`);
    const r = await openDxApp(url, { install: "wait", onLine });
    if (r.opened === "app") {
      ok("dx is open in its own window.");
      if (r.message) warn(`${r.message} ${c.dim("dx ui tries again next time.")}`);
      recordRun("app", true, "opened");
      const first = settleAppStartup();
      if (first) info(`${first} ${c.dim("dx ui --no-startup turns that off.")}`);
    } else {
      if (r.message) warn(`${r.message} ${c.dim("dx ui tries again next time.")}`);
      info(r.opened === "window" ? "Opened it as an Edge app window for now." : "No Edge or Chrome here, so it opened in your browser.");
    }
  } catch (err) {
    warn(`Couldn't open the dx app: ${(err as Error).message}. Open ${url} yourself.`);
  }
}

async function setStartup(on: boolean): Promise<number | void> {
  if (!canWriteShortcuts()) {
    warn("DX_HOME is set, and a sign-in entry can't carry it, so dx won't add one. Unset DX_HOME to use your everyday ~/.dx.");
    return 1;
  }
  let launcher = appLauncher();
  if (on && !launcher) {
    info(`Getting the dx app ready first: Electron ${ELECTRON_VERSION}, a 100 MB download, once.`);
    const r = await installElectron({ onLine: (line) => console.log(c.dim(`  ${line}`)) });
    if (!r.ok) {
      warn(r.message);
      return 1;
    }
    await settleElectron();
    launcher = appLauncher();
  }
  const r = setAppStartup(on, launcher);
  if (!r.ok) {
    warn(r.message);
    return 1;
  }
  saveConfig({ ...loadConfig(), dashboard: { ...(loadConfig().dashboard ?? {}), startup: on && appStartsAtSignIn() } });
  ok(r.message);
}

/** After an update: the old dashboard was replaced, and which dev servers were started again. */
function saidReplaced(client: DashboardClient): void {
  const r = client.replaced;
  ok(`dx ${dxVersion()} is running at ${c.cyan(client.url)}${r ? c.dim(` (it replaced the dashboard from dx ${r.from})`) : ""}`);
  if (r?.servers.length) info(`Started again on the new version: ${r.servers.join(", ")}.`);
}
