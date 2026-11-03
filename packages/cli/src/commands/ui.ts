import { parseArgs } from "node:util";
import { openUrl, recordRun } from "@dx/core";
import { startDashboard } from "@dx/web";
import type { Command } from "../command.js";
import { c, info, ok, UsageError, warn } from "../ui.js";

export const uiCommand: Command = {
  name: "ui",
  aliases: ["dashboard"],
  summary: "Open the dx dashboard in your browser: every dx tool, with buttons",
  usage: [
    "dx ui                 start the dashboard and open it in your browser",
    "dx ui --port 5000     use another port (default 4646)",
    "dx ui --no-open       start it without opening the browser",
    "",
    "It runs on this computer only (127.0.0.1). Dev servers started from it stop when it stops.",
    "Ctrl+C stops it.",
  ].join("\n"),
  async run(argv) {
    const { values } = parseArgs({
      args: argv,
      allowNegative: true,
      options: {
        port: { type: "string", short: "p" },
        open: { type: "boolean", default: true },
      },
    });
    const port = values.port === undefined ? undefined : Number(values.port);
    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new UsageError("--port must be a port number.");

    const dashboard = await startDashboard({ port });
    ok(`dx dashboard running at ${c.cyan(dashboard.url)}`);
    info(c.dim("Ctrl+C to stop. Dev servers started from the dashboard stop with it."));
    recordRun("ui", true, dashboard.url);
    if (values.open) {
      try {
        await openUrl(dashboard.url);
      } catch (err) {
        warn(`Couldn't open the browser: ${(err as Error).message}. Open ${dashboard.url} yourself.`);
      }
    }

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
    });
    ok("Dashboard stopped");
  },
};
