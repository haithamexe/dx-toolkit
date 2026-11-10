import fs from "node:fs";
import path from "node:path";

/**
 * How to start a project that has no package.json dev script, read from the files it already has:
 * a task runner (Makefile, justfile, Taskfile, deno.json), or its framework's own command (Rails,
 * Laravel, Phoenix, Django, Flask, FastAPI, .NET). The first that fits wins; nothing is run here.
 * Every command is made of fixed words and the project's own target or task names.
 */

/** Target names that start a project for development, best first. */
const TARGETS = ["dev", "run", "start", "serve", "up", "watch"];

const read = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};
const first = (dir: string, ...names: string[]) => names.map((n) => path.join(dir, n)).find((f) => fs.existsSync(f));

/** Targets a Makefile defines (`dev:` at the start of a line), not variables or pattern rules. */
export function makeTargets(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^([A-Za-z][\w-]*)\s*:(?!=)/gm)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** Recipes a justfile defines (`dev:` or `dev arg:` at the start of a line). */
export function justRecipes(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^@?([A-Za-z][\w-]*)(?:\s+[^:\n]*)?:(?!=)/gm)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** Tasks in a Taskfile: the keys right under `tasks:`. */
export function taskfileTasks(text: string): string[] {
  const out: string[] = [];
  let inTasks = false;
  let indent = -1;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;
    const lead = line.length - line.trimStart().length;
    if (lead === 0) {
      inTasks = /^tasks:\s*$/.test(line);
      indent = -1;
      continue;
    }
    if (!inTasks) continue;
    if (indent === -1) indent = lead;
    const m = lead === indent ? /^\s*['"]?([\w:-]+)['"]?:/.exec(line) : null;
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

const pick = (names: string[]) => TARGETS.find((t) => names.includes(t));

/** The command that starts the project, from its own files, or undefined. */
export function devCommandFromFiles(dir: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const make = first(dir, "Makefile", "makefile", "GNUmakefile");
  const makeTarget = make && pick(makeTargets(read(make) ?? ""));
  if (makeTarget) return `make ${makeTarget}`;

  const just = first(dir, "justfile", "Justfile", ".justfile");
  const recipe = just && pick(justRecipes(read(just) ?? ""));
  if (recipe) return `just ${recipe}`;

  const taskfile = first(dir, "Taskfile.yml", "Taskfile.yaml", "taskfile.yml", "taskfile.yaml");
  const task = taskfile && pick(taskfileTasks(read(taskfile) ?? ""));
  if (task) return `task ${task}`;

  const deno = first(dir, "deno.json", "deno.jsonc");
  if (deno) {
    try {
      const tasks = Object.keys((JSON.parse((read(deno) ?? "").replace(/^\s*\/\/.*$/gm, "")) as { tasks?: Record<string, unknown> }).tasks ?? {});
      const t = pick(tasks);
      if (t) return `deno task ${t}`;
    } catch {
      // jsonc with comments in odd places: try the rest
    }
  }

  const gemfile = read(path.join(dir, "Gemfile"));
  if (gemfile && /\bgem\s+['"]rails['"]/.test(gemfile)) {
    if (fs.existsSync(path.join(dir, "bin", "dev")) && platform !== "win32") return "bin/dev";
    return platform === "win32" ? "ruby bin/rails server" : "bin/rails server";
  }
  if (fs.existsSync(path.join(dir, "artisan"))) return "php artisan serve";
  const mix = read(path.join(dir, "mix.exs"));
  if (mix && /:phoenix\b/.test(mix)) return "mix phx.server";

  if (fs.existsSync(path.join(dir, "manage.py"))) return "python manage.py runserver";
  const deps = [read(path.join(dir, "requirements.txt")), read(path.join(dir, "pyproject.toml"))].join("\n").toLowerCase();
  if (deps.trim()) {
    const entry = ["main.py", "app.py", "server.py", "app/main.py", "src/main.py"].find((f) => fs.existsSync(path.join(dir, f)));
    if (entry && /\bfastapi\b/.test(deps)) {
      const module = entry.replace(/\.py$/, "").replace(/\//g, ".");
      return `python -m uvicorn ${module}:app --reload`;
    }
    if (entry && /\bflask\b/.test(deps)) return `python -m flask --app ${entry.replace(/\.py$/, "").replace(/\//g, ".")} run --debug`;
    if (/\bstreamlit\b/.test(deps) && entry) return `python -m streamlit run ${entry}`;
  }

  try {
    if (fs.readdirSync(dir).some((f) => /\.(csproj|fsproj)$/.test(f))) return "dotnet watch run";
  } catch {
    // not readable
  }
  return undefined;
}
