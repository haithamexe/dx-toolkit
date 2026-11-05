import { parseArgs } from "node:util";
import { FLOPPY_COLOURWAYS, floppyStartsWithWindows, loadConfig, saveConfig, setFloppyStartup, writeFloppySprites, type FloppyColourway } from "@dx/core";
import { floppyLauncher, floppySpritesDir, readFloppyInfo, startFloppy, stopFloppy } from "@dx/web/floppy";
import type { Command } from "../command.js";
import { c, info, ok, UsageError, warn } from "../ui.js";

export const floppyCommand: Command = {
  name: "floppy",
  aliases: ["pet"],
  summary: "Put Floppy on your taskbar: it shows what dx is doing and opens the dashboard as an app",
  usage: [
    "dx floppy                  put Floppy on your taskbar (Windows)",
    "dx floppy --stop           take it off",
    "dx floppy --startup        start it when you sign in to Windows",
    "dx floppy --no-startup     stop starting it with Windows",
    "dx floppy --colour maroon  its colours: navy (default), charcoal or maroon",
    "dx floppy --status         is it running, and does it start with Windows",
    "",
    "Click Floppy to open dx in its own window. Drag it along the taskbar; right-click for the menu.",
    "The first time it runs, it's set to start with Windows; --no-startup or its menu turns that off.",
  ].join("\n"),
  async run(argv) {
    const { values } = parseArgs({
      args: argv,
      allowNegative: true,
      options: {
        stop: { type: "boolean" },
        startup: { type: "boolean" },
        colour: { type: "string" },
        color: { type: "string" },
        status: { type: "boolean" },
      },
    });
    if (process.platform !== "win32") {
      info("Floppy lives on the Windows taskbar for now. macOS and Linux come later.");
      return 0;
    }
    const config = loadConfig();
    const floppy = { ...(config.floppy ?? {}) };
    const save = () => saveConfig({ ...loadConfig(), floppy });

    if (values.status) {
      const running = readFloppyInfo();
      console.log(`${running ? c.green("●") : c.dim("○")} Floppy ${running ? `is on your taskbar ${c.dim(`(pid ${running.pid})`)}` : "isn't running"}`);
      console.log(`  ${floppyStartsWithWindows() ? "starts with Windows" : c.dim("doesn't start with Windows")} · ${floppy.colourway ?? "navy"}`);
      return 0;
    }

    if (values.stop) {
      if (await stopFloppy()) ok("Floppy is off your taskbar.");
      else info("Floppy isn't running.");
      return 0;
    }

    const colour = values.colour ?? values.color;
    let restart = false;
    if (colour !== undefined) {
      if (!(colour in FLOPPY_COLOURWAYS)) throw new UsageError(`--colour is one of ${Object.keys(FLOPPY_COLOURWAYS).join(", ")}.`);
      floppy.colourway = colour as FloppyColourway;
      save();
      restart = !!readFloppyInfo();
    }
    // The shortcut uses Floppy's icon, so its frames are drawn first.
    writeFloppySprites(floppySpritesDir(), floppy.colourway ?? "navy");

    if (values.startup !== undefined) {
      const r = setFloppyStartup(values.startup, floppyLauncher());
      if (!r.ok) {
        warn(r.message);
        return 1;
      }
      floppy.startup = values.startup;
      save();
      ok(r.message);
      if (!values.startup) return 0;
    } else if (floppy.startup === undefined) {
      // You asked for it to start with Windows; the first run sets that up, and says how to undo it.
      const r = setFloppyStartup(true, floppyLauncher());
      floppy.startup = r.ok;
      save();
      if (r.ok) info(`Floppy will start when you sign in to Windows. ${c.dim("dx floppy --no-startup turns that off.")}`);
      else warn(r.message);
    } else if (floppy.startup) {
      // Paths change when dx or node is updated; the shortcut follows.
      setFloppyStartup(true, floppyLauncher());
    }

    if (restart) await stopFloppy();
    const r = await startFloppy();
    if (r.started) ok(`${r.message} ${c.dim("Click it to open dx; right-click for the menu.")}`);
    else if (r.pid) info(r.message);
    else {
      warn(r.message);
      return 1;
    }
    return 0;
  },
};
