import fs from "node:fs";
import path from "node:path";
import type { Project } from "./projects.js";

/**
 * Moving a dev server to another port, so dx can answer on the one you open in your browser
 * (localhost:5173) and record what happens there, the way it does at shop.localhost. Only for
 * dev scripts whose tool dx knows how to tell the port to: anything else runs as it is.
 */

export interface MovedCommand {
  command: string;
  env: Record<string, string>;
  /** The tool the script runs: vite, next, … */
  tool: string;
}

/** How each tool is given a port: a flag, or the PORT variable alone. */
const TOOLS: Record<string, (port: number) => string[]> = {
  vite: (p) => ["--port", String(p), "--strictPort"],
  astro: (p) => ["--port", String(p)],
  nuxt: (p) => ["--port", String(p)],
  nuxi: (p) => ["--port", String(p)],
  next: (p) => ["-p", String(p)],
  ng: (p) => ["--port", String(p)],
  webpack: (p) => ["--port", String(p)],
  "webpack-dev-server": (p) => ["--port", String(p)],
  gatsby: (p) => ["-p", String(p)],
  "react-router": (p) => ["--port", String(p)],
  "react-scripts": () => [],
};

/**
 * The project's dev command, changed to listen on `port`, or undefined when dx can't be sure it
 * would: a custom dev command, a script that runs several things or already names a port, or
 * a tool dx doesn't know.
 */
export function moveDevPort(project: Project, port: number): MovedCommand | undefined {
  const m = /^(npm|pnpm|yarn|bun) run ([\w:.-]+)$/.exec(project.devCommand ?? "");
  if (!m) return undefined;
  const [, pm, name] = m;
  let script: string | undefined;
  try {
    script = (JSON.parse(fs.readFileSync(path.join(project.dir, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts?.[name];
  } catch {
    return undefined;
  }
  if (!script) return undefined;
  // One command, with no port of its own: anything else can't be told where to listen.
  if (/&&|\|\||[;|&]/.test(script)) return undefined;
  if (/(?:^|\s)(?:-p|--port)(?:\s|=|$)|\bPORT=/.test(script)) return undefined;
  const tool = toolOf(script);
  if (!tool) return undefined;
  const flags = TOOLS[tool](port);
  const extra = flags.length ? ` ${pm === "npm" ? "-- " : ""}${flags.join(" ")}` : "";
  return { command: `${pm} run ${name}${extra}`, env: { PORT: String(port) }, tool };
}

/** The tool a dev script runs: `vite`, `next dev`, `npx astro dev`, `cross-env X=1 vite`. */
export function toolOf(script: string): string | undefined {
  const words = script.trim().split(/\s+/);
  let i = 0;
  // Leading variables, and the runners that only start the tool.
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || ["cross-env", "npx", "bunx", "dotenv", "env"].includes(words[i]) || words[i] === "--")) i++;
  if (words[i] === "pnpm" && words[i + 1] === "exec") i += 2;
  if (words[i] === "yarn" && words[i + 1] && TOOLS[words[i + 1]]) i += 1;
  const tool = words[i]?.replace(/^.*[\\/]/, "").replace(/\.(cmd|exe)$/i, "");
  if (!tool || !TOOLS[tool]) return undefined;
  // `remix dev` (the old compiler) and `next start` aren't dev servers dx can move.
  if (tool === "next" && words[i + 1] && words[i + 1] !== "dev") return undefined;
  if (tool === "ng" && words[i + 1] !== "serve") return undefined;
  if (tool === "gatsby" && words[i + 1] !== "develop") return undefined;
  if ((tool === "astro" || tool === "nuxt" || tool === "nuxi") && words[i + 1] !== "dev") return undefined;
  if (tool === "react-scripts" && words[i + 1] !== "start") return undefined;
  if (tool === "react-router" && words[i + 1] !== "dev") return undefined;
  if (tool === "vite" && words[i + 1] && !["dev", "serve"].includes(words[i + 1]) && !words[i + 1].startsWith("-")) return undefined;
  return tool;
}
