import assert from "node:assert/strict";
import { test } from "node:test";
import { githubOwner, mostCommonOwner, parseSearchResults } from "../tools/github.js";

test("githubOwner reads https and ssh remotes, and ignores other hosts", () => {
  assert.equal(githubOwner("https://github.com/octocat/dx-toolkit.git"), "octocat");
  assert.equal(githubOwner("git@github.com:octocat/todo-app.git"), "octocat");
  assert.equal(githubOwner("https://github.com/acme/site"), "acme");
  assert.equal(githubOwner("https://gitlab.com/me/x.git"), undefined);
  assert.equal(mostCommonOwner(["https://github.com/a/x", "https://github.com/b/y", "git@github.com:b/z.git", ""]), "b");
  assert.equal(mostCommonOwner([]), undefined);
});

test("parseSearchResults reads PRs, oldest first", () => {
  const prs = parseSearchResults(
    {
      items: [
        {
          title: " Second ",
          number: 7,
          html_url: "https://github.com/me/app/pull/7",
          repository_url: "https://api.github.com/repos/me/app",
          pull_request: { merged_at: "2026-10-30T12:00:00Z" },
        },
        {
          title: "First",
          number: 3,
          html_url: "https://github.com/me/lib/pull/3",
          repository_url: "https://api.github.com/repos/me/lib",
          pull_request: { merged_at: "2026-10-28T12:00:00Z" },
        },
        { title: "broken" },
      ],
    },
    "merged",
  );
  assert.deepEqual(
    prs.map((p) => [p.title, p.repo, p.number]),
    [
      ["First", "me/lib", 3],
      ["Second", "me/app", 7],
    ],
  );
  assert.deepEqual(parseSearchResults({ message: "bad" }, "updated"), []);
});
