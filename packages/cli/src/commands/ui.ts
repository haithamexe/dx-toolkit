import { parseArgs } from "node:util";
import { autoConnectAiTools, openAppWindow, openUrl, recordRun } from "@dx/core";
import { startDashboard } from "@dx/web";
import { ensureDashboard, findDashboard } from "@dx/web/link";
import type { Command } from "../command.js";
import { c, info, ok, UsageError, warn } from "../ui.js";

export const uiCommand: Command = {
  name: "ui",
  aliases: ["dashboard"],
  summary: "Open the dx dashboard in your browser: every dx tool, with buttons",
  usage: [
    "dx ui                 open the dashboard (starting it here if it isn't running)",
    "dx ui --background    start it without a terminal; it stops itself when idle for 30 minutes",
    "dx ui --stop          stop the running dashboard and the dev servers it runs",
    "dx ui --port 5000     use another port (default 4646)",
    "dx ui --no-open       don't open the browser",
    "dx ui --app           open it as an app: its own window, no tabs or address bar",
    "",
    "It runs on this computer only (127.0.0.1). AI tools connected to dx start it in the background",
    "when they need a dev server, and `dx ui` then just opens that one.",
  ].join("\n"),
  async run(argv) {
    const { values } = parseArgs({
      args: argv,
      allowNegative: true,
      options: {
        port: { type: "string", short: "p" },
        open: { type: "boolean", default: true },
        app: { type: "boolean" },
        background: { type: "boolean" },
        stop: { type: "boolean" },
      },
    });
    const port = values.port === undefined ? undefined : Number(values.port);
    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new UsageError("--port must be a port number.");

    const openBrowser = (url: string) => (values.app ? openApp(url) : openDefault(url));
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

    if (running) {
      ok(`The dx dashboard is already running at ${c.cyan(running.url)}${running.info.background ? c.dim(" (in the background)") : ""}`);
      if (values.open) await openBrowser(running.url);
      return;
    }

    if (values.background) {
      const client = await ensureDashboard();
      ok(`dx dashboard running in the background at ${c.cyan(client.url)}`);
      info(c.dim("It stops itself after 30 minutes with no dev servers and nobody using it. dx ui --stop stops it now."));
      if (values.open) await openBrowser(client.url);
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
    if (values.open) await openBrowser(dashboard.url);

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
  try {
    if ((await openAppWindow(url)) === "browser") info(c.dim("No Edge or Chrome here, so it opened in your browser."));
  } catch (err) {
    warn(`Couldn't open the app window: ${(err as Error).message}. Open ${url} yourself.`);
  }
}
