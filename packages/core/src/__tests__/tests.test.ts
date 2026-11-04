import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-tests-test-"));
const { detectTestFramework, parseGoJson, parseJestJson, parseJunit, runTests } = await import("../tools/tests.js");

function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-tests-proj-"));
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  return dir;
}

test("detects the framework from dependencies and the test script", () => {
  assert.equal(detectTestFramework(project({ "package.json": JSON.stringify({ devDependencies: { vitest: "^3" }, scripts: { test: "vitest" } }) }))?.framework, "vitest");
  assert.equal(detectTestFramework(project({ "package.json": JSON.stringify({ devDependencies: { jest: "^30" } }) }))?.framework, "jest");
  assert.equal(detectTestFramework(project({ "package.json": JSON.stringify({ scripts: { test: "node --test tests/" } }) }))?.framework, "node");
  assert.equal(detectTestFramework(project({ "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) })), undefined);
  assert.equal(detectTestFramework(project({ "go.mod": "module example.com/shop\n" }))?.framework, "go");
  assert.equal(detectTestFramework(project({ "conftest.py": "" }))?.framework, "pytest");
});

test("runs node:test and reads each failure with file, line, expected and actual", async () => {
  const dir = project({
    "package.json": JSON.stringify({ name: "todo-app", scripts: { test: "node --test" } }),
    "cart.test.mjs": [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'test("adds up the cart", () => { assert.equal(1 + 1, 3); });',
      'test("empty cart is zero", () => {});',
      'test("later", { skip: true }, () => {});',
    ].join("\n"),
  });
  const r = await runTests({ name: "todo-app", dir, packageManager: "npm" }, { source: "test" });
  assert.equal(r.framework, "node");
  assert.equal(r.ok, false);
  assert.equal(r.passed, 1);
  assert.equal(r.failed, 1);
  assert.equal(r.skipped, 1);
  const f = r.failures[0];
  assert.equal(f.name, "adds up the cart");
  assert.equal(f.file, "cart.test.mjs");
  assert.equal(f.line, 3);
  assert.equal(f.expected, "3");
  assert.equal(f.actual, "2");
  assert.ok(r.outputTail.some((l) => l.includes("adds up the cart")), "the usual output is kept too");

  const only = await runTests({ name: "todo-app", dir, packageManager: "npm" }, { match: "empty cart", source: "test" });
  assert.equal(only.ok, true, JSON.stringify(only));
  assert.equal(only.failed, 0);
});

test("reads vitest and jest JSON", () => {
  const dir = "/work/shop-website";
  const r = parseJestJson(
    JSON.stringify({
      numPassedTests: 4,
      numFailedTests: 1,
      numPendingTests: 1,
      testResults: [
        {
          name: "/work/shop-website/src/cart.test.ts",
          status: "failed",
          assertionResults: [
            { title: "totals", fullName: "cart totals", status: "failed", location: { line: 12, column: 5 }, failureMessages: ["AssertionError: expected 5 to be 6\n\nExpected: 6\nReceived: 5\n    at /work/shop-website/src/cart.test.ts:12:20\n    at node_modules/vitest/dist/x.js:1:1"] },
            { title: "empty", status: "passed" },
          ],
        },
        { name: "/work/shop-website/src/broken.test.ts", status: "failed", message: "SyntaxError: Unexpected token (3:9)", assertionResults: [] },
      ],
    }),
    dir,
  );
  assert.equal(r.passed, 4);
  assert.equal(r.failed, 2);
  assert.equal(r.skipped, 1);
  assert.deepEqual(
    { name: r.failures[0].name, file: r.failures[0].file, line: r.failures[0].line, expected: r.failures[0].expected, actual: r.failures[0].actual },
    { name: "cart totals", file: "src/cart.test.ts", line: 12, expected: "6", actual: "5" },
  );
  assert.ok(!r.failures[0].stack?.some((l) => l.includes("node_modules")), "library frames are left out");
  assert.equal(r.failures[1].name, "src/broken.test.ts (didn't run)");
});

test("reads pytest's JUnit XML", () => {
  const xml = `<?xml version="1.0"?><testsuites><testsuite name="pytest" tests="3">
<testcase classname="tests.test_cart" name="test_total" file="tests/test_cart.py" line="4"><failure message="assert 5 == 6">def test_total():
&gt;       assert total() == 6
E       assert 5 == 6
E        +  where 5 = total()

tests/test_cart.py:6: AssertionError</failure></testcase>
<testcase classname="tests.test_cart" name="test_empty"/>
<testcase classname="tests.test_cart" name="test_later"><skipped message="later"/></testcase>
</testsuite></testsuites>`;
  const r = parseJunit(xml, "/work/api");
  assert.equal(r.passed, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.failed, 1);
  assert.deepEqual({ name: r.failures[0].name, file: r.failures[0].file, line: r.failures[0].line, message: r.failures[0].message }, { name: "tests.test_cart::test_total", file: "tests/test_cart.py", line: 6, message: "assert 5 == 6" });
});

test("reads go test -json, keeping the failing subtest rather than its parent", () => {
  const ev = (o: object) => JSON.stringify(o);
  const out = [
    ev({ Action: "run", Package: "example.com/shop", Test: "TestCart" }),
    ev({ Action: "run", Package: "example.com/shop", Test: "TestCart/total" }),
    ev({ Action: "output", Package: "example.com/shop", Test: "TestCart/total", Output: "    cart_test.go:14: got 5, want 6\n" }),
    ev({ Action: "fail", Package: "example.com/shop", Test: "TestCart/total" }),
    ev({ Action: "fail", Package: "example.com/shop", Test: "TestCart" }),
    ev({ Action: "pass", Package: "example.com/shop", Test: "TestEmpty" }),
  ].join("\n");
  const r = parseGoJson(out, "/work/shop");
  assert.equal(r.passed, 1);
  assert.equal(r.failed, 1);
  assert.deepEqual({ name: r.failures[0].name, file: r.failures[0].file, line: r.failures[0].line, message: r.failures[0].message }, { name: "TestCart/total", file: "cart_test.go", line: 14, message: "got 5, want 6" });
});
