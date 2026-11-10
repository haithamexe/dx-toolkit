import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordRun } from "../runs.js";
import { parseCoverageSummary, parseGoCover, parsePytestCoverage, parseV8Coverage, type Coverage } from "./coverage.js";
import type { Project } from "./projects.js";

/**
 * Runs a project's tests and reads the result the way a person would want it: how many passed,
 * and for each failure its name, file and line, the message, and expected against actual.
 * Each framework is asked for a machine-readable report (vitest and jest JSON, node:test TAP,
 * pytest JUnit XML, go test JSON), so nothing is guessed from coloured console output.
 */

export type TestFramework = "vitest" | "jest" | "node" | "pytest" | "go" | "script";

export interface TestFailure {
  name: string;
  file?: string;
  line?: number;
  column?: number;
  message: string;
  expected?: string;
  actual?: string;
  /** The first few stack lines in the project's own code. */
  stack?: string[];
}

export interface TestRun {
  project: string;
  framework: TestFramework;
  command: string;
  ok: boolean;
  passed: number;
  failed: number;
  skipped: number;
  ms: number;
  failures: TestFailure[];
  /** The end of what the command printed, for when the report says little (a crash before any test ran). */
  outputTail: string[];
  /** Why there's no usable report: no test command, timed out, … */
  error?: string;
  /** How much of the code the tests ran, when coverage was asked for and the framework could say. */
  coverage?: Coverage;
  /** Why there's no coverage when it was asked for, and what to do about it. */
  coverageNote?: string;
}

export interface TestOptions {
  /** Only tests whose name matches (vitest/jest -t, pytest -k, go -run, node --test-name-pattern). */
  match?: string;
  /** Only these test files (paths relative to the project). */
  files?: string[];
  /** Only tests related to files changed since the last commit (vitest and jest). */
  changed?: boolean;
  /** Also measure how much of the code the tests run (vitest with a coverage provider, jest, node:test, pytest-cov, go). */
  coverage?: boolean;
  timeoutMs?: number;
  source?: string;
}

/** Which framework a project tests with, from its dependencies and test script. */
export function detectTestFramework(dir: string): { framework: TestFramework; script?: string } | undefined {
  const pkg = readJson<{ scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(path.join(dir, "package.json"));
  if (pkg) {
    const script = pkg.scripts?.test;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const has = (name: string) => name in deps || new RegExp(`\\b${name}\\b`).test(script ?? "");
    if (has("vitest")) return { framework: "vitest", script };
    if (has("jest")) return { framework: "jest", script };
    if (script && /\bnode\b[^&|;]*--test\b/.test(script)) return { framework: "node", script };
    if (script && !/no test specified/.test(script)) return { framework: "script", script };
  }
  const exists = (f: string) => fs.existsSync(path.join(dir, f));
  if (exists("pytest.ini") || exists("conftest.py") || exists("pyproject.toml") || exists("tests") && fs.readdirSync(path.join(dir, "tests")).some((f) => /^test_.*\.py$/.test(f))) {
    if (exists("pytest.ini") || exists("conftest.py") || /pytest/.test(read(path.join(dir, "pyproject.toml")) + read(path.join(dir, "requirements.txt")) + read(path.join(dir, "requirements-dev.txt")))) return { framework: "pytest" };
  }
  if (exists("go.mod")) return { framework: "go" };
  return undefined;
}

export async function runTests(project: Pick<Project, "name" | "dir" | "packageManager">, options: TestOptions = {}): Promise<TestRun> {
  const found = detectTestFramework(project.dir);
  const started = Date.now();
  const empty = (framework: TestFramework, command: string): TestRun => ({ project: project.name, framework, command, ok: false, passed: 0, failed: 0, skipped: 0, ms: 0, failures: [], outputTail: [] });
  if (!found) {
    return { ...empty("script", ""), error: "No tests found: no test script in package.json, no pytest setup, no go.mod." };
  }
  const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dx-tests-")), "report");
  const pm = project.packageManager ?? "npm";
  const runScript = pm === "npm" ? "npm test --" : `${pm} test`;
  const files = (options.files ?? []).map(quote).join(" ");
  // Coverage goes to a folder next to the report; each framework's flags are added only when it can actually produce it.
  const covDir = path.join(path.dirname(report), "coverage");
  let covFile: string | undefined;
  let covKind: "summary" | "pytest" | "go" | "v8" | undefined;
  let coverageNote: string | undefined;
  const wantCoverage = options.coverage === true;
  const hasPackage = (name: string) => fs.existsSync(path.join(project.dir, "node_modules", ...name.split("/")));
  let command: string;
  let env: NodeJS.ProcessEnv = { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" };
  // Set when dx itself runs under node --test; a child node --test would then report to it instead.
  delete env.NODE_TEST_CONTEXT;
  switch (found.framework) {
    case "vitest":
      command = `npx --no-install vitest run ${files} --reporter=json --outputFile=${quote(report)}${options.match ? ` -t ${quote(options.match)}` : ""}${options.changed ? " --changed" : ""}`;
      if (wantCoverage) {
        // vitest stops at once without a coverage provider, so it's only asked for when one is installed.
        if (hasPackage("@vitest/coverage-v8") || hasPackage("@vitest/coverage-istanbul")) {
          command += ` --coverage --coverage.reporter=json-summary --coverage.reportsDirectory=${quote(covDir)}`;
          covFile = path.join(covDir, "coverage-summary.json");
          covKind = "summary";
        } else coverageNote = "vitest needs a coverage provider: npm install -D @vitest/coverage-v8, then run again.";
      }
      break;
    case "jest":
      command = `npx --no-install jest ${files} --json --outputFile=${quote(report)} --testLocationInResults${options.match ? ` -t ${quote(options.match)}` : ""}${options.changed ? " --onlyChanged" : ""}`;
      if (wantCoverage) {
        command += ` --coverage --coverageReporters=json-summary --coverageDirectory=${quote(covDir)}`;
        covFile = path.join(covDir, "coverage-summary.json");
        covKind = "summary";
      }
      break;
    case "node":
      // The project's own script, with the TAP reporter added through NODE_OPTIONS.
      command = runScript;
      // The usual output still goes to the terminal; the TAP copy goes to a file dx reads.
      env = {
        ...env,
        NODE_OPTIONS: [
          env.NODE_OPTIONS ?? "",
          "--test-reporter=spec --test-reporter-destination=stdout",
          `--test-reporter=tap --test-reporter-destination="${report.replace(/\\/g, "/")}"`,
          options.match ? `--test-name-pattern="${options.match.replace(/"/g, "")}"` : "",
        ]
          .join(" ")
          .trim(),
      };
      // node's own coverage flag can't be set through NODE_OPTIONS, but V8 writes its raw coverage to a folder on request.
      if (wantCoverage) {
        env.NODE_V8_COVERAGE = covDir;
        covKind = "v8";
      }
      break;
    case "pytest":
      command = `${(await pythonCommand()) ?? "python"} -m pytest ${files} -q --junitxml=${quote(report)}${options.match ? ` -k ${quote(options.match)}` : ""}`;
      if (wantCoverage) {
        // pytest fails on --cov when pytest-cov isn't installed, so it's only asked for when the project lists it.
        if (/pytest-cov|\bcoverage\b/.test(read(path.join(project.dir, "pyproject.toml")) + read(path.join(project.dir, "requirements.txt")) + read(path.join(project.dir, "requirements-dev.txt")))) {
          covFile = path.join(covDir, "coverage.json");
          fs.mkdirSync(covDir, { recursive: true });
          command += ` --cov=. --cov-report=json:${quote(covFile)}`;
          covKind = "pytest";
        } else coverageNote = "pytest needs pytest-cov: pip install pytest-cov, then run again.";
      }
      break;
    case "go":
      command = `go test -json ${files || "./..."}${options.match ? ` -run ${quote(options.match)}` : ""}`;
      if (wantCoverage) {
        covFile = path.join(path.dirname(report), "cover.out");
        command += ` -coverprofile=${quote(covFile)}`;
        covKind = "go";
      }
      break;
    default:
      command = runScript;
      if (wantCoverage) coverageNote = "This project's own test script can't be measured by dx. Run its coverage command (for example npx c8 npm test) yourself.";
  }

  const result = await run(command, project.dir, env, options.timeoutMs ?? 600_000);
  const out: TestRun = { ...empty(found.framework, command), ms: Date.now() - started, outputTail: tail(result.output, 40) };
  if (result.timedOut) out.error = `Stopped after ${Math.round((options.timeoutMs ?? 600_000) / 1000)}s.`;

  try {
    if (found.framework === "vitest" || found.framework === "jest") Object.assign(out, parseJestJson(read(report), project.dir));
    else if (found.framework === "node") Object.assign(out, parseTap(read(report), project.dir));
    else if (found.framework === "pytest") Object.assign(out, parseJunit(read(report), project.dir));
    else if (found.framework === "go") Object.assign(out, parseGoJson(result.stdout, project.dir));
  } catch {
    // An unreadable report: the exit code and the output tail still say what happened.
  }
  if (found.framework === "script" || (!out.passed && !out.failed && !out.failures.length)) {
    if (!result.ok && !out.error) out.error = found.framework === "script" ? undefined : "The tests didn't produce a report; the output below says why.";
  }
  out.ok = result.ok && out.failed === 0 && !out.error;
  if (wantCoverage) {
    try {
      if (covKind === "summary" && covFile) out.coverage = parseCoverageSummary(read(covFile), project.dir);
      else if (covKind === "pytest" && covFile) out.coverage = parsePytestCoverage(read(covFile), project.dir);
      else if (covKind === "go" && covFile) out.coverage = parseGoCover(read(covFile));
      else if (covKind === "v8") out.coverage = parseV8Coverage(covDir, project.dir);
    } catch {
      // an unreadable coverage file: the note below says there's none
    }
    if (!out.coverage) out.coverageNote = coverageNote ?? "The tests ran but wrote no coverage report.";
  }
  fs.rmSync(path.dirname(report), { recursive: true, force: true });
  recordRun("test", out.ok, `${project.name}: ${out.passed} passed, ${out.failed} failed`, options.source ?? "cli", { project: project.name, ms: out.ms });
  return out;
}

type Counts = Pick<TestRun, "passed" | "failed" | "skipped" | "failures">;

/** vitest --reporter=json and jest --json share this shape. */
export function parseJestJson(text: string, dir: string): Counts {
  const json = JSON.parse(text) as {
    numPassedTests?: number;
    numFailedTests?: number;
    numPendingTests?: number;
    numTodoTests?: number;
    testResults?: { name: string; message?: string; status?: string; assertionResults?: { fullName?: string; title: string; status: string; failureMessages?: string[]; location?: { line: number; column: number } }[] }[];
  };
  const failures: TestFailure[] = [];
  for (const file of json.testResults ?? []) {
    const rel = relative(dir, file.name);
    const failed = (file.assertionResults ?? []).filter((a) => a.status === "failed");
    for (const a of failed) {
      const msg = clean((a.failureMessages ?? []).join("\n"));
      failures.push({ name: a.fullName || a.title, file: rel, line: a.location?.line ?? lineIn(msg, file.name), column: a.location?.column, ...splitMessage(msg, dir) });
    }
    // A file that failed before any test ran (a syntax error, a bad import).
    if (!failed.length && file.status === "failed" && file.message) failures.push({ name: `${rel} (didn't run)`, file: rel, ...splitMessage(clean(file.message), dir) });
  }
  return {
    passed: json.numPassedTests ?? 0,
    failed: Math.max(json.numFailedTests ?? 0, failures.length),
    skipped: (json.numPendingTests ?? 0) + (json.numTodoTests ?? 0),
    failures,
  };
}

/** node --test with the TAP reporter: "not ok N - name" followed by a YAML block. */
export function parseTap(text: string, dir: string): Counts {
  const lines = text.split(/\r?\n/);
  const failures: TestFailure[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(not ok|ok) \d+ - (.*?)(?:\s+#\s*(SKIP|TODO).*)?$/.exec(lines[i]);
    if (!m) {
      const total = /^# (pass|fail|skipped|todo) (\d+)$/.exec(lines[i]);
      if (total) {
        if (total[1] === "pass") passed = Number(total[2]);
        if (total[1] === "fail") failed = Number(total[2]);
        if (total[1] === "skipped" || total[1] === "todo") skipped += Number(total[2]);
      }
      continue;
    }
    if (m[2] !== "not ok" || m[4]) continue;
    const indent = m[1].length;
    const block: string[] = [];
    if (lines[i + 1]?.trim() === "---") {
      let j = i + 2;
      for (; j < lines.length && lines[j].trim() !== "..."; j++) block.push(lines[j].slice(indent + 2));
      i = j;
    }
    const yaml = readYaml(block);
    if (yaml.type === "suite" || yaml.failureType === "subtestsFailed") continue;
    const loc = /^(.*):(\d+):(\d+)$/.exec(yaml.location ?? "");
    const stack = (yaml.stack ?? "").split("\n").filter((l) => l && !/node:internal|node:async_hooks/.test(l));
    failures.push({
      name: m[3],
      file: loc ? relative(dir, loc[1]) : undefined,
      line: loc ? Number(loc[2]) : undefined,
      column: loc ? Number(loc[3]) : undefined,
      message: clean(yaml.error ?? yaml.name ?? "failed"),
      expected: yaml.expected,
      actual: yaml.actual,
      stack: stack.slice(0, 4).map((l) => shorten(l, dir)),
    });
  }
  return { passed, failed: Math.max(failed, failures.length), skipped, failures };
}

/** A tiny reader for the YAML node:test writes: key: value, and key: |- blocks. */
function readYaml(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\w+): ?(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2] === "|-" || m[2] === "|") {
      const body: string[] = [];
      while (i + 1 < lines.length && (lines[i + 1].startsWith("  ") || lines[i + 1] === "")) body.push(lines[++i].slice(2));
      out[m[1]] = body.join("\n").trim();
    } else {
      out[m[1]] = m[2].replace(/^'(.*)'$/, "$1").replace(/''/g, "'").replace(/\\\\/g, "\\");
    }
  }
  return out;
}

/** pytest --junitxml (and any JUnit XML). */
export function parseJunit(xml: string, dir: string): Counts {
  const failures: TestFailure[] = [];
  let passed = 0;
  let skipped = 0;
  const cases = xml.match(/<testcase\b[\s\S]*?(?:\/>|<\/testcase>)/g) ?? [];
  for (const c of cases) {
    const attr = (name: string) => decode(new RegExp(`\\b${name}="([^"]*)"`).exec(c)?.[1] ?? "");
    const fail = /<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>|<(failure|error)\b([^>]*)\/>/.exec(c);
    if (/<skipped\b/.test(c)) {
      skipped++;
      continue;
    }
    if (!fail) {
      passed++;
      continue;
    }
    const body = decode(fail[3] ?? "");
    const message = decode(/message="([^"]*)"/.exec(fail[2] ?? fail[5] ?? "")?.[1] ?? "") || body.split("\n").find((l) => /^E\s/.test(l))?.replace(/^E\s+/, "") || "failed";
    const where = [...body.matchAll(/^([^\s:][^:\n]*\.py):(\d+):/gm)].pop();
    failures.push({
      name: [attr("classname"), attr("name")].filter(Boolean).join("::"),
      file: where ? relative(dir, where[1]) : attr("file") || undefined,
      line: where ? Number(where[2]) : attr("line") ? Number(attr("line")) : undefined,
      message: clean(message),
      stack: body.split("\n").filter((l) => /^E\s/.test(l)).slice(0, 6),
    });
  }
  return { passed, failed: failures.length, skipped, failures };
}

/** go test -json: one JSON event per line. */
export function parseGoJson(text: string, dir: string): Counts {
  const output = new Map<string, string[]>();
  const failures: TestFailure[] = [];
  let passed = 0;
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    let e: { Action: string; Package?: string; Test?: string; Output?: string };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e.Test) continue;
    const key = `${e.Package}/${e.Test}`;
    if (e.Action === "output" && e.Output) output.set(key, [...(output.get(key) ?? []), e.Output.replace(/\n$/, "")]);
    if (e.Action === "pass") passed++;
    if (e.Action === "skip") skipped++;
    if (e.Action === "fail") {
      const out = output.get(key) ?? [];
      const at = out.map((l) => /^\s+([\w./-]+_test\.go):(\d+): (.*)$/.exec(l)).find(Boolean);
      failures.push({
        name: e.Test,
        file: at?.[1],
        line: at ? Number(at[2]) : undefined,
        message: at ? at[3] : out.filter((l) => !/^(=== RUN|--- FAIL)/.test(l.trim())).join("\n").trim() || "failed",
        stack: out.filter((l) => !/^(=== RUN|--- FAIL)/.test(l.trim())).slice(0, 6),
      });
    }
  }
  // A parent test fails when a subtest does; keep the most specific ones.
  const names = failures.map((f) => f.name);
  const leaf = failures.filter((f) => !names.some((n) => n.startsWith(`${f.name}/`)));
  return { passed, failed: leaf.length, skipped, failures: leaf };
}

/** "expected X, received Y" pulled out of a message, with the rest as the message. */
function splitMessage(msg: string, dir: string): Pick<TestFailure, "message" | "expected" | "actual" | "stack"> {
  const lines = msg.split("\n");
  const stackStart = lines.findIndex((l) => /^\s+at /.test(l));
  const body = (stackStart >= 0 ? lines.slice(0, stackStart) : lines).join("\n").trim();
  const stack = stackStart >= 0 ? lines.slice(stackStart).filter((l) => !/node_modules|node:internal|<anonymous>/.test(l)).slice(0, 4).map((l) => shorten(l.trim(), dir)) : undefined;
  // Jest prints "Expected: 6 / Received: 5"; vitest's chai says "expected 5 to be 6".
  const chai = /expected (.+?) to (?:be|equal|deeply equal|strictly equal|have length|include) (.+?)(?: \/\/.*)?$/m.exec(body);
  const expected = /^\s*(?:Expected|expected)(?: value)?:\s+(.+)$/m.exec(body)?.[1] ?? chai?.[2];
  const actual = /^\s*(?:Received|received|Actual|actual)(?: value)?:\s+(.+)$/m.exec(body)?.[1] ?? chai?.[1];
  return { message: body.split("\n").slice(0, 12).join("\n"), expected, actual, stack };
}

function lineIn(msg: string, file: string): number | undefined {
  const base = path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`${base}:(\\d+):\\d+`).exec(msg);
  return m ? Number(m[1]) : undefined;
}

function shorten(line: string, dir: string): string {
  return line.split(dir + path.sep).join("").split(dir.replace(/\\/g, "/") + "/").join("").replace(/file:\/\/\/?/g, "");
}

function relative(dir: string, file: string): string {
  let f = file;
  if (f.startsWith("file:")) {
    try {
      f = fileURLToPath(f);
    } catch {
      // not a valid file URL: keep it as written
    }
  }
  const abs = path.isAbsolute(f) ? f : path.join(dir, f);
  // A test runner reports the real path; the project's folder can be reached through a link
  // (on macOS the temp folder /var is /private/var), so compare the real paths too.
  for (const [from, to] of [[dir, abs], [realpath(dir), realpath(abs)]]) {
    const rel = path.relative(from, to);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
  }
  return f;
}

function realpath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
function clean(s: string): string {
  return s.replace(ANSI, "").trim();
}

function decode(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#10;/g, "\n").replace(/&amp;/g, "&");
}

function quote(s: string): string {
  // cmd.exe doesn't honour a backslash before a quote, so on Windows a value that could end the quoted text or start another command is refused.
  if (process.platform === "win32" && /["%&|<>^`\r\n]/.test(s)) throw new Error(`A test name or file can't hold any of \" % & | < > ^ on Windows: ${s.slice(0, 40)}`);
  return process.platform === "win32" ? `"${s.replace(/"/g, '\\"')}"` : `'${s.replace(/'/g, "'\\''")}'`;
}

function tail(text: string, n: number): string[] {
  return clean(text).split(/\r?\n/).filter((l) => l.trim()).slice(-n);
}

function read(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function pythonCommand(): Promise<string | undefined> {
  for (const p of ["python3", "python"]) {
    const ok = await run(`${p} --version`, os.tmpdir(), process.env, 10_000);
    if (ok.ok) return p;
  }
  return undefined;
}

function run(command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ ok: boolean; output: string; stdout: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    // The command is built above from the project's own test setup and fixed flags; a name
    // pattern or file list is quoted.
    const child = spawn(command, { cwd, env, shell: true, windowsHide: true });
    let output = "";
    let stdout = "";
    let timedOut = false;
    const cap = (s: string, add: string) => (s.length > 4_000_000 ? s : s + add);
    child.stdout.on("data", (d: Buffer) => {
      stdout = cap(stdout, d.toString("utf8"));
      output = cap(output, d.toString("utf8"));
    });
    child.stderr.on("data", (d: Buffer) => (output = cap(output, d.toString("utf8"))));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: err.message, stdout, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output, stdout, timedOut });
    });
  });
}
