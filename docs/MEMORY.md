# Project memory

What was decided while building dx, and why, so the next session doesn't relearn it. Newest first within each section. Update it when a decision is made or the backlog changes.

## Where it stands (Nov 2026)

- CI is green on Windows, macOS and Linux × Node 22 and 24.
- **On npm** as `dx-devkit` since 1.1.0: `npm install -g dx-devkit`.
- **Built**:
  - the core tools;
  - the `dx` command: `ui, go, up, down, new, projects, port, kill, log, summary, clean, deps, logs, errors, setup, config, runs, doctor`;
  - the MCP server with 19 tools, 10 of them for running apps;
  - stacks and local domains (`shop.localhost`);
  - the dashboard with 8 pages (Projects, New project, Ports, Journal, Summary, Cleanup, Dependencies, Health & settings);
  - error detection in dev-server output;
  - setting itself up with no configuration.
- **This is a public, open-source repository.** Nothing personal goes in it: no real names, emails, usernames, machine paths or names of anyone's own projects. Examples use neutral names (`todo-app`, `shop-website`, `api-gateway`, `octocat`), paths use `~` or `/path/to/dx-toolkit`, and test fixtures are built in temp folders.

## Backlog

- **Raycast**: the extension in `packages/raycast` has never been installed or checked. Add commands for summary and cleanup.
- **Local HTTPS** for `*.localhost`: needs a trusted local CA (an admin prompt once), so an opt-in step an agent can run.
- **More from the earlier idea list**: resume where you left off, an unsaved-work radar, `dx setup <git URL>`, a yearly work record, `.env` and secrets checks.
- **Browser console errors for agents**: point to pairing with a browser MCP server, or add a headless check later.
- **Tests for `cli`**: `core`, `web` and `mcp` have tests.
- **Private pull requests in the summary** need `GITHUB_TOKEN` or `gh auth login`; the dashboard could say so when neither is set.
- **`dx deps --fix`**: it only reports today; fixing is left to `npm update` / `npm audit fix`.
- **yarn and bun** projects are skipped by `dx deps`.
- **Releases**:
  - **1.0.0** was a GitHub-only release; its tag is `1.0.0` on the same commit as `v0.1.0`.
  - **1.1.0** is the first on npm, as `dx-devkit`. npm refused `dxkit` as too close to existing names (degit, pdfkit). A free name (`npm view <name>` gives E404) can still be refused: the look-alike check only runs on a real publish, and short names fail it most.
  - **To release**: add each change to `CHANGELOG.md` under *Unreleased*; at release time, bump every `package.json`, run `npm run release` and `node scripts/smoke-package.mjs`, tag `vX.Y.Z`, then `npm publish ./release` (needs the maintainer's npm login) and, once npm has processed it, `node scripts/smoke-package.mjs --from-npm`.
- **README screenshots** (`docs/images/`) come from made-up demo projects under a neutral author, taken with headless Edge/Chrome (`--screenshot`, `--blink-settings=preferredColorScheme=0|1`). Retake them the same way when a page changes; never from real projects.

## Decisions

### No setup, ever (the guiding rule)

- **Every feature works without the user configuring anything.** If something needs setting up, dx does it itself; if it truly can't (a system package to install), `dx doctor` and the `dx_setup_check` MCP tool give the exact fix command so the user's AI agent can run it.
- **First run**:
  - `firstRunConfig()` picks the projects folders from the usual code folders that exist.
  - It picks the editor from the first known one on PATH.
  - `firstRunSetup()` in the CLI and `autoConnectAiTools()` in the dashboard add dx to installed AI tools.
- **AI tool connections** (`core/src/tools/aiSetup.ts`):
  - **Claude Code** goes through `claude mcp add -s user`. Its `~/.claude.json` is busy and large, so dx never edits it directly.
  - **The other tools** get a JSON entry:
    - Claude Desktop, Cursor and Windsurf: under `mcpServers`.
    - VS Code: under `servers`, with `type: "stdio"`. Its file may have comments.
  - The entry uses `process.execPath` as the command so GUI apps without Node on PATH still work.
  - The original file is backed up once as `*.dx-backup`.
  - **`aiToolsSeen` remembers tools already offered**, so a tool the user disconnected by hand isn't reconnected. `autoConnectAi: false` (set by `dx setup --undo`) turns it all off.
  - **Tests pass an `AiEnv`** (home, app-data folder, fake `claude`) and never touch the real machine. Test configs that start a background dashboard set `autoConnectAi: false` for the same reason.

### Stacks (`core/src/tools/stacks.ts`, `web/src/dev.ts`)

- **Found, not configured.** `detectStack()` tries, in order:
  1. `.devrc.json` "stack";
  2. a Procfile;
  3. a monorepo runner in the root `dev` script;
  4. `dev:*` scripts;
  5. workspaces with `dev` scripts.

  Infrastructure services from compose (image matches postgres/redis/…, no `build:`) are added in front of any of these. A project with only one thing to run has no stack and runs as before.
- **Runners are kept, not replaced.** When the root `dev` runs turbo, nx, concurrently or similar, dx runs that one command as the project intends and splits its output by line prefix (`web:dev:`, `[api]`) into services, each with its own error tracker.
- **Order comes from roles**, guessed from the name or command: data, then backend, then other, then frontend. Each tier waits for the one before to be *ready*:
  - its port opens;
  - or, for something that never prints a URL, it's still running and its output has gone quiet (5s up, 2.5s quiet).
- **A URL another dx-run server owns isn't taken as this server's address.** A front end that prints "API at http://localhost:4000" would otherwise be mistaken for the API.
- **`DX_<SERVICE>_URL` is the direct `localhost:port` address**, because server code on some Linux systems can't resolve `*.localhost`. `DX_<SERVICE>_PUBLIC_URL` is the `.localhost` one.
- **Docker services** run `docker compose up -d <svc>`, are ready when their published port opens, and are stopped with `docker compose stop` when the stack stops.
- **Line numbers are global across all processes**, so a stack's services' output merges in order.

### Local domains (`web/src/proxy.ts`)

- **A small reverse proxy runs inside the dashboard process**, on port 80, falling back to 1355 (`localDomainsPort` overrides; tests use 0). It listens on 127.0.0.1, and on ::1 too when it can.
- **Routing**: by Host:
  - `<project>.localhost` is a single app, or the stack's main (first front end) service;
  - `<service>.<project>.localhost` is each stack service;
  - `dx.localhost` is the dashboard, with Origin rewritten so its own page passes the Origin check.

  Anything else gets a 404 page.
- **Host is rewritten to `localhost:<port>`** going in (dev servers that check Host accept it) and `Location` back going out; WebSocket upgrades are piped.
- **`check_url` maps `*.localhost` to the target directly** instead of going through the proxy, because Node can't always resolve those names.

### AI agents running apps (MCP + dashboard)

- **The dashboard owns the dev servers; the MCP server is a client.**
  - That way the user sees what the agent runs (a "Started by AI" label), there's no second copy on another port, and servers outlive the chat.
  - The rejected alternative was the MCP process running its own servers: they'd be invisible, and the two would collide on ports.
- **`~/.dx/dashboard.json`** holds the running dashboard's URL, token and pid, written with mode 0600.
  - `link.ts`'s `ensureDashboard()` reads it, pings `/api/ping`, and if nothing answers starts `web/dist/background.js` detached.
  - A `dashboard.lock` file keeps two callers from starting two dashboards.
- **A background dashboard stops itself** after 30 minutes with no running dev servers and no API requests (the open page polls, so it counts). `POST /api/shutdown` stops any dashboard (`dx ui --stop`).
- **Error detection** (`core/src/tools/devErrors.ts`):
  - It reads output line by line.
  - Start patterns per tool are anchored at the line start (after an optional timestamp), so echoed source code that mentions "error" isn't one.
  - Indented or stack/code-frame lines join the error.
  - The id is a hash of kind, message (digits blanked) and file:line, so repeats count up.
  - A clean rebuild line resolves all current errors.
  - Node prints a SyntaxError's `file:line` above the error, so the last 6 lines are kept to find it.
- **`check_url` only reaches loopback hosts** and doesn't follow redirects, so an agent can't be steered at the network.
- **`POST /api/open-file`** opens only files inside a project dx found.
- **The MCP tools remember the last output line the agent saw per project** (in the MCP process), so `dev_logs` and `wait_for_rebuild` return only what's new.

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
