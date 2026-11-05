import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Trying an upgrade: the target checked and found on a stand-in registry, the install command per
// package manager, the project's checks, error lines, the verdict, and the throwaway copy of the
// working copy. Temp folders only; nothing is installed.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-upgrade-home-"));
process.env.DX_HOME = home;
const { resolveUpgrade, upgradeCommand, projectChecks, errorLines, summarizeUpgrade, upgradeChoices, UpgradeError } = await import("../tools/upgrade.js");
const { createWorkingCopy, removeSnapshot, listSnapshots, unlinkPackages, snapshotsRoot } = await import("../tools/snapshots.js");

const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dx-upgrade-")), "shop-website");
fs.mkdirSync(dir);
after(() => {
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
write("package.json", JSON.stringify({ name: "shop-website", scripts: { dev: "vite", build: "vite build", typecheck: "tsc --noEmit", test: "vitest run" }, dependencies: { react: "^18.3.1", "@tanstack/react-query": "^5.0.0", local: "file:../local" }, devDependencies: { vite: "^5.4.0", typescript: "^5.4.0" } }, null, 2));
write("node_modules/react/package.json", JSON.stringify({ name: "react", version: "18.3.1" }));
write("node_modules/vite/package.json", JSON.stringify({ name: "vite", version: "5.4.2" }));
write("src/App.tsx", "export const App = () => 'shop';\n");

const registry = (doc: unknown, status = 200): typeof fetch => (async () => new Response(JSON.stringify(doc), { status })) as unknown as typeof fetch;
const reactDoc = { "dist-tags": { latest: "19.1.0", next: "19.2.0-canary-1" }, versions: { "18.3.1": {}, "19.0.0": {}, "19.1.0": {}, "19.2.0-canary-1": {}, "20.0.0-rc.1": {} } };

test("the packages to choose from are the project's own, with what's installed", () => {
  const c = upgradeChoices(dir);
  assert.deepEqual(c.map((x) => [x.name, x.installed ?? null, x.dev]), [["@tanstack/react-query", null, false], ["react", "18.3.1", false], ["typescript", null, true], ["vite", "5.4.2", true]]);
});

test("the version is found on the registry: a tag, a major, or an exact one", async () => {
  assert.deepEqual(await resolveUpgrade(dir, "react", "latest", registry(reactDoc)), { name: "react", from: "18.3.1", to: "19.1.0", dev: false, major: true });
  assert.equal((await resolveUpgrade(dir, "react", "19", registry(reactDoc))).to, "19.1.0");
  assert.equal((await resolveUpgrade(dir, "react", "next", registry(reactDoc))).to, "19.2.0-canary-1");
  assert.equal((await resolveUpgrade(dir, "react", "19.0.0", registry({}))).to, "19.0.0");
  assert.equal((await resolveUpgrade(dir, "vite", "6", registry({ versions: { "6.0.1": {}, "6.3.0": {} } }))).dev, true);
});

test("anything else is refused before it reaches a command line", async () => {
  const rejects = async (name: string, version: string, why: RegExp, fetchImpl = registry(reactDoc)) => {
    await assert.rejects(resolveUpgrade(dir, name, version, fetchImpl), (e: Error) => e instanceof UpgradeError && why.test(e.message));
  };
  await rejects("react", "^19 && calc", /version/);
  await rejects("react", "19|x", /version/);
  await rejects("left-pad", "latest", /isn't one of the project's dependencies/);
  await rejects("../react", "latest", /package name/);
  await rejects("local", "latest", /isn't one of/);
  await rejects("react", "18.3.1", /already installed/, registry({}));
  await rejects("react", "21", /No react version/);
  await rejects("react", "19.9.9", /isn't on the npm registry/, registry({}, 404));
});

test("each package manager gets its own add command, dev dependencies as dev", () => {
  const t = { name: "react", to: "19.1.0", dev: false };
  assert.deepEqual(upgradeCommand(dir, t, "npm").args, ["install", "react@19.1.0"]);
  assert.deepEqual(upgradeCommand(dir, { ...t, dev: true }, "npm").args, ["install", "react@19.1.0", "--save-dev"]);
  assert.deepEqual(upgradeCommand(dir, { ...t, dev: true }, "pnpm").args, ["add", "react@19.1.0", "-D"]);
  assert.deepEqual(upgradeCommand(dir, t, "yarn").args, ["add", "react@19.1.0"]);
  assert.deepEqual(upgradeCommand(dir, { ...t, dev: true }, "bun").args, ["add", "react@19.1.0", "--dev"]);
  assert.throws(() => upgradeCommand(dir, { ...t, to: "1;rm -rf" }, "npm"));
});

test("the project's checks are its own type check and build scripts", () => {
  assert.deepEqual(projectChecks(dir, "npm").map((c) => [c.name, c.command, c.args.join(" ")]), [["types", "npm", "run typecheck"], ["build", "npm", "run build"]]);
  assert.deepEqual(projectChecks(dir, "yarn").map((c) => c.args.join(" ")), ["typecheck", "build"]);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "dx-upgrade-ts-"));
  fs.writeFileSync(path.join(bare, "package.json"), JSON.stringify({ devDependencies: { typescript: "^5" } }));
  fs.writeFileSync(path.join(bare, "tsconfig.json"), "{}");
  assert.deepEqual(projectChecks(bare, "npm").map((c) => [c.name, c.command, c.args.join(" ")]), [["types", "npx", "--no-install tsc --noEmit"]]);
  fs.rmSync(bare, { recursive: true, force: true });
});

test("error lines are kept, with the copy's folder taken off", () => {
  const copy = path.join(os.tmpdir(), "copy");
  const out = [`${path.join(copy, "src", "App.tsx")}(3,7): error TS2322: Type 'string' is not assignable to type 'number'.`, "npm error code 2", "npm error path x", "> vite build", "✖ Build failed", "src/App.tsx(3,7): error TS2322: Type 'string' is not assignable to type 'number'."].join("\n");
  assert.deepEqual(errorLines(out, copy), [`src${path.sep}App.tsx(3,7): error TS2322: Type 'string' is not assignable to type 'number'.`, "✖ Build failed", "src/App.tsx(3,7): error TS2322: Type 'string' is not assignable to type 'number'."].filter((v, i, a) => a.indexOf(v) === i));
});

test("the verdict: breaks before changes before the same", () => {
  const target = { name: "react", from: "18.3.1", to: "19.1.0", dev: false, major: true };
  const ok = (name: "types" | "build" | "tests", extra = {}) => ({ name, label: name, command: "x", ok: true, ms: 1, errors: [], ...extra });
  const same = summarizeUpgrade({ target, checks: [{ name: "types", before: ok("types"), after: ok("types") }], pages: [{ path: "/", changed: false, behaviour: { path: "/", changes: [], before: { calls: [], errors: 0, ok: true }, after: { calls: [], errors: 0, ok: true }, same: true } }] });
  assert.equal(same.verdict, "same");
  const looks = summarizeUpgrade({ target, checks: [], pages: [{ path: "/cart", changed: true, label: "the Checkout button" }] });
  assert.equal(looks.verdict, "changes");
  assert.deepEqual(looks.summary, ["1 page looks different: /cart (the Checkout button)"]);
  const broken = summarizeUpgrade({
    target,
    checks: [
      { name: "types", before: ok("types"), after: { ...ok("types"), ok: false, errors: ["src/App.tsx(3,7): error TS2322"] } },
      { name: "tests", before: ok("tests", { passed: 12, failed: 0 }), after: { ...ok("tests", { passed: 10, failed: 2 }), ok: false } },
    ],
    pages: [{ path: "/cart", changed: true }],
  });
  assert.equal(broken.verdict, "breaks");
  assert.deepEqual(broken.summary.slice(0, 2), ["The type check fails: src/App.tsx(3,7): error TS2322", "2 more tests fail (10 passed, 2 failed; was 0 failed)"]);
  const install = summarizeUpgrade({ target, checks: [], pages: [], install: { ok: false, tail: ["npm error ERESOLVE could not resolve"] } });
  assert.equal(install.verdict, "breaks");
  assert.match(install.summary[0], /didn't install: npm error ERESOLVE/);
});

test("the copy is the working copy as it is, in its own folder; the project isn't touched", async () => {
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=octocat", "-c", "user.email=octocat@example.com", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd: dir, encoding: "utf8" });
  write(".gitignore", "node_modules\n.env\n");
  write(".env", "API_KEY=dev\n");
  write("package-lock.json", JSON.stringify({ name: "shop-website", lockfileVersion: 3, packages: {} }));
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "Shop");
  write("src/App.tsx", "export const App = () => 'shop, changed';\n");
  const copy = await createWorkingCopy({ name: "shop-website", dir }, "up-react-19.1.0", { runInstall: async () => ({ ok: true, output: "" }) });
  assert.ok(copy.path.startsWith(snapshotsRoot()));
  assert.match(copy.id, /^shop-website-[0-9a-f]{7}-up-react-19-1-0$/);
  assert.equal(fs.readFileSync(path.join(copy.dir, "src", "App.tsx"), "utf8").replace(/\r\n/g, "\n"), "export const App = () => 'shop, changed';\n", "uncommitted changes come along");
  assert.deepEqual(copy.envFiles, [".env"]);
  assert.equal(copy.packages, "linked", "same lock file: the project's packages, linked");
  assert.ok(fs.lstatSync(path.join(copy.dir, "node_modules")).isSymbolicLink());
  unlinkPackages(copy);
  assert.equal(fs.existsSync(path.join(copy.dir, "node_modules")), false);
  assert.ok(fs.existsSync(path.join(dir, "node_modules", "react", "package.json")), "the project's own node_modules stays");
  // Made again for the same tag: replaced, not added.
  const again = await createWorkingCopy({ name: "shop-website", dir }, "up-react-19.1.0", { runInstall: async () => ({ ok: true, output: "" }) });
  assert.equal(listSnapshots().filter((s) => s.id === again.id).length, 1);
  await removeSnapshot(again.id);
  assert.equal(fs.existsSync(again.path), false);
  assert.ok(fs.existsSync(path.join(dir, "node_modules", "react", "package.json")));
  assert.equal(git("status", "--porcelain").trim(), "M src/App.tsx", "the project's own working copy is as it was");
});
