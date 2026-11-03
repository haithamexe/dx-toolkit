# CLAUDE.md

Guidance for Claude Code when working in this repository. What the project is for, and how to use it, is in [README.md](README.md). Decisions, history and known gaps are in [docs/MEMORY.md](docs/MEMORY.md), imported here so they load with this file:

@docs/MEMORY.md

## What this is

`dx` is a personal developer toolkit. Every tool is written once in `packages/core` and reached four ways:

| Package | What it is | Built by `npm run build` |
|---|---|---|
| `packages/core` | The tools: projects, ports, launch, journal, summary, github, cleanup, deps, scaffold, doctor. Plain Node, no runtime dependencies | yes |
| `packages/web` | The dashboard (`dx ui`): a `node:http` server plus a vanilla-JS page in `public/` | yes |
| `packages/cli` | The `dx` command | yes |
| `packages/mcp` | The MCP server (stdio) for Claude and other AI tools | yes |
| `packages/raycast` | Raycast extension, outside the npm workspaces, installed on its own | no |

## Commands

```bash
npm install
npm run build      # tsc -b over core, web, cli, mcp (project references)
npm test           # builds, then node --test over core and web dist tests
npm run watch      # rebuild on change
npm run link       # npm install -g ./packages/cli: puts `dx` on PATH (a link, so rebuilds go live)
npm run ui         # the dashboard from this folder
```

Run one test file: `node --test packages/core/dist/__tests__/summary.test.js` (after a build).

## Conventions

- **Node 22+, ESM, `module: NodeNext`.** Relative imports end in `.js` even in `.ts` files.
- **`core` has no runtime dependencies.** Only `node:` modules. `mcp` uses `@modelcontextprotocol/sdk` and `zod`; nothing else is added without a reason.
- **Tests** use `node:test` and `node:assert/strict`, live in `packages/<pkg>/src/__tests__/*.test.ts`, and never touch real data: they set `DX_HOME` to a temp folder before importing anything that reads config, and build fixture projects in `os.tmpdir()`.
- **Everything dx stores is under `~/.dx`**, or `DX_HOME` when set. Use `dxHome()` / `dxPath(...)` from `core/src/config.ts`; never hard-code the path.
- **Record runs.** Anything that changes something calls `recordRun(tool, ok, detail, source, extra)` so it shows in `dx runs`.
- **A new tool** goes in core first, then the CLI command, then optionally MCP, the dashboard and Raycast. The steps are in README, *Adding a new tool*.
- **Shell commands** run through `child_process` with arguments as arrays where possible. Where `shell: true` is needed (dev commands, `npm`), the command comes from the project's own `package.json` or `.devrc.json`, never from a request body.

## The dashboard's security model (keep it intact)

`packages/web/src/server.ts` and `api.ts`:

- Listens on `127.0.0.1` only. The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding).
- A random token per run is injected into `<meta name="dx-token">`; every `/api/*` call sends it as `X-DX-Token`, compared with `timingSafeEqual`. Cross-origin `Origin` headers are refused.
- CSP: `default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; …`. No inline scripts or styles, no external hosts. The page builds DOM with the `h()` helper and text nodes, never `innerHTML` with data.
- Every action takes a project `dir` and checks it against `scanProjects()`; cleanup deletes only folders `findCleanup()` returns on a fresh scan.
- `server.test.ts` covers all of this. Run it after touching either file.

## The dashboard's front end

- `public/app.js`: hash router, one function per page, helpers `api()`, `h()`, `append(el, ...children)`, `btn()`, `toast()`, `confirmDialog()`, `segmented()`.
- `public/styles.css`: CSS custom-property tokens at the top (light, dark via `prefers-color-scheme`, and `[data-theme]` overrides), 4px spacing base, breakpoint 860px. Use the tokens; don't add literal colours or spacing.
- Status colours carry the CLI's meanings: ok green, warn yellow, danger red, accent cyan.
- Destructive actions (kill, delete) always go through `confirmDialog()` naming what will happen.

## Public repository: nothing personal

This repo is public and open source. Never commit real names, emails, usernames, machine paths (`C:\Users\<name>\…`), tokens, or the names of anyone's own projects, in code, comments, tests, docs or examples. Use neutral examples (`todo-app`, `shop-website`, `octocat`, `/path/to/dx-toolkit`, `~`).

**Commits are the maintainer's alone.** No `Co-Authored-By` trailers, no "Generated with" lines, in commit messages or pull request descriptions.

## Before you finish

- `npm test` passes.
- README updated if a command, option, page or MCP tool changed.
- `docs/MEMORY.md` updated if a decision was made or the backlog changed.
