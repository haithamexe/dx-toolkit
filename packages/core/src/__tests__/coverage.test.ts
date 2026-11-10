import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// Coverage from each framework's own report (parsed from made-up files), and a real node:test run
// measured through V8's coverage. The node run is skipped where node can't write coverage files.
process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-coverage-home-"));
const { parseCoverageSummary, parsePytestCoverage, parseGoCover, parseV8Coverage, runTests } = await import("../index.js");

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test("vitest and jest: the istanbul summary, the least covered files first, and 'Unknown' left out", () => {
  const dir = path.resolve("/work/shop");
  const file = (n: string) => path.join(dir, "src", n);
  const k = parseCoverageSummary(
    JSON.stringify({
      total: { lines: { pct: 81.25 }, statements: { pct: 80 }, functions: { pct: 70.5 }, branches: { pct: 60 } },
      [file("cart.ts")]: { lines: { pct: 100 } },
      [file("tax.ts")]: { lines: { pct: 40 } },
      [file("empty.ts")]: { lines: { pct: "Unknown" } },
    }),
    dir,
  )!;
  assert.deepEqual([k.lines, k.statements, k.functions, k.branches, k.fileCount], [81.3, 80, 70.5, 60, 2]);
  assert.deepEqual(k.files, [{ file: "src/tax.ts", lines: 40 }, { file: "src/cart.ts", lines: 100 }]);
  assert.equal(parseCoverageSummary(JSON.stringify({ total: { lines: { pct: "Unknown" } } }), dir), undefined);
});

test("pytest-cov's JSON and go's cover profile", () => {
  const p = parsePytestCoverage(JSON.stringify({ totals: { percent_covered: 87.456 }, files: { "app/a.py": { summary: { percent_covered: 100 } }, "app/b.py": { summary: { percent_covered: 62.5 } } } }), "/work/api")!;
  assert.deepEqual([p.lines, p.files.map((f) => f.file)], [87.5, ["app/b.py", "app/a.py"]]);
  const g = parseGoCover(["mode: set", "example.com/shop/cart.go:10.2,12.3 2 1", "example.com/shop/cart.go:14.2,16.3 2 0", "example.com/shop/tax.go:5.1,6.2 4 1", ""].join("\n"))!;
  assert.deepEqual([g.lines, g.statements, g.fileCount], [75, 75, 2]);
  assert.deepEqual(g.files, [{ file: "example.com/shop/cart.go", lines: 50 }, { file: "example.com/shop/tax.go", lines: 100 }]);
  assert.equal(parseGoCover("mode: set\n"), undefined);
});

test("V8's raw coverage becomes line coverage of the project's own files, leaving out tests and node_modules", () => {
  const dir = tmp("dx-cov-v8-proj-");
  const src = "export function add(a, b) {\n  return a + b;\n}\nexport function unused() {\n  return 1;\n}\n";
  const lib = path.join(dir, "src", "lib.mjs");
  fs.mkdirSync(path.dirname(lib), { recursive: true });
  fs.writeFileSync(lib, src);
  fs.writeFileSync(path.join(dir, "lib.test.mjs"), "test('x')\n");
  const start = src.indexOf("export function unused");
  const folder = tmp("dx-cov-v8-out-");
  const script = (file: string, ranges: [number, number, number][]) => ({ scriptId: "1", url: pathToFileURL(file).href, functions: [{ functionName: "", ranges: ranges.map(([startOffset, endOffset, count]) => ({ startOffset, endOffset, count })) }] });
  fs.writeFileSync(
    path.join(folder, "coverage-1.json"),
    JSON.stringify({
      result: [
        script(lib, [[0, src.length, 1], [start, src.length, 0]]),
        script(path.join(dir, "lib.test.mjs"), [[0, 10, 1]]),
        script(path.join(dir, "node_modules", "dep", "index.js"), [[0, 10, 1]]),
        { scriptId: "2", url: "node:internal/x", functions: [] },
      ],
    }),
  );
  const k = parseV8Coverage(folder, dir)!;
  assert.deepEqual(k.files, [{ file: "src/lib.mjs", lines: 50 }]);
  assert.equal(k.lines, 50, "add's two code lines ran, unused's two didn't (lone braces and blank lines aren't counted)");
  assert.equal(parseV8Coverage(tmp("dx-cov-none-"), dir), undefined);
});

test("a node:test project measured for real: what its tests run, and the file they don't", async () => {
  const dir = tmp("dx-cov-run-");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "todo-app", type: "module", scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(dir, "src", "lib.mjs"), "export function add(a, b) {\n  return a + b;\n}\nexport function unused() {\n  const x = 1;\n  return x + 1;\n}\n");
  fs.writeFileSync(path.join(dir, "src", "never.mjs"), "export const a = 1;\nexport const b = 2;\n");
  fs.writeFileSync(path.join(dir, "lib.test.mjs"), 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./src/lib.mjs";\ntest("add", () => assert.equal(add(1, 2), 3));\n');
  const r = await runTests({ name: "todo-app", dir, packageManager: "npm" }, { coverage: true, source: "test" });
  assert.equal(r.ok, true, JSON.stringify(r.outputTail));
  assert.ok(r.coverage, r.coverageNote);
  const lib = r.coverage!.files.find((f) => f.file === "src/lib.mjs");
  assert.ok(lib && lib.lines > 0 && lib.lines < 100, JSON.stringify(r.coverage));
  assert.ok(!r.coverage!.files.some((f) => /test/.test(f.file)), "the test file isn't counted");
  assert.equal(r.coverageNote, undefined);
  // Without asking, there's no coverage and no note.
  const plain = await runTests({ name: "todo-app", dir, packageManager: "npm" }, { source: "test" });
  assert.equal(plain.coverage, undefined);
  assert.equal(plain.coverageNote, undefined);
});

test("asking for coverage where a provider is missing says what to install, and the tests still run; a custom script says dx can't measure it", async () => {
  const vitest = tmp("dx-cov-vitest-");
  fs.writeFileSync(path.join(vitest, "package.json"), JSON.stringify({ name: "shop", devDependencies: { vitest: "^3" }, scripts: { test: "vitest" } }));
  const v = await runTests({ name: "shop", dir: vitest, packageManager: "npm" }, { coverage: true, source: "test", timeoutMs: 20_000 });
  assert.match(v.coverageNote ?? "", /npm install -D @vitest\/coverage-v8/);
  assert.equal(v.coverage, undefined);
  const custom = tmp("dx-cov-script-");
  fs.writeFileSync(path.join(custom, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node -e \"console.log('ok')\"" } }));
  const c = await runTests({ name: "x", dir: custom, packageManager: "npm" }, { coverage: true, source: "test" });
  assert.equal(c.ok, true);
  assert.match(c.coverageNote ?? "", /own test script/);
});
