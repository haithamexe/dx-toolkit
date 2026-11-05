import { parseArgs } from "node:util";
import {
  CHAOS_LEVELS,
  chaosReport,
  describeLocaleProblem,
  findGraveyard,
  findProjects,
  loadChaos,
  loadConfig,
  probeEnv,
  readActivity,
  readProject,
  recordRun,
  scanProjects,
  setChaos,
  type BehaviourDiff,
  type ChaosLevel,
  type GremlinRun,
  type LocaleReport,
  type Project,
} from "@dx/core";
import { ensureDashboard, findDashboard } from "@dx/web/link";
import type { Command } from "../command.js";
import { c, info, ok, table, UsageError } from "../ui.js";

const LEVEL_WORDS: Record<string, ChaosLevel> = { wifi: "wifi", "bad-wifi": "wifi", deploy: "deploy", monday: "deploy", blackfriday: "blackfriday", "black-friday": "blackfriday" };

export const chaosCommand: Command = {
  name: "chaos",
  summary: "Break the app on purpose: failing calls, gremlins, a fake clock, a weak phone, missing .env values, behaviour diffs, unused routes",
  usage: [
    "dx chaos <project>                          what chaos mode is doing, and what broke",
    "dx chaos on <project> [--level wifi|deploy|blackfriday] [--seed 4812] [--only /api/**]",
    "dx chaos off <project>",
    "dx chaos clock <project> 2026-12-31T23:59:50 [--zone Pacific/Auckland] [--frozen]",
    "dx chaos clock <project> off",
    "dx chaos phone <project> on|off             the dx browser and gremlins as a cheap phone on 3G",
    "dx chaos languages <project> pseudo|rtl|both|off   longer, accented text and right to left in the page",
    "dx chaos languages <project> [--path /,/cart]      check the pages: text cut off, and text not translated",
    "dx chaos gremlins <project> [--actions 40] [--seed 7] [--path /] [--phone] [--bold]",
    "dx chaos env <project> [--path /]           which .env values matter when they're missing",
    "dx chaos diff <project> [--commit abc1234] [--path /cart]   behaviour against an earlier commit",
    "dx chaos graveyard <project> [--days 30]    routes, pages and mocks nobody used",
    "",
    "Chaos mode breaks the project's API calls as they pass through dx (its .localhost address, or",
    "the address dx records): slow, 500s, dropped, logged out, out of order, rate limited, odd data.",
    "Seeded, so the same seed breaks the same calls the same way. Gremlins and behaviour diffs use",
    "the dev server dx runs; the dashboard starts in the background when needed.",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        level: { type: "string", short: "l" },
        seed: { type: "string" },
        only: { type: "string" },
        zone: { type: "string" },
        frozen: { type: "boolean" },
        actions: { type: "string", short: "n" },
        path: { type: "string", short: "p" },
        phone: { type: "boolean" },
        bold: { type: "boolean" },
        commit: { type: "string" },
        days: { type: "string" },
        json: { type: "boolean" },
      },
    });
    const verbs = ["on", "off", "clock", "phone", "languages", "gremlins", "env", "diff", "graveyard", "report"];
    const verb = verbs.includes(positionals[0] ?? "") ? positionals[0] : "report";
    const rest = verb === "report" && positionals[0] !== "report" ? positionals : positionals.slice(1);

    if (verb === "clock" || verb === "phone") {
      const value = rest.at(-1) ?? "";
      const project = resolve(rest.slice(0, -1).join(" "));
      if (verb === "phone") {
        if (value !== "on" && value !== "off") throw new UsageError("dx chaos phone <project> on|off");
        setChaos(project.dir, project.name, { phone: value === "on" });
        await tellDashboard(project, { phone: value === "on" });
        return ok(value === "on" ? `Weak phone on for ${project.name}: the dx browser's tabs and gremlins run as a cheap phone on 3G.` : "Weak phone off.");
      }
      const clock = value === "off" ? null : { at: value === "now" ? "" : value, timeZone: values.zone, frozen: values.frozen };
      const cfg = setChaos(project.dir, project.name, { clock });
      recordRun("chaos", true, `${project.name}: ${cfg.clock ? `clock ${cfg.clock.at ?? "now"}${cfg.clock.timeZone ? ` in ${cfg.clock.timeZone}` : ""}` : "real clock"}`, "cli", { project: project.name });
      return ok(cfg.clock ? `${project.name}'s pages see ${cfg.clock.at ? new Date(cfg.clock.at).toLocaleString("en-GB", { timeZone: cfg.clock.timeZone, dateStyle: "full", timeStyle: "long" }) : "the real time"}${cfg.clock.timeZone ? ` in ${cfg.clock.timeZone}` : ""}${cfg.clock.frozen ? ", frozen" : ""}. Reload them.` : `${project.name}'s pages see the real time again.`);
    }

    if (verb === "languages") {
      const modes = ["pseudo", "rtl", "both", "off"];
      const mode = modes.includes(rest.at(-1) ?? "") ? rest.at(-1)! : undefined;
      const project = resolve((mode ? rest.slice(0, -1) : rest).join(" "));
      if (mode) {
        const locale = mode === "off" ? null : { pseudo: mode === "pseudo" || mode === "both", rtl: mode === "rtl" || mode === "both" };
        setChaos(project.dir, project.name, { locale });
        recordRun("chaos", true, `${project.name}: languages ${mode}`, "cli", { project: project.name });
        return ok(mode === "off" ? `${project.name}'s pages show their own text again. Reload them.` : `${project.name}'s pages through dx show ${mode === "both" ? "longer, accented text, right to left" : mode === "rtl" ? "right to left" : "longer, accented text"}. Reload them.`);
      }
      const client = await ensureDashboard();
      let job = await client.post<{ id: string; step: string; finishedAt?: string; error?: string; result?: LocaleReport }>("/api/chaos/locale", { dir: project.dir, paths: values.path ? values.path.split(",").map((s) => s.trim()) : undefined });
      let said = "";
      while (!job.finishedAt) {
        if (job.step !== said) process.stderr.write(c.dim(`  ${job.step}\n`));
        said = job.step;
        await new Promise((r) => setTimeout(r, 1000));
        job = await client.get(`/api/chaos/job?id=${job.id}`);
      }
      if (job.error || !job.result) throw new Error(job.error ?? "The check didn't finish.");
      const r = job.result;
      if (values.json) return console.log(JSON.stringify(r, null, 2));
      console.log(c.dim(`${r.pages.length} page(s); ${r.files.length ? `${r.files.length} translation file(s)${r.library ? ` (${r.library})` : ""}` : "no translation files"}; ${r.translated} texts translated, ${r.fromData} from the app's data.`));
      for (const p of r.pages.filter((x) => x.error)) console.log(c.red(`  ${p.path}: ${p.error}`));
      if (!r.problems.length) return ok("Text fits everywhere, and all of it comes from the translations.");
      for (const p of r.problems) console.log(`${p.kind === "hard-coded" ? c.yellow("●") : c.red("●")} ${describeLocaleProblem(p)}`);
      return info("The pictures (outlined) are on the dashboard's Chaos page, Languages.");
    }

    const project = resolve(rest.join(" "));
    if (verb === "on" || verb === "off") {
      const level = values.level ? LEVEL_WORDS[values.level.toLowerCase()] : undefined;
      if (values.level && !level) throw new UsageError("--level is wifi, deploy or blackfriday.");
      const cfg = setChaos(project.dir, project.name, { on: verb === "on", level, seed: values.seed, paths: values.only });
      recordRun("chaos", true, `${project.name}: ${cfg.on ? `chaos on (${CHAOS_LEVELS[cfg.level].name}, #${cfg.seed})` : "chaos off"}`, "cli", { project: project.name });
      if (!cfg.on) return ok(`Chaos off for ${project.name}: calls go through untouched.`);
      ok(`Chaos on for ${project.name}: ${CHAOS_LEVELS[cfg.level].name} (${CHAOS_LEVELS[cfg.level].about}), seed #${cfg.seed}${cfg.paths ? `, only ${cfg.paths}` : ""}.`);
      return info("Use the app at its .localhost address; dx chaos shows what broke.");
    }

    if (verb === "report") {
      const cfg = loadChaos(project.dir, project.name);
      const since = cfg.startedAt ? new Date(cfg.startedAt) : new Date(Date.now() - 3_600_000);
      const r = chaosReport(readActivity({ dir: project.dir, since, limit: 20_000 }), since.toISOString());
      if (values.json) return console.log(JSON.stringify({ config: cfg, report: r }, null, 2));
      console.log(`${c.bold(project.name)}  ${cfg.on ? c.red(`chaos on · ${CHAOS_LEVELS[cfg.level].name} · #${cfg.seed}`) : c.dim("chaos off")}${cfg.clock ? c.yellow(`  clock ${cfg.clock.at ?? "now"}${cfg.clock.timeZone ? ` ${cfg.clock.timeZone}` : ""}`) : ""}${cfg.phone ? c.yellow("  weak phone") : ""}`);
      console.log(c.dim(`Since ${since.toLocaleString()}: ${r.calls} API calls, ${r.broken} broken on purpose${Object.keys(r.byFault).length ? ` (${Object.entries(r.byFault).map(([k, n]) => `${k} ×${n}`).join(", ")})` : ""}.`));
      if (!r.findings.length) return info(r.calls ? "Nothing broke so far." : "No calls yet: use the app at its .localhost address.");
      for (const f of r.findings) console.log(`${c.red("●")} ${f.title}${f.detail ? c.dim(`  ${f.detail.split("\n")[0].slice(0, 100)}`) : ""}${f.after?.length ? c.dim(`\n    after ${f.after.join(" · ")}`) : ""}`);
      return;
    }

    if (verb === "env") {
      info(`Starting ${project.name} once as it is, then once per .env value with only that value blank…`);
      const r = await probeEnv(project, { path: values.path, progress: (done, total, key) => process.stderr.write(c.dim(`  ${done}/${total - 1} ${done ? `without ${key}` : "as it is"}\n`)) });
      recordRun("env-probe", !r.error, `${project.name}: ${r.error ?? `${r.values.filter((v) => v.verdict === "crashes" || v.verdict === "breaks").length} value(s) matter`}`, "cli", { project: project.name });
      if (values.json) return console.log(JSON.stringify(r, null, 2));
      if (r.error) throw new Error(r.error);
      const word = { crashes: c.red("crashes"), breaks: c.yellow("breaks the page"), unnoticed: c.dim("nothing noticed"), unused: c.cyan("never used in the code"), skipped: c.dim("not tried") };
      console.log(table(["Value", "Without it", "What happened"], r.values.map((v) => [v.key, word[v.verdict], v.problems.slice(0, 2).join("; ") || (v.usedCount ? c.dim(v.usedIn.join(", ")) : "")])));
      return;
    }

    if (verb === "graveyard") {
      const g = findGraveyard(project.dir, project.name, { days: Number(values.days ?? 30) || 30 });
      if (values.json) return console.log(JSON.stringify(g, null, 2));
      console.log(c.dim(`${project.name}, the last ${g.days} day(s) of history: ${g.events} requests and page events${g.unmatched ? `; ${g.unmatched} call(s) matched no route dx found` : ""}.`));
      for (const [title, list] of [
        ["API routes never called", g.endpoints],
        ["Pages never opened", g.pages],
        ["Mocks nothing asked for", g.mocks],
      ] as const) {
        const dead = list.filter((e) => !e.uses);
        console.log(`\n${c.bold(title)} ${c.dim(`(${dead.length} of ${list.length})`)}`);
        for (const e of dead) console.log(`  ${e.what}  ${c.dim(e.from)}`);
      }
      return;
    }

    // Gremlins and behaviour diffs run in the dashboard, where the dev servers are.
    const client = await ensureDashboard();
    const body = verb === "gremlins" ? { dir: project.dir, actions: values.actions ? Number(values.actions) : undefined, seed: values.seed ? Number(values.seed) : undefined, path: values.path, phone: values.phone, bold: values.bold } : { dir: project.dir, commit: values.commit, paths: values.path ? [values.path] : undefined };
    let job = await client.post<{ id: string; step: string; done: number; total: number; finishedAt?: string; phase: string; error?: string; result?: unknown }>(verb === "gremlins" ? "/api/chaos/gremlins" : "/api/chaos/behaviour", body);
    let said = "";
    while (!job.finishedAt) {
      if (job.step !== said) process.stderr.write(c.dim(`  ${job.step}\n`));
      said = job.step;
      await new Promise((r) => setTimeout(r, 1000));
      job = await client.get(`/api/chaos/job?id=${job.id}`);
    }
    if (job.error) throw new Error(job.error);
    if (values.json) return console.log(JSON.stringify(job.result, null, 2));
    if (verb === "gremlins") {
      const run = job.result as GremlinRun;
      console.log(c.dim(`Gremlins #${run.seed}: ${run.actions} actions on ${run.pages.length} page(s) in ${Math.round(run.ms / 1000)} s.`));
      if (!run.findings.length) return ok("They found nothing.");
      for (const f of run.findings) console.log(`${c.red("●")} ${f.text}${c.dim(`  ${f.step ? `after step ${f.step}` : "while loading"}${f.count > 1 ? `, ${f.count} times` : ""}`)}`);
      return info(`The steps to each are in the dashboard's Chaos page, with Replay; or dx chaos gremlins ${project.name} --seed ${run.seed} --json.`);
    }
    const r = job.result as { against: string; diffs: BehaviourDiff[] };
    console.log(c.dim(`Your working copy against ${r.against}:`));
    for (const d of r.diffs) {
      console.log(`\n${c.bold(d.path)}`);
      if (d.same) console.log(c.green("  behaves the same"));
      for (const x of d.changes) console.log(`  ${x.tone === "worse" ? c.red("▲") : x.tone === "better" ? c.green("▼") : c.dim("•")} ${x.text}`);
    }
  },
};

async function tellDashboard(project: Project, body: Record<string, unknown>): Promise<void> {
  // The dx browser lives in the dashboard: tell it, when it's running.
  const client = await findDashboard();
  await client?.post("/api/chaos", { dir: project.dir, ...body }).catch(() => undefined);
}

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
