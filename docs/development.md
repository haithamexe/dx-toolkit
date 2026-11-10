# Working on dx

Adding a tool, tests, and working on dx with Claude Code. Back to the [README](../README.md).

## Adding a new tool

1. **Write the logic** in `packages/core/src/tools/<tool>.ts` and export it from `packages/core/src/index.ts`.
2. **Terminal**: add `packages/cli/src/commands/<tool>.ts` (copy `log.ts` as a template) and add it to the list in `packages/cli/src/index.ts`.
3. **Raycast** (optional): add `packages/raycast/src/<tool>.tsx` and an entry under `commands` in `packages/raycast/package.json`.
4. **AI** (optional): add one `server.registerTool(...)` block in `packages/mcp/src/index.ts`.
5. **Dashboard** (optional): add a route in `packages/web/src/api.ts` (it must check the project with `scanProjects()` like the others) and a page in `packages/web/public/app.js`.
6. **Build**: run `npm run build`, then `npm test`. Tests go in `packages/<pkg>/src/__tests__`.

Call `recordRun(tool, ok, detail)` from anything that changes something, so it shows up in `dx runs`.

## Tests and CI

`npm test` builds everything and runs the tests in `packages/core`, `packages/web`, `packages/mcp` and `packages/cli`:
- **core**: the tools, including error detection on real output from each tool it knows, connecting to AI tools on a pretend computer, loading broken pages in a real headless browser, cloning and setting up a repository, `.env` and secret checks, and unsaved work across repositories.
- **web**:
  - the dashboard's server: its security checks, and a real dev server started, streamed, checked for errors and stopped through it;
  - a real two-service stack: started in order, reached through `shop.localhost` (WebSockets and redirects included), then stopped;
  - https through the local domains proxy, with a throwaway certificate.
- **mcp**: a real MCP client that starts an app, finds an error through a request and in the browser, sees it cleared, and leaves a note, as an agent would.
- **cli**: the `dx` command run as a user runs it.

On GitHub, [.github/workflows/ci.yml](../.github/workflows/ci.yml) runs them on every push to `main` and every pull request, on Windows, macOS and Linux with Node 22 and 24, and tries the `dx` command itself.

## Working on dx with Claude Code

[CLAUDE.md](../CLAUDE.md) tells Claude Code how this repo is built, its conventions and the dashboard's security rules. [docs/MEMORY.md](MEMORY.md) keeps the decisions made so far and why, the gotchas, and the backlog. CLAUDE.md imports it, so both load in every session here. Update MEMORY.md when a decision is made.
