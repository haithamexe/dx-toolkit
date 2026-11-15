import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFailure, problemOf } from "../index.js";

test("a port that's taken says which port and who has it, with a way to use another", () => {
  const output = ["> shop-website@1.0.0 dev", "Error: listen EADDRINUSE: address already in use :::3000", "    at Server.setupListenHandle"];
  const bare = classifyFailure(output, { dir: "/path/to/shop-website" });
  assert.equal(bare.code, "port-in-use");
  assert.match(bare.message, /Port 3000 is in use\./);
  assert.deepEqual(bare.fixes?.map((f) => f.label), ["Use another port", "Show that process"]);
  assert.deepEqual(bare.fixes?.[0].post, { path: "/api/dev/start", body: { dir: "/path/to/shop-website", ownPort: true } });

  const owned = classifyFailure(output, { dir: "/path/to/shop-website", owner: { pid: 4120, name: "node.exe" } });
  assert.match(owned.message, /Port 3000 is in use by node\.exe \(process 4120\)\./);

  const stack = classifyFailure(output, { dir: "/path/to/shop-website", canMove: false });
  assert.deepEqual(stack.fixes?.map((f) => f.label), ["Show that process"], "a stack can't be moved as one, so it isn't offered");
});

test("Docker not running, a missing package and a missing command each have their own code", () => {
  const docker = classifyFailure(["docker compose exited with 1. Is Docker running?"]);
  assert.equal(docker.code, "docker-not-running");
  assert.match(docker.message, /Start Docker Desktop/);

  const pkg = classifyFailure(["Error: Cannot find module 'express'", "Require stack:"]);
  assert.equal(pkg.code, "module-missing");
  assert.match(pkg.message, /express/);
  assert.deepEqual(pkg.fixes, [{ label: "Copy npm install", command: "npm install" }], "a command to copy, never one dx runs");

  const cmd = classifyFailure(["'vite' is not recognized as an internal or external command,"]);
  assert.equal(cmd.code, "command-missing");
  assert.match(cmd.message, /vite/);
  assert.equal(classifyFailure(["sh: 1: next: command not found"]).code, "command-missing");
});

test("a start that stopped at a step, one that exited, and one nothing explains", () => {
  const step = classifyFailure(["shop-website didn't start: Install packages (npm) failed (a lock file changed). Run npm install by hand."]);
  assert.equal(step.code, "prepare-failed");
  assert.match(step.message, /Install packages \(npm\) failed/);
  assert.equal(classifyFailure(["Exited with 1."]).code, "exited");
  assert.equal(classifyFailure(["Exited with 1."]).message, "It stopped with code 1. The output has the reason.");
  assert.equal(classifyFailure([]).code, "failed");
});

test("only the end of the output is read, so an old line doesn't explain a new failure", () => {
  const old = Array.from({ length: 200 }, (_, i) => (i === 0 ? "EADDRINUSE :::3000" : `line ${i}`));
  assert.equal(classifyFailure(old).code, "failed");
});

test("any error becomes a Problem: its own, or a code from its kind", () => {
  const own = { code: "x", message: "m", problem: { code: "port-in-use", message: "Port 1 is in use." } };
  assert.deepEqual(problemOf(own), { code: "port-in-use", message: "Port 1 is in use." });
  assert.deepEqual(problemOf(new Error("It broke"), "internal"), { code: "internal", message: "It broke" });
  assert.equal(problemOf({ code: "ENOENT", message: "no" }, "invalid").code, "invalid", "a system error code isn't a stable code of dx's");
  assert.equal(problemOf({ code: "git-missing", message: "no git" }).code, "git-missing");
  assert.equal(problemOf("text only").message, "text only");
});
