# Project memory

What was decided while building dx, and why, so the next session doesn't relearn it. Newest first within each section. Update it when a decision is made or the backlog changes.

## Where it stands (Nov 2026)

- CI is green on Windows, macOS and Linux × Node 22 and 24.
- **Built**: core tools; the `dx` command with `ui, go, new, projects, port, kill, log, summary, clean, deps, config, runs, doctor`; the MCP server with 9 tools; the dashboard with 8 pages (Projects, New project, Ports, Journal, Summary, Cleanup, Dependencies, Health & settings).
- **This is a public, open-source repository.** Nothing personal goes in it: no real names, emails, usernames, machine paths or names of anyone's own projects. Examples use neutral names (`todo-app`, `shop-website`, `api-gateway`, `octocat`), paths use `~` or `/path/to/dx-toolkit`, and test fixtures are built in temp folders.

## Backlog

- **Raycast**: the extension in `packages/raycast` has never been installed or checked. Add commands for summary and cleanup.
- **Tests for `cli` and `mcp`**: only `core` and `web` have tests.
- **Private pull requests in the summary** need `GITHUB_TOKEN` or `gh auth login`; the dashboard could say so when neither is set.
- **`dx deps --fix`**: it only reports today; fixing is left to `npm update` / `npm audit fix`.
- **yarn and bun** projects are skipped by `dx deps`.
- **Version bump**: everything is still 0.1.0.

## Decisions

### Dashboard (`packages/web`)

- **No framework, no bundler.** Plain `node:http` and a vanilla-JS page, so `dx ui` starts instantly and there's no front-end build step or dependency tree to audit.
- **Local-only by design.** It binds to 127.0.0.1 and checks the Host header, a per-run token and the Origin; the CSP allows no inline code. The dashboard can kill processes and delete folders, so any web page must not be able to drive it. CLAUDE.md lists the rules.
- **Dev servers run inside the dashboard.**
  - The aim is that everything `dx` does can be done from the dashboard, dev servers included.
  - A ring buffer keeps 2000 lines with ANSI codes stripped, and the page polls `/api/dev/logs?after=N`.
  - A URL the server prints wins over the guessed port; a port already busy at start isn't trusted as "ready".
- **Stopping a dev server kills the whole process tree.**
  - Windows: `taskkill /T /F`.
  - Unix: `detached: true` plus `process.kill(-pid)`.
  - CI proves both.
- **Servers started from the dashboard stop with it**, like closing a terminal. For one that keeps running, use "Run in a terminal window".
- **Default port 4646**, moving to the next free one.

### Summary

- **Only your commits count**: `git log --all --no-merges` filtered by that repo's `user.name` *and* `user.email`, with `--fixed-strings`.
- **A message committed several times is listed once with ×N.** "(2)" read as a footnote.
- **Pull requests come from the GitHub search API.**
  - The token is `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`.
  - The username is `config.githubUser`, else the most common owner among the repos' remotes.
- **Time per project** is the days with commits or a `dx go`, plus dev-server run time from `runs.jsonl` (`project` and `ms` fields).

### Cleanup

- **Inside a git repo, only folders git ignores** (`git check-ignore --stdin`), so a committed `build/` is never deleted. Outside git, only folders that are always rebuildable (`node_modules`, `.next`, …), never `dist`/`build`.
- **Deleting re-checks each folder** against a fresh scan, so the dashboard can't be made to delete an arbitrary path.

### `dx new`

- **Copying a git project copies `git ls-files --cached --others --exclude-standard`.** A plain folder walk copied 11,382 files, including reports and uploads; this copies 1,819.
- `.env*` is always left out, except `.env.example`. `{{name}}` is replaced in file contents and names; `package.json` and `.devrc.json` get the new name.

### Deps

- **0.x minor bumps count as major**, since semver treats them as breaking.
- **Four projects at a time.** `npm outdated` and `npm audit` exit non-zero when they find something, so the JSON is parsed regardless of the exit code.

## Gotchas met along the way

- **Clipboard on Windows**: `clip.exe` pastes a UTF-8 BOM as a visible character. Write UTF-16LE without a BOM.
- **Shell-mangled regexes**: tests built through a shell lost their backslashes; prefer `includes` checks in tests over regexes that pass through a shell.
- **The dashboard was blank** because `append` was called with an array where it takes `...children`. Keep the signature `append(el, ...children)`.
- **Horizontal scroll at phone width** came from a visually hidden `th` label positioned against the page. `.table-wrap { position: relative }` contains it.
- **LF/CRLF warnings** on commit are harmless (`core.autocrlf`).
- **Node 22 on CI, 24 locally**: the code avoids anything newer than 22.
