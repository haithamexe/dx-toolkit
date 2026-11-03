# Changelog

Notable changes to dx, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

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
