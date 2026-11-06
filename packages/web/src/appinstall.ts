/**
 * Gets the dx app ready, or updates its Electron, in the background (Floppy's click, or the app
 * opening on an older Electron): installs the pinned Electron next to the one running, names it,
 * points `current` at it and removes what nothing uses any more, then exits. The open app carries
 * on; the next time dx opens it's on the new one. `dx ui` does the same in front of you.
 */
import { installElectron, recordRun } from "@dx/core";
import { settleElectron } from "./app.js";

const r = await installElectron();
if (r.ok) await settleElectron();
recordRun("app", r.ok, r.ok ? `Electron ${r.electron?.version ?? ""} ready` : r.message, "web");
process.exitCode = r.ok ? 0 : 1;
