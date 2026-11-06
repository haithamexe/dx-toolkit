/**
 * Run by the dx app's window (web/shell/main.js) with dx's own node, when it was opened from the
 * Start menu or at sign-in: finds the dashboard, starting it in the background when it isn't
 * running, prints its address as one JSON line, brings Floppy along and starts an Electron update
 * when this dx pins a newer one (app.ts). Only the
 * address: the token stays in ~/.dx/dashboard.json, and the page gets it as it always does.
 */
import { startFloppyWithApp, updateAppInBackground } from "./app.js";
import { ensureDashboard } from "./link.js";

try {
  const client = await ensureDashboard();
  // Floppy's process starts at once and lives on its own; this one doesn't wait for it to show.
  startFloppyWithApp();
  // A dx that pins a newer Electron than the one running updates it next to it, for next time.
  updateAppInBackground();
  // Writes to a pipe finish later on Windows: exit once the line is out.
  process.stdout.write(JSON.stringify({ url: client.url }) + "\n", () => process.exit(0));
} catch (err) {
  process.stdout.write(JSON.stringify({ error: (err as Error).message }) + "\n");
  process.exitCode = 1;
}
