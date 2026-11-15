import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-devport-test-"));
const { planMove, toolOf } = await import("../index.js");

function app(scripts: Record<string, string>, devCommand = "npm run dev") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-devport-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "todo-app", scripts }));
  return { name: "todo-app", dir, devCommand } as Parameters<typeof planMove>[0];
}

test("a port the script writes itself is replaced in its text, so the app can still be answered at its usual address", () => {
  const next = app({ dev: "next dev --turbopack -p 3208" });
  const plan = planMove(next, 51000);
  assert.equal(plan.moved?.command, "next dev --turbopack -p 51000", "the script runs by itself with the new port, once");
  assert.equal(plan.moved?.env.PORT, "51000");
  const pathKey = Object.keys(plan.moved?.env ?? {}).find((k) => k.toLowerCase() === "path");
  assert.ok(pathKey && plan.moved?.env[pathKey].startsWith(path.join(next.dir, "node_modules", ".bin")), "node_modules/.bin first on PATH, as npm run does");

  assert.equal(planMove(app({ dev: "vite --host 127.0.0.1 --port=3198" }), 51000).moved?.command, "vite --host 127.0.0.1 --port=51000");
  assert.equal(planMove(app({ dev: "PORT=3016 react-scripts start" }), 51000).moved?.command, "PORT=51000 react-scripts start");
});

test("a script run as node node_modules/<tool>/…, and one-shot steps before the server, are understood", () => {
  assert.equal(toolOf("node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 3198"), "vite");
  assert.equal(toolOf("node node_modules/next/dist/bin/next dev --webpack"), "next");
  assert.equal(toolOf("node --inspect ./node_modules/.bin/vite"), "vite");
  assert.equal(toolOf("node server.mjs"), undefined);
  assert.equal(toolOf("node node_modules/next/dist/bin/next start"), undefined, "next start isn't a dev server");

  assert.equal(planMove(app({ dev: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 3198" }), 51000).moved?.command, "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 51000");
  // Without a port of its own, flags are added after the whole script, which reach its last command.
  assert.equal(planMove(app({ dev: "prisma generate && next dev" }), 51000).moved?.command, "npm run dev -- -p 51000");
  // With one, only the last command's port changes.
  assert.equal(planMove(app({ dev: "prisma generate && next dev -p 3001" }), 51000).moved?.command, "prisma generate && next dev -p 51000");
});

test("when it can't be moved, the reason is said in words", () => {
  const why = (a: Parameters<typeof planMove>[0]) => planMove(a, 51000).reason;
  assert.match(why({ name: "x", dir: "/nowhere", devCommand: undefined } as never) ?? "", /no dev command/);
  assert.match(why(app({}, "python server.py")) ?? "", /custom command/);
  assert.match(why(app({ dev: "concurrently \"vite\" \"node api.js\"" })) ?? "", /several servers at once/);
  assert.match(why(app({ dev: "npm run build:packages && concurrently -k \"a\" \"b\"" })) ?? "", /several servers at once/);
  assert.match(why(app({ dev: "vite & node api.js" })) ?? "", /side by side/);
  assert.match(why(app({ dev: "node --watch server.mjs" })) ?? "", /"node" isn't a dev server dx knows how to give a port/);
  assert.match(why(app({ other: "vite" })) ?? "", /no "dev" script/);
  // A pre-script is run first, by name, since the rewritten script doesn't go through `npm run`.
  assert.equal(planMove(app({ dev: "next dev -p 3001", predev: "echo hi" }), 51000).moved?.command, "npm run predev && next dev -p 51000");
  // The ones that can be moved have no reason.
  assert.equal(why(app({ dev: "vite" })), undefined);
});
