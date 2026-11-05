import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { compareBehaviour, type BehaviourDiff } from "./behaviour.js";
import { checkPage, isLoopbackUrl, withBrowser } from "./browser.js";
import { A11Y_AUDIT, newIssues, PERF_INIT, PERF_READ, heavierThan, slowerThan, type A11yIssue, type PagePerf } from "./pagehealth.js";
import { detectPackageManager, type PackageManager, type Project } from "./projects.js";
import type { InstallCommand } from "./snapshots.js";
import { runTests, type TestRun } from "./tests.js";
import { compareVersions } from "./versions.js";
import { compareInBrowser, VISUAL_FREEZE, VISUAL_LABEL_AT, VISUAL_MIN_PIXELS, VISUAL_SETTLE, VISUAL_VIEWPORTS } from "./visual.js";

/**
 * Trying an upgrade before doing it: a throwaway copy of the project (`createWorkingCopy`) gets
 * the new version of one package; its type check, build and tests run before and after; then its
 * pages are compared with the project's own dev server: what they look like, what they call, their
 * errors, speed and accessibility. "3 pages look different, /checkout now throws, 2 tests fail",
 * before your own copy is touched.
 */

export interface UpgradeTarget {
  name: string;
  /** The version installed now. */
  from?: string;
  /** The version tried. */
  to: string;
  dev: boolean;
  major: boolean;
}

export type CheckName = "types" | "build" | "tests";

export interface CheckOutcome {
  name: CheckName;
  label: string;
  command: string;
  ok: boolean;
  ms: number;
  /** Error lines from the output (paths relative to the project), at most 20. */
  errors: string[];
  passed?: number;
  failed?: number;
  /** Failing test names. */
  failing?: string[];
}

export interface UpgradePage {
  path: string;
  behaviour?: BehaviourDiff;
  /** Looks different: the share of pixels, and what's there. */
  changed?: boolean;
  ratio?: number;
  label?: string;
  slower?: string;
  heavier?: string;
  perfBefore?: PagePerf;
  perfAfter?: PagePerf;
  a11yNew?: A11yIssue[];
  error?: string;
}

export interface UpgradeReport {
  project: string;
  target: UpgradeTarget;
  /** The copy it ran in (a snapshot id), to run again or remove. */
  copy?: string;
  checks: { before?: CheckOutcome; after?: CheckOutcome; name: CheckName }[];
  pages: UpgradePage[];
  /** The install's last lines when it failed. */
  install?: { ok: boolean; tail: string[] };
  /** "breaks", "changes" (looks or behaves differently) or "same". */
  verdict: "breaks" | "changes" | "same";
  summary: string[];
  ms: number;
}

const NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
// A tag or a version (or its start: "19", "19.1"). No range characters: the command runs through a shell on Windows.
const WANTED = /^([a-z][a-z0-9-]{0,30}|\d+(\.\d+){0,2}(-[0-9a-z.-]{1,40})?)$/i;
const SCRIPT = /^[\w:.-]{1,60}$/;

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as T;
  } catch {
    return undefined;
  }
}

type Pkg = { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };

/** The packages a project depends on, with what's installed, for picking one to try. */
export function upgradeChoices(dir: string): { name: string; range: string; installed?: string; dev: boolean }[] {
  const pkg = readJson<Pkg>(path.join(dir, "package.json"));
  const out: { name: string; range: string; installed?: string; dev: boolean }[] = [];
  for (const [deps, dev] of [[pkg?.dependencies, false], [pkg?.devDependencies, true]] as const)
    for (const [name, range] of Object.entries(deps ?? {})) {
      if (!NAME.test(name) || /^(workspace:|file:|link:|git|https?:)/.test(range)) continue;
      out.push({ name, range, installed: installedVersion(dir, name), dev });
    }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function installedVersion(dir: string, name: string): string | undefined {
  return readJson<{ version?: string }>(path.join(dir, "node_modules", ...name.split("/"), "package.json"))?.version;
}

export class UpgradeError extends Error {
  status = 400;
}

/** Checks the package (one the project depends on) and the version asked for, and finds the exact version on the npm registry. */
export async function resolveUpgrade(dir: string, name: string, wanted = "latest", fetchImpl: typeof fetch = fetch): Promise<UpgradeTarget> {
  if (!NAME.test(name)) throw new UpgradeError("That isn't a package name.");
  if (!WANTED.test(wanted)) throw new UpgradeError("The version is a number like 19 or 19.1.0, or a tag like latest or next.");
  const dep = upgradeChoices(dir).find((d) => d.name === name);
  if (!dep) throw new UpgradeError(`${name} isn't one of the project's dependencies.`);
  const from = dep.installed;
  const url = `https://registry.npmjs.org/${name.replace("/", "%2f")}`;
  let to: string | undefined;
  if (/^\d+(\.\d+){2}(-.*)?$/.test(wanted) && !/^\d+(\.\d+)?$/.test(wanted)) {
    const r = await fetchImpl(`${url}/${encodeURIComponent(wanted)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new UpgradeError(`${name}@${wanted} isn't on the npm registry.`);
    to = wanted;
  } else {
    const r = await fetchImpl(url, { headers: { accept: "application/vnd.npm.install-v1+json" }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new UpgradeError(`${name} isn't on the npm registry (or it couldn't be reached).`);
    const doc = (await r.json()) as { "dist-tags"?: Record<string, string>; versions?: Record<string, unknown> };
    if (/^[a-z]/i.test(wanted)) to = doc["dist-tags"]?.[wanted];
    else {
      const versions = Object.keys(doc.versions ?? {}).filter((v) => (v === wanted || v.startsWith(`${wanted}.`)) && !v.includes("-"));
      to = versions.sort(compareVersions).at(-1);
    }
    if (!to) throw new UpgradeError(`No ${name} version matches "${wanted}".`);
  }
  if (from && to === from) throw new UpgradeError(`${name} ${to} is already installed.`);
  const major = !!from && Number(from.split(".")[0]) !== Number(to.split(".")[0]);
  return { name, from, to, dev: dep.dev, major };
}

/** The package manager's own command to install that version (fixed words and a checked name and version). */
export function upgradeCommand(dir: string, t: Pick<UpgradeTarget, "name" | "to" | "dev">, pm: PackageManager = detectPackageManager(dir)): InstallCommand {
  if (!NAME.test(t.name) || !/^[0-9a-z.+-]{1,60}$/i.test(t.to)) throw new UpgradeError("That package or version can't be installed.");
  const spec = `${t.name}@${t.to}`;
  const args = pm === "npm" ? ["install", spec, ...(t.dev ? ["--save-dev"] : [])] : pm === "bun" ? ["add", spec, ...(t.dev ? ["--dev"] : [])] : ["add", spec, ...(t.dev ? ["-D"] : [])];
  return { label: `Installing ${spec} (${pm} ${args[0]})`, command: pm, args, cwd: dir, shell: process.platform === "win32" };
}

/** The type check and build the project has: its own scripts, else tsc when it's a TypeScript project. */
export function projectChecks(dir: string, pm: PackageManager = detectPackageManager(dir)): { name: CheckName; label: string; command: string; args: string[] }[] {
  const pkg = readJson<Pkg>(path.join(dir, "package.json"));
  const scripts = pkg?.scripts ?? {};
  const run = (s: string) => (pm === "npm" ? ["run", s] : pm === "yarn" ? [s] : ["run", s]);
  const out: { name: CheckName; label: string; command: string; args: string[] }[] = [];
  const typeScript = ["typecheck", "type-check", "check-types", "types", "tsc", "check", "lint:types"].find((s) => scripts[s] && SCRIPT.test(s));
  if (typeScript) out.push({ name: "types", label: `Type check (${typeScript})`, command: pm, args: run(typeScript) });
  else if (fs.existsSync(path.join(dir, "tsconfig.json")) && ("typescript" in { ...pkg?.dependencies, ...pkg?.devDependencies })) out.push({ name: "types", label: "Type check (tsc)", command: "npx", args: ["--no-install", "tsc", "--noEmit"] });
  if (scripts.build && !/\bdx\b/.test(scripts.build)) out.push({ name: "build", label: "Build", command: pm, args: run("build") });
  return out;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** The lines of a check's output that say what's wrong, with the copy's folder taken off paths. */
export function errorLines(output: string, dir: string): string[] {
  const variants = [dir, dir.split(path.sep).join("/"), dir.replace(/\\/g, "\\\\")];
  const out: string[] = [];
  for (const raw of output.replace(ANSI, "").split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || !/\berror\b|✖|✗|Failed to compile|Cannot find|is not assignable|has no exported member|Module not found/i.test(line)) continue;
    if (/^npm (ERR!|error) (code|path|command|A complete log|errno)\b/.test(line) || /^(ELIFECYCLE|error Command failed)/.test(line)) continue;
    for (const v of variants) line = line.split(`${v}${path.sep}`).join("").split(`${v}/`).join("").split(v).join(".");
    if (!out.includes(line)) out.push(line.slice(0, 300));
    if (out.length >= 20) break;
  }
  return out;
}

function run(cmd: { command: string; args: string[] }, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; output: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    // Fixed words and the project's own script names; no request value reaches it.
    const shell = process.platform === "win32";
    const child = shell
      ? spawn([cmd.command, ...cmd.args].join(" "), { cwd, shell: true, windowsHide: true, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } })
      : spawn(cmd.command, cmd.args, { cwd, windowsHide: true, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
    let output = "";
    const add = (b: Buffer) => (output = (output + b.toString("utf8")).slice(-200_000));
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    const stop = () => {
      if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else child.kill("SIGTERM");
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    child.on("error", (err) => (clearTimeout(timer), resolve({ ok: false, output: err.message, ms: Date.now() - started })));
    child.on("close", (code) => (clearTimeout(timer), resolve({ ok: code === 0, output, ms: Date.now() - started })));
  });
}

/** Runs the project's type check, build and tests in `dir` (the copy). */
export async function runChecks(project: Pick<Project, "name" | "packageManager">, dir: string, options: { onStep?: (s: string) => void; signal?: AbortSignal; tests?: boolean } = {}): Promise<CheckOutcome[]> {
  const out: CheckOutcome[] = [];
  for (const c of projectChecks(dir, project.packageManager ?? detectPackageManager(dir))) {
    if (options.signal?.aborted) break;
    options.onStep?.(c.label);
    const r = await run(c, dir, 10 * 60_000, options.signal);
    out.push({ name: c.name, label: c.label, command: [c.command, ...c.args].join(" "), ok: r.ok, ms: r.ms, errors: r.ok ? [] : errorLines(r.output, dir) });
  }
  if (options.tests !== false && !options.signal?.aborted) {
    options.onStep?.("Tests");
    // Named apart from the project, so the PR proof doesn't count the copy's runs as the project's.
    const t: TestRun = await runTests({ name: `${project.name} (upgrade copy)`, dir, packageManager: project.packageManager }, { timeoutMs: 10 * 60_000, source: "web" });
    if (!t.error || t.passed || t.failed)
      out.push({ name: "tests", label: `Tests (${t.framework})`, command: t.command, ok: t.ok, ms: t.ms, errors: t.ok ? [] : t.failures.length ? [] : errorLines(t.outputTail.join("\n"), dir), passed: t.passed, failed: t.failed, failing: t.failures.map((f) => f.name).slice(0, 20) });
  }
  return out;
}

/** Loads each page on both servers: behaviour (calls, errors), the picture, speed and accessibility. */
export async function comparePages(beforeBase: string, afterBase: string, paths: string[], options: { onStep?: (s: string) => void; signal?: AbortSignal } = {}): Promise<UpgradePage[]> {
  if (!isLoopbackUrl(beforeBase) || !isLoopbackUrl(afterBase)) throw new Error("Only dev servers on this computer.");
  const out: UpgradePage[] = [];
  const at = (base: string, p: string) => {
    const u = new URL(p, base);
    if (u.origin !== new URL(base).origin) throw new Error("Only paths on the dev server itself.");
    return u.href;
  };
  for (const p of paths) {
    if (options.signal?.aborted) break;
    const page: UpgradePage = { path: p };
    out.push(page);
    try {
      options.onStep?.(`${p}: what it does`);
      const a = await checkPage({ url: at(beforeBase, p), requests: true, settleMs: 2000, timeoutMs: 60_000 });
      const b = await checkPage({ url: at(afterBase, p), requests: true, settleMs: 2000, timeoutMs: 60_000 });
      page.behaviour = compareBehaviour(a, b, p);
    } catch (err) {
      page.error = (err as Error).message.split("\n")[0];
    }
  }
  // Pictures, speed and accessibility, in one browser.
  await withBrowser(async (session) => {
    const vp = VISUAL_VIEWPORTS.desktop;
    const blank = await session.newPage();
    const shoot = async (url: string) => {
      const tab = await session.newPage();
      await tab.send("Page.setBypassCSP", { enabled: true });
      await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await tab.send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false });
      await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: VISUAL_FREEZE });
      await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: PERF_INIT });
      let jsBytes = 0;
      const scripts = new Set<string>();
      tab.onEvent((method, ev) => {
        if (method === "Network.responseReceived" && ev.type === "Script") scripts.add(ev.requestId as string);
        else if (method === "Network.loadingFinished" && scripts.has(ev.requestId as string)) jsBytes += Number(ev.encodedDataLength ?? 0);
      });
      await tab.send("Page.bringToFront");
      // Warm up first: a dev server compiles on the first request.
      await tab.navigate(url, { settleMs: 300 }).catch(() => undefined);
      jsBytes = 0;
      scripts.clear();
      await tab.navigate(url, { settleMs: 1000, timeoutMs: 60_000 });
      const perf = await tab.evaluate<PagePerf>(PERF_READ, 5000);
      const a11y = (await tab.evaluate<A11yIssue[]>(A11Y_AUDIT, 15_000)) ?? [];
      await tab.evaluate(VISUAL_SETTLE, 15_000);
      const shot = await tab.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
      return { tab, shot: shot.data, perf: perf ? { ...perf, jsBytes: jsBytes || undefined } : undefined, a11y };
    };
    for (const page of out) {
      if (options.signal?.aborted || page.error) continue;
      try {
        options.onStep?.(`${page.path}: how it looks`);
        const a = await shoot(at(beforeBase, page.path));
        const b = await shoot(at(afterBase, page.path));
        page.perfBefore = a.perf;
        page.perfAfter = b.perf;
        page.slower = slowerThan(b.perf, a.perf);
        page.heavier = heavierThan(b.perf, a.perf);
        const fresh = newIssues(b.a11y, a.a11y);
        if (fresh.length) page.a11yNew = fresh;
        await blank.send("Page.bringToFront");
        const r = await compareInBrowser(blank, a.shot, b.shot);
        page.ratio = r.count / Math.max(1, r.width * r.height);
        page.changed = r.count >= VISUAL_MIN_PIXELS;
        if (page.changed && r.box) {
          await b.tab.send("Page.bringToFront");
          page.label = (await b.tab.evaluate<string>(`${VISUAL_LABEL_AT}(${r.box.x + r.box.width / 2}, ${r.box.y + r.box.height / 2})`, 5000)) || undefined;
        }
        await a.tab.send("Page.close").catch(() => undefined);
        await b.tab.send("Page.close").catch(() => undefined);
      } catch (err) {
        page.error = (err as Error).message.split("\n")[0];
      }
    }
  });
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The verdict and the sentences that say it: what breaks first, then what changes. */
export function summarizeUpgrade(r: Pick<UpgradeReport, "target" | "checks" | "pages" | "install">): Pick<UpgradeReport, "verdict" | "summary"> {
  const s: string[] = [];
  let breaks = false;
  let changes = false;
  if (r.install && !r.install.ok) return { verdict: "breaks", summary: [`${r.target.name}@${r.target.to} didn't install: ${r.install.tail.at(-1) ?? "see the output"}`] };
  for (const c of r.checks) {
    const { before, after } = c;
    if (!after) continue;
    if (c.name === "tests") {
      const was = before?.failed ?? 0;
      const now = after.failed ?? 0;
      if (now > was) {
        breaks = true;
        s.push(`${plural(now - was, "more test fails", "more tests fail")} (${after.passed ?? 0} passed, ${now} failed; was ${was} failed)`);
      } else if (now < was) s.push(`${plural(was - now, "test")} fewer failing`);
      else if (!after.ok && before?.ok) {
        breaks = true;
        s.push("The tests don't run any more");
      }
      continue;
    }
    if (!after.ok && (before?.ok ?? true)) {
      breaks = true;
      s.push(`${c.name === "types" ? "The type check fails" : "The build fails"}: ${after.errors[0] ?? "see the output"}${after.errors.length > 1 ? ` (and ${plural(after.errors.length - 1, "more line")})` : ""}`);
    } else if (!after.ok && before && !before.ok) {
      const fresh = after.errors.filter((e) => !before.errors.includes(e));
      if (fresh.length) {
        breaks = true;
        s.push(`${plural(fresh.length, "new error")} in the ${c.name === "types" ? "type check" : "build"}: ${fresh[0]}`);
      }
    } else if (after.ok && before && !before.ok) s.push(`The ${c.name === "types" ? "type check" : "build"} passes now`);
  }
  const looks = r.pages.filter((p) => p.changed);
  if (looks.length) {
    changes = true;
    s.push(`${plural(looks.length, "page looks", "pages look")} different: ${looks.map((p) => `${p.path}${p.label ? ` (${p.label})` : ""}`).join(", ")}`);
  }
  for (const p of r.pages) {
    const worse = p.behaviour?.changes.filter((c) => c.tone === "worse") ?? [];
    if (worse.length) {
      breaks = true;
      s.push(`${p.path}: ${worse.slice(0, 2).map((c) => c.text).join("; ")}`);
    } else if (p.behaviour && !p.behaviour.same) {
      changes = true;
      s.push(`${p.path} behaves differently: ${p.behaviour.changes[0].text}`);
    }
    if (p.slower) {
      changes = true;
      s.push(`${p.path} is slower: ${p.slower}`);
    }
    if (p.heavier) {
      changes = true;
      s.push(`${p.path} loads more script: ${p.heavier}`);
    }
    if (p.a11yNew?.length) {
      changes = true;
      s.push(`${p.path}: ${plural(p.a11yNew.length, "new accessibility problem")} (${p.a11yNew[0].text})`);
    }
    if (p.error) s.push(`${p.path} couldn't be compared: ${p.error}`);
  }
  if (!s.length) s.push(`Nothing changed that dx can see: the checks pass as before${r.pages.length ? `, and ${plural(r.pages.length, "page")} look and behave the same` : ""}.`);
  return { verdict: breaks ? "breaks" : changes ? "changes" : "same", summary: s };
}
