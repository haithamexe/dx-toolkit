import { parseArgs } from "node:util";
import { FLOPPY_COLOURWAYS, floppyStartsWithWindows, loadConfig, saveConfig, setFloppyStartup, writeFloppySprites, type FloppyColourway } from "@dx/core";
import { floppyLauncher, floppySpritesDir, floppySupported, readFloppyInfo, settleFloppyStartup, startFloppy, stopFloppy } from "@dx/web/floppy";
import type { Command } from "../command.js";
import { c, info, ok, UsageError, warn } from "../ui.js";

export const floppyCommand: Command = {
  name: "floppy",
  aliases: ["pet"],
  summary: "Put Floppy on your desktop: it shows what dx is doing and opens the dashboard as an app",
  usage: [
    "dx floppy                  put Floppy on your desktop (above the taskbar or the Dock)",
    "dx floppy --stop           take it off",
    "dx floppy --startup        start it when you sign in",
    "dx floppy --no-startup     stop starting it when you sign in",
    "dx floppy --colour maroon  its colours: navy (default), charcoal or maroon",
    "dx floppy --status         is it running, and does it start when you sign in",
    "",
    "Click Floppy to open dx in its own window. Drag it along the taskbar; right-click for the menu.",
    "The first time it runs, it's set to start when you sign in; --no-startup or its menu turns that off.",
    "On macOS and Linux it uses the Electron the dx app installs (about 100 MB, once).",
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
    if (!floppySupported()) {
      info("Floppy needs a desktop to sit on: Windows, macOS, or Linux with a display.");
      return 0;
    }
    const signIn = process.platform === "win32" ? "with Windows" : "when you sign in";
    const config = loadConfig();
    const floppy = { ...(config.floppy ?? {}) };
    const save = () => saveConfig({ ...loadConfig(), floppy });

    if (values.status) {
      const running = readFloppyInfo();
      console.log(`${running ? c.green("●") : c.dim("○")} Floppy ${running ? `is on your taskbar ${c.dim(`(pid ${running.pid})`)}` : "isn't running"}`);
      console.log(`  ${floppyStartsWithWindows() ? `starts ${signIn}` : c.dim(`doesn't start ${signIn}`)} · ${floppy.colourway ?? "navy"}`);
      return 0;
    }

    if (values.stop) {
      // Sent away: the dx app doesn't bring it back until `dx floppy`.
      floppy.off = true;
      save();
      if (await stopFloppy()) ok(`Floppy is off your taskbar. ${c.dim("dx floppy brings it back.")}`);
      else info("Floppy isn't running.");
      return 0;
    }
    if (floppy.off) {
      delete floppy.off;
      save();
    }

    const colour = values.colour ?? values.color;
    let restart = false;
    if (colour !== undefined) {
      if (!(colour in FLOPPY_COLOURWAYS)) throw new UsageError(`--colour is one of ${Object.keys(FLOPPY_COLOURWAYS).join(", ")}.`);
      floppy.colourway = colour as FloppyColourway;
      save();
      restart = !!readFloppyInfo();
    }
    if (values.startup !== undefined) {
      // The shortcut uses Floppy's icon, so its frames are drawn first.
      writeFloppySprites(floppySpritesDir(), floppy.colourway ?? "navy");
      const r = setFloppyStartup(values.startup, floppyLauncher());
      if (!r.ok) {
        warn(r.message);
        return 1;
      }
      floppy.startup = values.startup;
      save();
      ok(r.message);
      if (!values.startup) return 0;
    } else {
      // The first run sets up starting with Windows and says how to undo it; later runs keep the shortcut's paths current.
      const settled = settleFloppyStartup();
      if (settled.message) info(`${settled.message} ${c.dim("dx floppy --no-startup turns that off.")}`);
      if (settled.warning) warn(settled.warning);
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
