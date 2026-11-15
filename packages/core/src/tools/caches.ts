import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRunner, type Runner } from "./machine.js";

/**
 * The caches package managers and build tools keep on this computer (npm, pnpm, yarn, bun, pip, Go), how big
 * each is, and cleaning one through the tool's own command (`npm cache clean --force`, `pnpm store prune`,
 * `go clean -cache`…), never by deleting folders ourselves: the tool knows what is safe to remove, and what it
 * keeps is rebuilt the next time a project needs it. The commands are a fixed list; nothing here comes from a request.
 */

export interface CacheSpec {
  id: string;
  name: string;
  /** What cleaning does, in a few words. */
  about: string;
  /** Asks the tool where its cache is. */
  locate?: [string, string[]];
  /** Where it is when the tool has no command for it (relative to the home folder). */
  home?: string;
  /** The tool's own command to clean it. */
  clean: [string, string[]];
}

export const CACHES: CacheSpec[] = [
  { id: "npm", name: "npm", about: "Downloaded packages: npm fetches them again when a project needs them", locate: ["npm", ["config", "get", "cache"]], clean: ["npm", ["cache", "clean", "--force"]] },
  { id: "pnpm", name: "pnpm store", about: "Packages no project uses any more (the ones projects use stay)", locate: ["pnpm", ["store", "path"]], clean: ["pnpm", ["store", "prune"]] },
  { id: "yarn", name: "Yarn", about: "Downloaded packages: Yarn fetches them again when needed", locate: ["yarn", ["cache", "dir"]], clean: ["yarn", ["cache", "clean"]] },
  { id: "bun", name: "Bun", about: "Downloaded packages: Bun fetches them again when needed", home: path.join(".bun", "install", "cache"), clean: ["bun", ["pm", "cache", "rm"]] },
  { id: "pip", name: "pip", about: "Downloaded and built Python packages", locate: ["pip", ["cache", "dir"]], clean: ["pip", ["cache", "purge"]] },
  { id: "go", name: "Go build cache", about: "Compiled packages: Go builds them again when needed", locate: ["go", ["env", "GOCACHE"]], clean: ["go", ["clean", "-cache"]] },
];

export interface ToolCache {
  id: string;
  name: string;
  about: string;
  /** Where it is, or undefined when the tool isn't installed or has no cache yet. */
  path?: string;
  bytes: number;
  /** The size is part of the answer: the folder was too big to count in the time given. */
  partial: boolean;
  /** The command that cleans it, for the page to show. */
  command: string;
}

/** The size of a folder, not following links, in at most `ms`. */
export async function measureFolder(dir: string, ms = 8000): Promise<{ bytes: number; partial: boolean }> {
  const deadline = Date.now() + ms;
  let bytes = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    if (Date.now() > deadline || seen > 1_000_000) return { bytes, partial: true };
    const here = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(here, { withFileTypes: true });
    } catch {
      continue;
    }
    await Promise.all(
      entries.map(async (e) => {
        seen++;
        const full = path.join(here, e.name);
        if (e.isSymbolicLink()) return;
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) {
          try {
            // The size first, then the sum: adding across an await would lose what other files added meanwhile.
            const size = (await fs.promises.lstat(full)).size;
            bytes += size;
          } catch {
            // gone while we looked
          }
        }
      }),
    );
  }
  return { bytes, partial: false };
}

/** Runs a command we chose and waits for it (cleaning can take a while); its output, stdout and stderr together. */
export const cleanRunner: Runner = (command, args) =>
  new Promise((resolve, reject) => {
    const [file, list] = process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", [command, ...args].join(" ")]] : [command, args];
    execFile(file, list, { windowsHide: true, timeout: 180_000, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || stdout || err.message).toString().trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 300) || "The command failed."));
      resolve(`${stdout ?? ""}\n${stderr ?? ""}`);
    });
  });

/** The first line of a tool's answer that is an absolute folder that exists; undefined otherwise. */
function pathFrom(output: string): string | undefined {
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim().replace(/^"|"$/g, "");
    if (line && path.isAbsolute(line) && fs.existsSync(line) && fs.statSync(line).isDirectory()) return line;
  }
  return undefined;
}

async function where(spec: CacheSpec, run: Runner, home: string): Promise<string | undefined> {
  const found = spec.locate ? pathFrom(await run(spec.locate[0], spec.locate[1])) : undefined;
  if (found) return found;
  if (spec.home) {
    const p = path.join(home, spec.home);
    return fs.existsSync(p) ? p : undefined;
  }
  return undefined;
}

const commandOf = (spec: CacheSpec) => [spec.clean[0], ...spec.clean[1]].join(" ");

/** The caches this computer has, biggest first. Nothing is changed. */
export async function listCaches(options: { run?: Runner; home?: string } = {}): Promise<ToolCache[]> {
  const run = options.run ?? defaultRunner;
  const home = options.home ?? os.homedir();
  const out = await Promise.all(
    CACHES.map(async (spec): Promise<ToolCache> => {
      const p = await where(spec, run, home);
      const size = p ? await measureFolder(p) : { bytes: 0, partial: false };
      return { id: spec.id, name: spec.name, about: spec.about, path: p, bytes: size.bytes, partial: size.partial, command: commandOf(spec) };
    }),
  );
  return out.filter((c) => c.path).sort((a, b) => b.bytes - a.bytes);
}

export class CacheError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** Cleans one cache through its tool's own command, and says how much it freed. */
export async function cleanCache(id: string, options: { run?: Runner; exec?: Runner; home?: string } = {}): Promise<{ id: string; name: string; freed: number; before: number; after: number }> {
  const spec = CACHES.find((c) => c.id === id);
  if (!spec) throw new CacheError(`dx doesn't clean "${id}": ${CACHES.map((c) => c.id).join(", ")}.`, 404);
  const run = options.run ?? defaultRunner;
  const p = await where(spec, run, options.home ?? os.homedir());
  if (!p) throw new CacheError(`${spec.name} has no cache here to clean.`, 404);
  const before = (await measureFolder(p, 20_000)).bytes;
  try {
    await (options.exec ?? cleanRunner)(spec.clean[0], spec.clean[1]);
  } catch (err) {
    throw new CacheError(`${commandOf(spec)} didn't work: ${(err as Error).message}`, 502);
  }
  const after = fs.existsSync(p) ? (await measureFolder(p, 20_000)).bytes : 0;
  return { id: spec.id, name: spec.name, freed: Math.max(0, before - after), before, after };
}
