// Runs the dx dashboard in the background, with no terminal: started by the MCP server when an
// AI tool needs a dev server, or by `dx ui --background`. It stops itself after 30 minutes with
// no dev servers running and nobody using it, or when asked (`dx ui --stop`).
import { autoConnectAiTools, recordRun } from "@dx/core";
import { startDashboard } from "./server.js";

const dashboard = await startDashboard({
  background: true,
  onIdle: () => void shutdown("idle"),
});
recordRun("ui", true, `${dashboard.url} (background)`, "web");
void autoConnectAiTools().catch(() => undefined);

let stopping = false;
async function shutdown(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  recordRun("ui", true, `background dashboard stopped (${reason})`, "web");
  await dashboard.close().catch(() => undefined);
  process.exit(0);
}
void dashboard.closed.then(() => shutdown("asked"));
process.on("SIGINT", () => void shutdown("signal"));
process.on("SIGTERM", () => void shutdown("signal"));
