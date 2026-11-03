import assert from "node:assert/strict";
import { test } from "node:test";
import { fuzzyRank, fuzzyScore, splitWords } from "../fuzzy.js";

test("exact beats prefix beats word-start beats substring beats letters-in-order", () => {
  const exact = fuzzyScore("todo-app", "todo-app");
  const prefix = fuzzyScore("sho", "shop-website");
  const word = fuzzyScore("web", "shop-website");
  const sub = fuzzyScore("bsi", "shop-website");
  const seq = fuzzyScore("sws", "shop-website");
  assert.ok(exact > prefix, "exact > prefix");
  assert.ok(prefix > word, "prefix > word start");
  assert.ok(word > sub, "word start > substring");
  assert.ok(sub > seq, "substring > subsequence");
  assert.ok(seq > 0);
});

test("no match returns -1", () => {
  assert.equal(fuzzyScore("xyz", "todo-app"), -1);
});

test("case, dashes and spaces are ignored", () => {
  assert.equal(fuzzyScore("admin frontend", "Admin-Frontend"), 1000);
});

test("acronyms match", () => {
  assert.ok(fuzzyScore("gh", "git-hooks") > fuzzyScore("gh", "graph-chart"));
});

test("splitWords handles kebab and camel case", () => {
  assert.deepEqual(splitWords("Admin-Frontend"), ["Admin", "Frontend"]);
  assert.deepEqual(splitWords("gitHooks"), ["git", "Hooks"]);
});

test("fuzzyRank orders best first", () => {
  const names = ["shop-website", "shopping-list", "graph-chart"];
  const ranked = fuzzyRank("shopping", names, (n) => [n]);
  assert.equal(ranked[0].item, "shopping-list");
});
