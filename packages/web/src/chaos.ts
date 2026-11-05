import fs from "node:fs";
import type http from "node:http";
import { chaosFile, decideChaos, foldPath, loadChaos, pathMatches, type ChaosConfig, type ChaosDecision, type RulePlan } from "@dx/core";
import type { LocalRoute } from "./dev.js";

/**
 * Chaos mode in the proxy: which calls a run breaks, counted per run so the same seed breaks the
 * same calls again, and the waiting that makes an answer arrive out of order. Only API calls to
 * dev servers dx runs; never page loads, scripts, styles, dx's own paths or WebSockets.
 */

const cache = new Map<string, { stamp: string; config: ChaosConfig }>();

/** The project's chaos settings, read again only when the file changed (so `dx chaos on` applies at once). */
export function chaosConfig(dir: string): ChaosConfig | undefined {
  const file = chaosFile(dir);
  let stamp: string;
  try {
    const st = fs.statSync(file);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    cache.delete(file);
    return undefined;
  }
  let c = cache.get(file);
  if (!c || c.stamp !== stamp) {
    c = { stamp, config: loadChaos(dir) };
    cache.set(file, c);
  }
  return c.config;
}

interface RunCount {
  index: number;
  perKey: Map<string, number>;
}
const counts = new Map<string, RunCount>();

/** Starts the counting again for this project (a replay of a run). */
export function restartChaosCount(dir: string): void {
  for (const k of counts.keys()) if (k.startsWith(`${dir.toLowerCase()}|`)) counts.delete(k);
}

const ASSET = /\.(m?[jt]sx?|css|s[ac]ss|less|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wasm|vue|svelte|astro|html?)$/i;

/** An API call as the page asks for it: not a page load, a module, a style or an image. */
export function looksLikeApiCall(req: http.IncomingMessage): boolean {
  const url = req.url ?? "/";
  const method = (req.method ?? "GET").toUpperCase();
  if (url.startsWith("/__dx/") || req.headers.upgrade) return false;
  const p = url.split("?")[0];
  if (/^\/(@|node_modules\/|src\/|__|_next\/static|\.vite\/)/.test(p)) return false;
  const accept = String(req.headers.accept ?? "");
  if (method === "GET" && /text\/html/i.test(accept)) return false;
  if (method === "OPTIONS") return false;
  if (method !== "GET" && method !== "HEAD") return true;
  if (/\/api\/|\/graphql|\/trpc\//i.test(p) || /json/i.test(accept)) return true;
  if (/^(image|text\/css|font)/i.test(accept)) return false;
  return /\*\/\*/.test(accept) && !ASSET.test(p);
}

/** What chaos does to this call, when the project's chaos mode is on; counts the call either way. */
export function chaosFor(req: http.IncomingMessage, route: LocalRoute): ChaosDecision | undefined {
  const c = chaosConfig(route.dir);
  if (!c?.on || !looksLikeApiCall(req)) return undefined;
  const url = req.url ?? "/";
  if (c.paths && !pathMatches(c.paths, url)) return undefined;
  const method = (req.method ?? "GET").toUpperCase();
  const runKey = `${route.dir.toLowerCase()}|${c.startedAt ?? ""}|${c.seed}|${c.level}`;
  let run = counts.get(runKey);
  if (!run) {
    restartChaosCount(route.dir);
    run = { index: 0, perKey: new Map() };
    counts.set(runKey, run);
  }
  const key = `${method} ${foldPath(url.split("?")[0])}`;
  const n = run.perKey.get(key) ?? 0;
  run.perKey.set(key, n + 1);
  const index = run.index++;
  const signedIn = !!(req.headers.authorization || req.headers.cookie);
  return decideChaos(c, { method, path: url, n, index, signedIn });
}

/** Adds chaos's fault to the rules' plan (or makes a plan of its own). */
export function withChaos(plan: RulePlan | undefined, chaos: ChaosDecision): RulePlan {
  const p: RulePlan = plan ?? { rules: [], delayMs: 0, interceptRequest: false, interceptResponse: false, request: [], response: [], needsRequestBody: false, needsResponseBody: false };
  p.chaos = chaos;
  if (chaos.delayMs) p.delayMs += chaos.delayMs;
  if (chaos.fault === "baddata" || chaos.fault === "reorder" || chaos.fault === "drop") p.needsResponseBody = true;
  return p;
}

// ------------------------------------------------------------------ out of order

const finished = new Map<string, number>();
const waiting = new Map<string, Array<() => void>>();

/** Call when any answer to this method and path has gone back to the page. */
export function answered(key: string): void {
  finished.set(key, (finished.get(key) ?? 0) + 1);
  const list = waiting.get(key);
  if (list?.length) {
    waiting.delete(key);
    for (const go of list) go();
  }
}

/**
 * Holds an answer until the next call to the same method and path has been answered, or 3 s
 * pass: the page then gets the older answer last, as when a slow search lands after a newer one.
 */
export function holdForNext(key: string, maxMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, maxMs);
    function done() {
      clearTimeout(t);
      resolve();
    }
    waiting.set(key, [...(waiting.get(key) ?? []), done]);
  });
}

export function callKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${foldPath(url.split("?")[0])}`;
}
