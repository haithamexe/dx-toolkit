import { parseArgs } from "node:util";
import { dataTarget, findProjects, listScenes, loadConfig, loadData, loadScene, makeScene, qrMatrix, readDataSchema, readProject, RECIPES, saveCurrentData, saveScene, scanProjects, sceneSlug, type AttackReport, type Project, type Recipe } from "@dx/core";
import { ensureDashboard } from "@dx/web/link";
import type { Command } from "../command.js";
import { c, info, ok, table, UsageError } from "../ui.js";

function resolve(query: string): Project {
  if (!query || query === ".") {
    const here = readProject(process.cwd());
    if (here) return here;
    throw new UsageError("Which project? Give its name, or run this inside its folder.");
  }
  const { match, candidates } = findProjects(query, scanProjects(loadConfig()));
  const project = match ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (project) return project;
  throw new UsageError(candidates.length ? `Several projects match "${query}": ${candidates.slice(0, 8).map((p) => p.name).join(", ")}` : `No project matches "${query}".`);
}

export const dataCommand: Command = {
  name: "data",
  summary: "Realistic data for the development database: scenes made from the schema, loaded in seconds",
  usage: [
    "dx data <project>                               the schema, where data would go, and the scenes",
    "dx data make <project> [--recipe typical|big-customer|first-time|empty] [--seed 7] [--name \"Demo\"]",
    "dx data load <project> <scene> --yes            replace the data with a scene (what's there is saved first)",
    "dx data save <project> [name]                   save the data that's there as a scene",
    "",
    "Reads a Prisma schema, or CREATE TABLE in SQL migration files. Loads only into a database on this",
    "computer: through the project's own Prisma client, or the Postgres/MySQL its docker-compose runs.",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { recipe: { type: "string", short: "r" }, seed: { type: "string" }, name: { type: "string" }, yes: { type: "boolean", short: "y" } } });
    const verb = ["make", "load", "save", "list"].includes(positionals[0] ?? "") ? positionals[0] : "list";
    const rest = verb === "list" && positionals[0] !== "list" ? positionals : positionals.slice(1);
    const project = resolve(verb === "load" ? rest.slice(0, -1).join(" ") : verb === "save" && rest.length > 1 ? rest[0] : rest.join(" "));
    const schema = readDataSchema(project.dir);
    if (!schema) throw new Error(`No database schema found in ${project.name}: a Prisma schema, or CREATE TABLE in SQL migration files.`);
    const target = dataTarget(project, schema);
    if (verb === "list") {
      console.log(`${c.bold(project.name)}  ${schema.tables.length} tables from ${schema.file}  ${target.ok ? c.green(`→ ${target.where}`) : c.yellow(target.why ?? "")}`);
      const scenes = listScenes(project.dir);
      if (!scenes.length) return info(`No scenes yet: dx data make ${project.name}`);
      console.log(table(["Scene", "Kind", "Rows", "When"], scenes.map((s) => [s.slug, s.kind, String(s.rows), new Date(s.createdAt).toLocaleString()])));
      return;
    }
    if (verb === "make") {
      const recipe = (values.recipe ?? "typical") as Recipe;
      if (!RECIPES.some((r) => r.id === recipe)) throw new UsageError(`--recipe is one of ${RECIPES.map((r) => r.id).join(", ")}.`);
      const seed = values.seed ? Number(values.seed) : Math.floor(Math.random() * 9000) + 1000;
      const scene = makeScene(schema, recipe, seed, values.name ?? `${RECIPES.find((r) => r.id === recipe)!.name} #${seed}`);
      saveScene(project.dir, scene);
      return ok(`Made "${scene.name}" (${sceneSlug(scene.name)}): ${Object.entries(scene.rows).map(([t, r]) => `${r.length} ${t}`).join(", ")}. Load it with dx data load ${project.name} ${sceneSlug(scene.name)} --yes`);
    }
    if (verb === "save") {
      const scene = await saveCurrentData(project, schema, values.name ?? rest[1] ?? `Saved ${new Date().toLocaleString("en-GB")}`);
      return ok(`Saved "${scene.name}": ${Object.values(scene.rows).reduce((n, r) => n + r.length, 0)} rows.`);
    }
    const slug = rest.at(-1) ?? "";
    const scene = loadScene(project.dir, slug);
    if (!values.yes) throw new UsageError(`This replaces every row in ${schema.tables.length} tables of ${target.where ?? "the database"} with "${scene.name}" (what's there is saved first as a backup scene). Add --yes to go ahead.`);
    const r = await loadData(project, schema, scene, { source: "cli" });
    ok(`"${r.scene}" is in ${r.where}: ${r.rows} rows in ${(r.ms / 1000).toFixed(1)} s.${r.backup ? ` The old data is the scene "${r.backup}".` : ""}`);
  },
};

export const attackCommand: Command = {
  name: "attack",
  summary: "A friendly security pass on your own app, on this computer: XSS, IDOR, CSRF, CORS, cookies, headers, stack traces, login limits",
  usage: [
    "dx attack <project> [--cookie \"sid=…\"] [--authorization \"Bearer …\"] [--read-only]",
    "",
    "Tries the requests and pages in the project's history against its dev server (which dx runs).",
    "A session (from your browser's dev tools) lets it test signed-in calls; it's used for this run only.",
    "It sends a few test records and wrong passwords to your development database, unless --read-only.",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { cookie: { type: "string" }, authorization: { type: "string" }, "read-only": { type: "boolean" }, json: { type: "boolean" } } });
    const project = resolve(positionals.join(" "));
    const client = await ensureDashboard();
    let job = await client.post<{ id: string; step: string; finishedAt?: string; error?: string; result?: AttackReport }>("/api/chaos/attack", { dir: project.dir, session: { cookie: values.cookie, authorization: values.authorization }, readOnly: values["read-only"] });
    let said = "";
    while (!job.finishedAt) {
      if (job.step !== said) process.stderr.write(c.dim(`  ${job.step}\n`));
      said = job.step;
      await new Promise((r) => setTimeout(r, 1000));
      job = await client.get(`/api/chaos/job?id=${job.id}`);
    }
    if (job.error) throw new Error(job.error);
    const r = job.result!;
    if (values.json) return console.log(JSON.stringify(r, null, 2));
    console.log(c.dim(`${r.requests} requests. Tried: ${r.tried.join(", ")}.`));
    if (r.skipped.length) console.log(c.dim(`Not tried: ${r.skipped.join("; ")}.`));
    if (!r.findings.length) return ok("Nothing found.");
    for (const f of r.findings) {
      const mark = f.severity === "high" ? c.red("● serious") : f.severity === "medium" ? c.yellow("● worth fixing") : c.dim("● minor");
      console.log(`\n${mark}  ${c.bold(f.title)}${f.where ? c.dim(`  ${f.where}`) : ""}\n  ${f.fix}\n  ${c.dim(f.proof)}`);
    }
  },
};

export const phoneCommand: Command = {
  name: "phone",
  summary: "Open a running project on your own phone over Wi-Fi, with a QR code in the terminal",
  usage: ["dx phone <project> [--minutes 30]   a one-time link and its QR code, for one phone", "dx phone <project> --stop"].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { minutes: { type: "string" }, stop: { type: "boolean" } } });
    const project = resolve(positionals.join(" "));
    const client = await ensureDashboard();
    if (values.stop) {
      await client.post("/api/phone", { dir: project.dir, on: false });
      return ok("Stopped: the phone address no longer answers.");
    }
    const s = await client.post<{ url: string; expiresAt: string }>("/api/phone", { dir: project.dir, minutes: Number(values.minutes ?? 30) });
    // Two rows of modules per line, with half blocks; light on dark terminals reads either way round.
    const m = qrMatrix(s.url);
    const n = m.length + 8;
    const at = (r: number, col: number) => r >= 4 && col >= 4 && r < n - 4 && col < n - 4 && m[r - 4][col - 4];
    const lines: string[] = [];
    for (let r = 0; r < n; r += 2) {
      let line = "";
      for (let col = 0; col < n; col++) {
        const top = at(r, col);
        const bottom = at(r + 1, col);
        line += top && bottom ? " " : top ? "▄" : bottom ? "▀" : "█";
      }
      lines.push(line);
    }
    console.log(lines.join("\n"));
    ok(`Scan it with your phone's camera, or type ${s.url}`);
    info(`The link works once, for ${Math.round((Date.parse(s.expiresAt) - Date.now()) / 60_000)} minutes. What the phone does shows up in dx activity ${project.name} and the dashboard. dx phone ${project.name} --stop ends it.`);
  },
};
