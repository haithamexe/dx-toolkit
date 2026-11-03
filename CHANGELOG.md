# Changelog

Notable changes to dx, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- **AI agents see errors in the browser too.** `check_url` with `browser: true` loads the page in a headless Chrome, Edge, Chromium or Brave already on the computer and reports:
  - uncaught exceptions, console errors and warnings;
  - failed requests (4xx, 5xx, refused);
  - a Vite or Next.js error overlay;
  - what the server logged during the same page load.

  `screenshot: true` returns a picture of the page. Nothing to install: dx talks to the browser over the DevTools protocol. In the dashboard, **Check page** on a running server does the same.
- **`dx clone <repo>`**: clones into your projects folder and installs packages with the tool the repository uses (npm, pnpm, yarn, bun, pip, uv, go). It creates `.env` from `.env.example`, lists the variables that still need a value, then opens and runs the project. The same is on the dashboard's New project page and in the `clone_project` MCP tool.
- **Where you left off**: dx remembers each project's branch, what was running and the errors open when it stopped.
  - `dx resume` shows it, with commits since, uncommitted files and journal entries.
  - `dx go` shows it when you come back after a while.
  - Notes for next time come from you (`dx resume --note`, the dashboard) or your AI agent (`leave_note`), and `resume_project` reads it all back.
- **`dx status`**: work that exists only on this computer, most at risk first: uncommitted changes, commits no remote has, stashes and repositories with no remote. Worktrees count only their own branch. It's also a panel on the Projects page and the `unsaved_work` MCP tool.
- **`dx env`**: compares `.env` files with `.env.example`, flags `.env` files git tracks or doesn't ignore, and finds keys and tokens in tracked files (AWS, GitHub, OpenAI, Anthropic, Stripe, Slack, Google, npm, SendGrid, private keys), always masked. It's also in the project menu in the dashboard and the `check_env` MCP tool.
- **`dx https`**: https://shop.localhost with a certificate your browsers trust, through mkcert.
  - It's opt-in, since it changes what the system trusts.
  - New projects are added to the certificate the first time they're opened.
  - `dx doctor` checks it.
- **`dx deps --fix`**: updates a project's packages within package.json's ranges and applies non-breaking audit fixes. Major versions are listed instead. It's also the **Update packages** button on the Dependencies page and the `fix_dependencies` MCP tool.
- **yarn and bun projects in `dx deps`**, checked against the npm registry directly: latest versions, and advisories for the installed versions.
- **`dx doctor`** checks for a headless browser and, when you have GitHub repositories, for a GitHub login (private pull requests in the summary).
- **Raycast**: Work Summary and Clean Up Projects commands.
- **Tests for the `dx` command**.

## 1.1.0 (2026-11-03)

Your AI coding agent can now run your app and see what it does, whole stacks start with one command at readable `.localhost` addresses, and nothing needs setting up. Install it with `npm install -g dx-devkit`.

### Added

- **Published on npm as `dx-devkit`**: one global install gives the `dx` command, the dashboard and the MCP server.
- **Stacks**: a project's front end, API, workers and databases start together, in order, with one command or button (`dx up`, `dx go`, Run, or an AI agent's `start_dev_server`).
  - **Found with no configuration** from:
    - Procfiles;
    - turbo, nx, concurrently, npm-run-all or lerna dev scripts, with their output split back into services;
    - `dev:*` scripts;
    - npm, yarn and pnpm workspaces;
    - databases in docker-compose.
  - **Order**: databases first, then back ends, then front ends. A service whose dependency failed isn't started.
  - **Addresses passed along** as `DX_<SERVICE>_URL` and `DX_<SERVICE>_PUBLIC_URL`.
  - **Two repositories**: `set_stack` (MCP) or `"stack"` in `.devrc.json` define a stack dx can't guess.
- **Local domains**: running apps at `http://<project>.localhost`, stack services at `http://<service>.<project>.localhost`, and the dashboard at `http://dx.localhost`.
  - **Nothing to set up**: browsers resolve `*.localhost` by themselves.
  - **Live reload works**: WebSockets pass through, and redirects are rewritten.
  - **Port**: 80, or 1355 when 80 isn't available.
- **Dashboard**:
  - A stack shows as one card, with a row per service (status, address, errors) and their combined output labelled by service, with a filter.
  - Errors show which service they came from.
- **`dx up` and `dx down`** start and stop a stack in the background.
- **`dx doctor`** checks Docker (when a stack needs it) and whether local domains got port 80, with fixes.
- **Project detection**: projects with only a Gemfile, a Procfile or a compose file are found too.
- **AI agents can run your app and see what it does.** Nine new MCP tools:
  - `start_dev_server` waits until the app is ready and reports its URL, errors and output.
  - `wait_for_rebuild` says whether an edit added or fixed errors.
  - `check_url` requests a page and returns what the server logged while answering.
  - `dev_errors` and `dev_logs` read errors and output.
  - `dev_servers`, `stop_dev_server` and `restart_dev_server` list, stop and restart servers.
  - `dx_setup_check` gives each setup problem with its fix.
- **Error detection in dev server output**:
  - TypeScript, Vite, esbuild, webpack and Next.js, Node stack traces and syntax errors, Python tracebacks, Go errors and panics.
  - Each error has its file and line and a repeat count, and is cleared once the server rebuilds cleanly.
- **Dashboard**:
  - Each dev server shows its errors; clicking an error's file opens your editor at that line.
  - A "Started by AI" label marks servers an agent started.
  - The Health page shows which AI tools are connected, with buttons, and how to fix each failed check.
- **No setup**:
  - On first use dx finds your code folders and editor, and connects itself to Claude Code, Claude Desktop, Cursor, Windsurf and VS Code, whichever are installed.
  - AI tools start the dashboard in the background when they need it; it stops itself when idle.
- **New commands**:
  - `dx setup` (`--list`, `--undo`) manages the AI tool connections.
  - `dx logs <project> -f` follows a server's output.
  - `dx errors` lists current errors.
  - `dx ui --background` and `dx ui --stop` start and stop the dashboard without a terminal.
- **Better `dx doctor`**: each problem now comes with how to fix it.

### Changed

- `dx ui` opens the running dashboard instead of starting a second one.
- On a new install, the default projects folder is the code folders dx finds, rather than `~/Desktop/projects`.

## 1.0.0 (2026-11-03)

The first public release, on GitHub only (its git tag is `v0.1.0`).

### Added

- **The dashboard, `dx ui`**: a local web interface with eight pages: Projects, New project, Ports, Journal, Summary, Cleanup, Dependencies, and Health & settings. Dev servers run inside it, with live output.
- **The `dx` command**:
  - `go` opens a project, starts its dev server and opens the browser.
  - `new` creates a project from a template or a copy of another.
  - `projects`, `port` and `kill` list projects and free ports.
  - `log` keeps a work journal.
  - `summary` reports your week: commits, pull requests, journal, where the time went, uncommitted work.
  - `clean` deletes `node_modules` and build folders in idle projects.
  - `deps` lists outdated packages and vulnerabilities across projects.
  - `config`, `runs` and `doctor` cover settings and setup.
- **An MCP server** with nine tools, so Claude and other AI tools can list and open projects, free ports, write and read the journal, summarise your week, and check cleanup and dependencies.
- **A Raycast extension** with Open Project, Kill Port, Log Work and Work Journal. It's an early preview that hasn't been tested in Raycast yet.
- **Windows, macOS and Linux support**, tested in CI with Node 22 and 24.
