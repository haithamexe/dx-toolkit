# Changelog

Notable changes to dx, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

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

## 0.1.0 (2026-11-03)

The first public release.

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
