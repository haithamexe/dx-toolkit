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

export interface MovePlan {
  moved?: MovedCommand;
  /** When it can't be moved: why, in words the page can show. */
  reason?: string;
}

/** A port written in a script: `-p 3000`, `--port 3000`, `--port=3000`, `PORT=3000`. */
const OWN_PORT = /((?:^|\s)(?:-p|--port)(?:\s+|=))(\d{2,5})\b|\b(PORT=)(\d{2,5})\b/;
const OWN_PORT_ALL = new RegExp(OWN_PORT.source, "g");

/**
 * The project's dev command, changed to listen on `port`, or why dx can't be sure it would.
 *
 * What it can move: a package script whose last command is a dev server of a tool dx knows
 * (`vite`, `next dev`, also run as `node node_modules/vite/bin/vite.js`), after any one-shot steps
 * joined with `&&` (`prisma generate && next dev`). A port the script names itself is replaced
 * in the script's text, since a second `--port` after it would be read as a list by some tools.
 */
export function planMove(project: Project, port: number): MovePlan {
  if (!project.devCommand) return { reason: "it has no dev command dx can read" };
  const m = /^(npm|pnpm|yarn|bun) run ([\w:.-]+)$/.exec(project.devCommand);
  if (!m) return { reason: "its dev command is a custom command, not a package script" };
  const [, pm, name] = m;
  let scripts: Record<string, string> | undefined;
  try {
    scripts = (JSON.parse(fs.readFileSync(path.join(project.dir, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts;
  } catch {
    return { reason: "its package.json can't be read" };
  }
  const script = scripts?.[name];
  if (!script) return { reason: `package.json has no "${name}" script` };
  // One-shot steps, then the server: `a && b && next dev`. Anything run side by side is out.
  if (/[;|&]/.test(script.replace(/&&/g, " "))) return { reason: "the script runs several things side by side" };
  const segments = script.split("&&").map((s) => s.trim());
  const last = segments[segments.length - 1];
  const tool = toolOf(last);
  if (!tool) {
    const first = last.split(/\s+/).find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? last;
    return /concurrently|npm-run-all|run-p\b|turbo\b|\bnx\b/.test(last)
      ? { reason: "the script starts several servers at once; run them as a stack" }
      : { reason: `"${first}" isn't a dev server dx knows how to give a port (it can't tell where it will listen)` };
  }
  if (!OWN_PORT.test(last)) {
    const flags = TOOLS[tool](port);
    const extra = flags.length ? ` ${pm === "npm" ? "-- " : ""}${flags.join(" ")}` : "";
    return { moved: { command: `${pm} run ${name}${extra}`, env: { PORT: String(port) }, tool } };
  }
  // A port of its own is replaced in the script, which then runs by itself (not through `npm run`),
  // so a `pre<name>` script (npm runs it first) is run first by name. A `post<name>` runs only once
  // the server has stopped, and isn't missed.
  const pre = scripts?.[`pre${name}`] ? `${pm} run pre${name} && ` : "";
  const rewritten = pre + [...segments.slice(0, -1), last.replace(OWN_PORT_ALL, (_all, flag, n, assign) => (flag ? `${flag}${port}` : `${assign}${port}`))].join(" && ");
  // npm puts node_modules/.bin first on PATH for a script; running its text directly has to do the same.
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const bin = path.join(project.dir, "node_modules", ".bin");
  return { moved: { command: rewritten, env: { PORT: String(port), [key]: `${bin}${path.delimiter}${process.env[key] ?? ""}` }, tool } };
}

/** The dev command changed to listen on `port`, or undefined (see planMove for why not). */
export function moveDevPort(project: Project, port: number): MovedCommand | undefined {
  return planMove(project, port).moved;
}

/** The tool a dev script runs: `vite`, `next dev`, `npx astro dev`, `cross-env X=1 vite`, `node node_modules/vite/bin/vite.js`. */
export function toolOf(script: string): string | undefined {
  const words = script.trim().split(/\s+/);
  let i = 0;
  // Leading variables, and the runners that only start the tool.
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || ["cross-env", "npx", "bunx", "dotenv", "env"].includes(words[i]) || words[i] === "--")) i++;
  if (words[i] === "pnpm" && words[i + 1] === "exec") i += 2;
  if (words[i] === "yarn" && words[i + 1] && TOOLS[words[i + 1]]) i += 1;
  // `node node_modules/next/dist/bin/next dev`: the tool is the package (or the file) the path names.
  let fromPath: string | undefined;
  if (words[i] === "node") {
    let j = i + 1;
    while (j < words.length && words[j].startsWith("-")) j++;
    const target = words[j]?.replace(/\\/g, "/");
    const pkg = target && /node_modules\/(?:\.bin\/)?((?:@[\w.-]+\/)?[\w.-]+)/.exec(target);
    if (pkg) {
      const file = target.split("/").pop()?.replace(/\.(c?js|mjs)$/, "");
      fromPath = [pkg[1], file].find((c) => c && TOOLS[c]);
      if (fromPath) i = j;
    }
  }
  const tool = fromPath ?? words[i]?.replace(/^.*[\\/]/, "").replace(/\.(cmd|exe)$/i, "");
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
