import assert from "node:assert/strict";
import { test } from "node:test";
import { ErrorTracker, findLocation, isSuccessLine, matchErrorStart } from "../tools/devErrors.js";

function track(output: string, stream: "out" | "err" = "out") {
  const t = new ErrorTracker();
  output.split("\n").forEach((text, i) => t.push({ n: i + 1, stream, text }));
  t.flush();
  return t;
}

test("TypeScript errors, both formats, with file, line and column", () => {
  const t = track(
    [
      "src/cart.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/api/client.ts:3:10 - error TS2307: Cannot find module './config' or its corresponding type declarations.",
      "",
      "3 import { config } from './config';",
      "           ~~~~~~~~~~~~~~~~~~~",
      "Found 2 errors. Watching for file changes.",
    ].join("\n"),
  );
  const [second, first] = t.errors();
  assert.equal(first.kind, "typescript");
  assert.equal(first.file, "src/cart.ts");
  assert.equal(first.line, 12);
  assert.equal(first.column, 5);
  assert.ok(first.message.startsWith("TS2322: Type 'string'"));
  assert.equal(second.file, "src/api/client.ts");
  assert.equal(second.line, 3);
});

test("Vite: an internal server error with its file and code frame", () => {
  const t = track(
    [
      "10:42:07 [vite] Internal server error: Failed to resolve import \"./CartButtn\" from \"src/App.tsx\". Does the file exist?",
      "  Plugin: vite:import-analysis",
      "  File: C:/work/shop/src/App.tsx:3:23",
      "  1  |  import { useState } from \"react\";",
      "  3  |  import CartButton from \"./CartButtn\";",
      "     |                          ^",
      "      at formatError (file:///C:/work/shop/node_modules/vite/dist/node/chunks/dep.js:1:1)",
    ].join("\n"),
  );
  const [e] = t.errors();
  assert.equal(e.kind, "build");
  assert.ok(e.message.startsWith("Failed to resolve import"));
  assert.equal(e.file, "C:/work/shop/src/App.tsx");
  assert.equal(e.line, 3);
  assert.equal(e.column, 23);
  assert.ok(e.lines.length >= 5, "the code frame stays with the error");
});

test("esbuild: the location comes on the line after the message", () => {
  const t = track(['✘ [ERROR] Could not resolve "lodash-es"', "", "    src/utils.ts:1:18:", '      1 │ import { debounce } from "lodash-es";'].join("\n"));
  const [e] = t.errors();
  assert.equal(e.message, 'Could not resolve "lodash-es"');
  assert.equal(e.kind, "build");
  assert.equal(e.file, "src/utils.ts");
  assert.equal(e.line, 1);
  assert.equal(e.column, 18);
});

test("Next.js: the file on one line, the message on the next", () => {
  const t = track([" ⨯ ./src/app/page.tsx:4:1", "Module not found: Can't resolve '@/components/Hero'", "", "https://nextjs.org/docs/messages/module-not-found"].join("\n"));
  const errors = t.errors();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, "./src/app/page.tsx");
  assert.equal(errors[0].line, 4);
  assert.match(errors[0].message, /Can't resolve '@\/components\/Hero'/);
});

test("webpack: Failed to compile", () => {
  const [e] = track(["Failed to compile.", "", "./src/index.js", "Module not found: Error: Can't resolve './Ap'"].join("\n")).errors({ all: true }).reverse();
  assert.equal(e.message, "Failed to compile");
});

test("Node stack trace: the first frame outside node_modules wins", () => {
  const t = track(
    [
      "TypeError: Cannot read properties of undefined (reading 'price')",
      "    at total (/home/dev/shop/node_modules/lodash/sum.js:10:3)",
      "    at checkout (/home/dev/shop/src/routes/checkout.js:42:17)",
      "    at node:internal/process/task_queues:95:5",
      "Server listening on 3000",
    ].join("\n"),
    "err",
  );
  const [e] = t.errors();
  assert.equal(e.kind, "runtime");
  assert.equal(e.message, "TypeError: Cannot read properties of undefined (reading 'price')");
  assert.equal(e.file, "/home/dev/shop/src/routes/checkout.js");
  assert.equal(e.line, 42);
  assert.equal(e.lines.length, 4, "the next normal line ends the error");
});

test("Node SyntaxError: the file:line printed above the error, and echoed source that mentions errors isn't one", () => {
  const t = track(
    [
      "C:\\work\\shop\\dev.cjs:2",
      '  if (q.url === "/x") console.error("[vite] Internal server error: oops")',
      "                                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^",
      "",
      "SyntaxError: Invalid or unexpected token",
      "    at wrapSafe (node:internal/modules/cjs/loader:1861:18)",
      "    at Module._compile (node:internal/modules/cjs/loader:1903:20)",
      "",
      "Node.js v24.20.0",
    ].join("\n"),
    "err",
  );
  const errors = t.errors();
  assert.equal(errors.length, 1, JSON.stringify(errors.map((e) => e.message)));
  assert.equal(errors[0].message, "SyntaxError: Invalid or unexpected token");
  assert.equal(errors[0].file, "C:\\work\\shop\\dev.cjs");
  assert.equal(errors[0].line, 2);
});

test("Python traceback: the exception line is the message, the user's innermost frame the location", () => {
  const t = track(
    [
      "Traceback (most recent call last):",
      '  File "/srv/api/app.py", line 18, in index',
      "    return total(items)",
      '  File "/srv/api/cart.py", line 7, in total',
      "    return sum(i.price for i in items) / count",
      "ZeroDivisionError: division by zero",
      "INFO:     127.0.0.1:52144 - \"GET / HTTP/1.1\" 500",
    ].join("\n"),
  );
  const [e] = t.errors();
  assert.equal(e.kind, "python");
  assert.equal(e.message, "ZeroDivisionError: division by zero");
  assert.equal(e.file, "/srv/api/cart.py");
  assert.equal(e.line, 7);
});

test("Go: compiler errors and panics", () => {
  const t = track(["./main.go:12:2: undefined: handler", "panic: runtime error: index out of range [3] with length 3", "", "goroutine 1 [running]:"].join("\n"));
  const errors = t.errors();
  assert.equal(errors.length, 2);
  const compile = errors.find((e) => e.file === "./main.go");
  assert.equal(compile?.line, 12);
  assert.ok(errors.some((e) => e.message.startsWith("panic: runtime error")));
});

test("repeats are counted, and a clean rebuild resolves them", () => {
  const t = new ErrorTracker();
  let n = 0;
  const push = (text: string) => t.push({ n: ++n, stream: "out", text });
  push("[vite] Internal server error: Unexpected token (5:3)");
  push("  File: /app/src/App.tsx:5:3");
  push("[vite] Internal server error: Unexpected token (5:3)");
  push("  File: /app/src/App.tsx:5:3");
  t.flush();
  assert.equal(t.errors().length, 1);
  assert.equal(t.errors()[0].count, 2);
  push("10:44:02 [vite] hmr update /src/App.tsx");
  assert.equal(t.errors().length, 0, "resolved after a clean update");
  assert.equal(t.errors({ all: true })[0].resolved, true);
  push("[vite] Internal server error: Unexpected token (5:3)");
  push("  File: /app/src/App.tsx:5:3");
  t.flush();
  assert.equal(t.errors()[0].count, 3, "comes back when it happens again");
});

test("the dev server exiting with an error code is an error; dx's own lines are not", () => {
  const t = new ErrorTracker();
  t.push({ n: 1, stream: "dx", text: "$ npm run dev" });
  t.push({ n: 2, stream: "dx", text: "Exited with 1." });
  t.push({ n: 3, stream: "dx", text: "Exited with 0." });
  const errors = t.errors();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, "exit");
});

test("ordinary lines are not errors", () => {
  for (const line of [
    "  VITE v6.0.3  ready in 412 ms",
    "Found 0 errors. Watching for file changes.",
    "GET /api/errors 200 in 12ms",
    "compiled src/error-boundary.tsx",
    "  ➜  Local:   http://localhost:5173/",
    "errorHandler registered",
  ]) {
    assert.equal(matchErrorStart(line), undefined, line);
  }
  assert.ok(isSuccessLine("  VITE v6.0.3  ready in 412 ms"));
  assert.ok(isSuccessLine(" ✓ Compiled /checkout in 812ms"));
  assert.ok(!isSuccessLine("Compiled with 2 errors"));
});

test("findLocation skips node internals and dependency bundles", () => {
  assert.deepEqual(findLocation(["    at node:internal/modules/run_main:1:1", "    at file:///C:/app/src/main.ts:9:4"]), { file: "C:/app/src/main.ts", line: 9, column: 4 });
  assert.equal(findLocation(["    at /app/node_modules/.vite/deps/react.js:1:1"]), undefined);
});
