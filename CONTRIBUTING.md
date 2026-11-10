# Contributing to dx

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Before you start

- **A bug**: open an issue with the bug report form. Include what you ran, what happened, and the output of `dx doctor`.
- **A feature**: open an issue first, so we can agree on the shape before you spend time on code.
- **A security problem**: don't open an issue. See [SECURITY.md](SECURITY.md).

## Set up

You need Node 22 or newer and git.

```bash
git clone <your fork's URL> dx-toolkit
cd dx-toolkit
npm install
npm test           # builds everything and runs the tests
npm run link       # optional: puts your build of `dx` on your PATH
```

`npm run watch` rebuilds on every change. With `npm run link` done, the `dx` command runs your latest build straight away.

To try things without touching your real settings, point dx at a scratch folder:

```bash
DX_HOME=/tmp/dx-scratch dx ui           # macOS / Linux
$env:DX_HOME = "$env:TEMP\dx-scratch"; dx ui   # Windows PowerShell
```

## How the code is laid out

Every tool lives once in `packages/core` and is reached from the dashboard (`packages/web`), the CLI (`packages/cli`), the MCP server (`packages/mcp`) and Raycast (`packages/raycast`). [docs/development.md](docs/development.md) lists the steps (*Adding a new tool*), and [CLAUDE.md](CLAUDE.md) has the conventions in one place, for people and AI assistants alike.

The short version:

- **`core` has no runtime dependencies.** Only Node's own modules.
- **ESM with `NodeNext`**: relative imports end in `.js`, even in `.ts` files.
- **Tests** use `node:test`, live in `packages/<pkg>/src/__tests__/`, and never touch real data: set `DX_HOME` to a temp folder and build fixture projects in the system temp folder.
- **Anything that changes something** calls `recordRun(...)`, so it shows up in `dx runs`.
- **The dashboard's security checks stay intact**: 127.0.0.1 only, the Host and Origin checks, the per-run token, the strict content security policy, and only acting on projects dx itself found. CLAUDE.md explains each one.
- **Destructive actions ask first**, naming exactly what will be killed or deleted.

## Keep it free of personal details

This is a public repository. Don't commit your name, email, username, machine paths (`C:\Users\<you>\…`, `/Users/<you>/…`), tokens, or the names of your own projects, in code, tests, docs or screenshots. Use neutral examples such as `todo-app`, `shop-website`, `octocat` and `/path/to/dx-toolkit`.

## Pull requests

1. Branch from `main`, keep the change focused, and write the commit message as what it does: "Add yarn support to dx deps".
2. Add or update tests for what you changed.
3. Update the docs (`docs/cli.md`, `docs/features.md`, `docs/ai-tools.md`) if a command, option, dashboard page or MCP tool changed, and `CHANGELOG.md` under *Unreleased*.
4. `npm test` passes. CI runs it on Windows, macOS and Linux with Node 22 and 24, so say in the pull request which system you tried it on.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
