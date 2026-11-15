import { parseArgs } from "node:util";
import { findProjects, loadConfig, readProject, scanProjects, searchProject, searchProjects, type FileResult, type Project, type SearchMode } from "@dx/core";
import type { Command } from "../command.js";
import { c, UsageError } from "../ui.js";

/** A line with its matches in colour. */
function highlight(text: string, ranges: [number, number][]): string {
  let out = "";
  let at = 0;
  for (const [a, b] of ranges) {
    out += text.slice(at, a) + c.yellow(c.bold(text.slice(a, b)));
    at = b;
  }
  return out + text.slice(at);
}

function resolveProject(query: string): Project {
  if (query === ".") {
    const here = readProject(process.cwd());
    if (here) return here;
    throw new UsageError("This folder isn't a project. Give a project's name.");
  }
  const { match, candidates } = findProjects(query, scanProjects(loadConfig()));
  const project = match ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (project) return project;
  throw new UsageError(candidates.length ? `Several projects match "${query}": ${candidates.slice(0, 8).map((p) => p.name).join(", ")}` : `No project matches "${query}".`);
}

export const searchCommand: Command = {
  name: "search",
  summary: "Find a file by name, or a word in your code, in a project or in all of them",
  usage: [
    "dx search <words>                  files by name and lines of code, in the project of this folder",
    "dx search <words> -p shop-website  in one project;  --all  in every project",
    "dx search <words> --files          only file names (fuzzy: 'cartserv' finds CartService.ts)",
    "dx search <words> --content        only what is inside the files",
    "dx search 'fn\\w+' --regex          a regular expression;  --word  whole words;  -s  case-sensitive;  -i  not",
    "dx search <words> --ext ts,tsx     only those kinds of file;  --in src/cart  only that folder",
    "dx search <words> --json           the result as data",
    "",
    "Reads the files git lists for the project; never inside .env files, keys or certificates.",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        project: { type: "string", short: "p" },
        all: { type: "boolean" },
        files: { type: "boolean" },
        content: { type: "boolean" },
        regex: { type: "boolean", short: "r" },
        word: { type: "boolean", short: "w" },
        s: { type: "boolean", short: "s" },
        i: { type: "boolean", short: "i" },
        ext: { type: "string" },
        in: { type: "string" },
        max: { type: "string" },
        json: { type: "boolean" },
      },
    });
    const query = positionals.join(" ").trim();
    if (!query) throw new UsageError("What to look for? dx search cartservice");
    const mode: SearchMode = values.files ? "files" : values.content ? "content" : "all";
    const options = {
      query,
      mode,
      caseSensitive: values.s ? true : values.i ? false : undefined,
      wholeWord: values.word,
      regex: values.regex,
      ext: values.ext?.split(",").map((s) => s.trim()).filter(Boolean),
      folders: values.in ? [values.in] : undefined,
      maxFiles: Math.max(1, Math.min(Number(values.max) || 25, 200)),
      perFile: 4,
    };
    let files: (FileResult & { project?: string })[];
    let totals;
    let patternError: string | undefined;
    if (values.all) {
      const r = await searchProjects(scanProjects(loadConfig()).map((p) => ({ name: p.name, dir: p.dir })), options);
      ({ files, totals, patternError } = r);
      if (values.json) return void console.log(JSON.stringify(r, null, 2));
    } else {
      const project = resolveProject(values.project ?? ".");
      const r = await searchProject(project.dir, options);
      ({ files, totals, patternError } = r);
      if (values.json) return void console.log(JSON.stringify({ project: project.name, ...r }, null, 2));
    }
    if (patternError) throw new UsageError(patternError);
    if (!files.length) {
      console.log(`Nothing for "${query}"${totals.skipped ? c.dim(` (${totals.scanned} files read)`) : ""}.`);
      return;
    }
    for (const f of files) {
      const where = f.project ? `${c.magenta(f.project)} ` : "";
      const name = f.path.split("/");
      const file = name.pop()!;
      console.log(`\n${where}${c.dim(name.length ? `${name.join("/")}/` : "")}${c.bold(c.cyan(file))}${f.matches ? c.dim(`  ${f.matches} match${f.matches === 1 ? "" : "es"}`) : c.dim("  name")}`);
      for (const h of f.hits) {
        const tag = h.kind === "definition" ? c.green(" def") : h.kind === "comment" ? c.dim(" //") : "";
        console.log(`  ${c.dim(String(h.line).padStart(5))}${tag}  ${highlight(h.text.trim() === h.text ? h.text : h.text, h.ranges)}`);
      }
      if (f.matches > f.hits.length) console.log(c.dim(`        …and ${f.matches - f.hits.length} more`));
    }
    console.log(c.dim(`\n${totals.files} file${totals.files === 1 ? "" : "s"}, ${totals.matches} match${totals.matches === 1 ? "" : "es"} in ${totals.ms} ms${totals.files > files.length ? ` · showing ${files.length}, narrow with --ext or --in` : ""}`));
  },
};
