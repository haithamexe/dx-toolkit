# CLAUDE.md

Guidance for Claude Code when working in this repository. What the project is for, and how to use it, is in [README.md](README.md). Decisions, history and known gaps are in [docs/MEMORY.md](docs/MEMORY.md), imported here so they load with this file:

@docs/MEMORY.md

## What this is

`dx` is a personal developer toolkit. Every tool is written once in `packages/core` and reached four ways:

| Package | What it is | Built by `npm run build` |
|---|---|---|
| `packages/core` | The tools: projects, ports, launch, journal, summary, github, git, cleanup, deps, scaffold, doctor, machine. Plain Node, no runtime dependencies | yes |
| `packages/web` | The dashboard (`dx ui`): a `node:http` server plus a vanilla-JS page in `public/` | yes |
| `packages/cli` | The `dx` command | yes |
| `packages/mcp` | The MCP server (stdio) for Claude and other AI tools | yes |
| `packages/raycast` | Raycast extension, outside the npm workspaces, installed on its own | no |

## Commands

```bash
npm install
npm run build      # tsc -b over core, web, cli, mcp (project references)
npm test           # builds, then node --test over core, web and mcp dist tests
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
- `~/.dx/dashboard.json` (mode 0600) holds the URL and token so the CLI and MCP server can call the API (`web/src/link.ts`). Never put the token anywhere else: not in a URL, a log line or `runs.jsonl`.
- `POST /api/check` reaches loopback hosts only and doesn't follow redirects, also with `browser: true` (`checkPage` refuses anything but loopback itself); `POST /api/open-file` opens files inside a known project only.
- The network log (`traffic.ts`) masks credential headers and body fields before storing anything, keeps it in memory only, and never records the dashboard's own traffic. `POST /api/tests` runs a known project's own test setup with fixed flags; a name pattern is quoted.
- **Git** (`git.ts`, `/api/git/*`): every route takes a known git project's `dir`. Paths must be ones a fresh `git status` lists, and are passed with `--literal-pathspecs` on stdin. A block is named by its id; the patch is rebuilt from git's own diff on the server, never taken from the request. A commit hash must be 4 to 40 hex characters, so it can't pass as an option. Commit messages go in on stdin. Every other operation goes through `POST /api/git/action` by name (`GIT_ACTIONS` in `api.ts`); `gitops.ts` checks branch, tag and stash names against a fresh listing or `check-ref-format`, and conflict resolutions are rebuilt from the file's own text and its hash. Undo reads only the journal in `~/.dx/git-undo` (mode 0600), never the request. Force push is only `--force-with-lease`. `POST /api/git/suggest` (Write message) takes a known project's `dir` and nothing else: the prompt and the staged diff are built on the server and go to `claude -p` on stdin with fixed arguments, only when the button is clicked, and the answer only fills the message box. Tests use a fake `claude` first on PATH, never the real one.
- `POST /api/clone` takes only a git address (`normalizeGitUrl`) and passes it to git after `--`. `POST /api/deps/fix`, `GET /api/env` and `POST /api/note` take a known project's `dir`, and the fix runs fixed commands only.
- The local domains proxy (`proxy.ts`) listens on loopback only and forwards only to dev servers dx runs (`localRoutes()`) or the dashboard (`dx.localhost`), over http and, when `dx https` is on, https. Never route to an arbitrary host or port from a request; the certificate grows only for names that are already routes.
- The activity recorder (`recorder.ts`): the proxy answers `/__dx/` paths itself and never forwards them. `POST /__dx/events` takes events only when `Origin` is the page's own origin, at most 512 KB and 200 events, known types and fields only, clipped and masked (`maskBody`). Nothing is ever read back from it. The script tag goes only into 2xx HTML answers to GET, uncompressed, and not when the page's CSP wouldn't run a `'self'` script or `activity` is off. History files are mode 0600 under `~/.dx/activity`; `GET /api/activity`, `GET /api/activity/report` and `POST /api/activity/clear` take a known project's `dir`. `POST /api/activity/replay` takes a known project's `dir` and a visit id; the steps come only from the recorded history, never from the request, and the page must be on loopback (`isLoopbackUrl`), as for `/api/check`.
- **.env files** (`envaudit.ts`, `/api/env/*`): reading and saving take a known project's `dir` and a file name that must look like a `.env` file, sit inside the project (links resolved, no `..`, not under `node_modules` and similar), and be a plain file, not a link. Saves are whole, at most 256 KB, through a temp file and a rename. Values travel only in `GET`/`POST /api/env/file`, never in the list (`/api/env/all`), a URL, a log line or `runs.jsonl`. `.gitignore` gets only rules from `GITIGNORE_RULES`, appended, never rewritten.
- **The localhost door** (`frontdoor.ts`): for a dev server dx starts and knows how to move (`moveDevPort`), dx listens on the app's usual port on loopback only and forwards only to that server's own port, through the same `relay` as the proxy (recording, recorder script, `/__dx/` answered by dx). It's opened only when the port is free and closed when the server stops or doesn't take the port it was given.
- **Visual diffs** (`visual.ts`, `/api/visual*`): captures load only the dev server dx runs for that project, at its own loopback address (`visualTarget`, `isLoopbackUrl`), and only paths on that origin. `GET /api/visual/image` takes a known git project's `dir`, a hex commit the index lists, a capture name that commit has (`name@desktop|mobile`) and a kind (shot, diff, thumb); the file path is built by `visualImageFile`, never taken from the request, and the image goes back as a data URL in JSON (the CSP's `img-src 'self' data:` is unchanged). A capture never holds up the commit.
- **The Machine page** (`/api/machine/*`): `POST /api/machine/stop` takes a PID and stops it only if a fresh list has it, and never dx itself or a server dx runs. `POST /api/machine/run` takes a tool id (and a known project's `dir`) and opens the command it works out again in a terminal; a command never comes from the request. Docker actions take a container id from a fresh `docker ps`, or one of three fixed clean-ups, never volumes. Services are only shown, with commands to copy.
- **Ask Claude to fix** (`fixer.ts`, `fixes.ts`, `/api/fix/*`): Claude Code runs only on the page's button (or `dx fix`). `POST /api/fix/propose` takes a known git project's `dir`, a source (`dev` or `activity`) and an error id; the server looks the error up in its own records and builds the prompt itself (files only inside the project, plain files, never under `node_modules`/`.git`, never `.env` files, keys or lock files). Claude's diff is rebuilt with dx's own headers, every path must be inside the project, and it's checked on a throwaway index; the patch is kept in the web process by a random id (30 minutes, for that project only) and `POST /api/fix/apply` applies only the stored one, never a patch from the request, after checking the files haven't changed and backing each one up in the undo journal.
- **Run any commit** (`snapshots.ts`, `/api/git/search`, `/api/git/at`, `/api/snapshots/*`): every route takes a known git project's `dir`; a commit must be 4 to 40 hex characters and resolve (`rev-parse <hash>^{commit}`); search words go to git as one fixed-string argument. Snapshots live only under `~/.dx/snapshots` and are known projects (`knownProject(dir, { snapshots: true })`) only while registered in `snapshots.json`, and only for dev-server, check, open and history routes, never git or file-writing ones. Remove takes a registered id, stops its server first and unlinks `node_modules` links before deleting, never following them. Untracked `.env` files are copied only into the user's own `~/.dx/snapshots`.
- **The dx browser** (`core/src/tools/dxbrowser.ts`, `web/src/dxbrowser.ts`, `/api/browser/*`, `/api/sites/*`): driven over `--remote-debugging-pipe`, never a debugging port, with its own profile (`~/.dx/browser-profile`). It records only recorded sites (`sites` in the config, validated by `normalizeSiteHost`) and addresses on this computer; everything else is dropped as it arrives, and a recorded page's requests to other hosts are kept without bodies. Never the dashboard itself, nor pages the proxy already records. Everything is masked (`mask.ts`) before it's stored; clicks come from a binding only its isolated world can call; dx never fetches anything from a site by itself (deployment info is read from what the site sent). An address to open must be http(s), without user:password (`checkOpenUrl`); runs.jsonl gets its host only.
- **Bug bundles** (`bugbundle.ts`, `/api/activity/bundle*`): export takes a known project's `dir` and an event id; the bundle keeps paths only (no host or port), allowlisted headers, bodies masked again, and project and home paths stripped. `POST /api/activity/bundle/replay` checks the bundle with `readBugBundle` (format and version, at most 2 MB, only known fields, a hex commit that `resolveCommit` finds in that project, steps with only the `PageStep` fields and no address on another computer). The bundle's own host is never used: the start path is resolved on the project's own dev server (`bundleUrl`: loopback, same origin). That route and `/api/mocks/update` read up to 3 MB; everything else 1 MB.
- **Mock mode** (`mocks.ts`, `/api/mocks/*`): mocks apply only inside `relay()`, for routes to dev servers dx runs (the proxy and the localhost door), never to page loads, and never forward anywhere. Every route takes a known project's `dir`; status 100–599, delay at most 30 s, content type checked (no CR/LF), body at most 1 MB and valid JSON when the type says so. Mock files are 0600 under `~/.dx/mocks`. Mocked answers are recorded with `mocked: true`.
- **The AI lane** (`ai.ts`, `/api/ai*`, `/api/dev/takeover`): the feed is read from `runs.jsonl` (`mcp.*` records from source `mcp`), which the MCP server writes through `mcp/src/calls.ts`: only arguments on its fixed list are summarised (bodies, headers, notes, journal text and database queries are counted, never kept), addresses go through `maskUrl`, and from a result only numbers are kept, never its text (`.env` values, query rows). `POST /api/ai/interrupt` stops only dev servers dx runs whose `startedBy` is `ai`, of the `dirs` sent when there are any; `POST /api/dev/takeover` takes a known project's `dir` and only relabels its running AI-started server as the dashboard's. `GET /api/ai?dir=` takes a known project's `dir`.
- **The Requests page** (`apilab.ts`, `intercept.ts`, `labapi.ts`, `/api/lab/*`, `/api/mocks/server|purge|ai`):
  - **Rules** apply only inside `relay()` to calls for dev servers dx runs, never to page loads or `/__dx/`; they never change where a request goes (it always goes to the route's own port, with dx's `host`). `cleanRule` keeps known fields only: methods from a list, header names checked, no CR/LF in values, never `host`, `content-length`, `transfer-encoding`, `connection`; JSON paths refuse `__proto__`/`constructor`/`prototype`; delay at most 30 s, bodies at most 1 MB. Rule files are 0600 under `~/.dx/rules`.
  - **Intercept** holds items in memory only (real headers and bodies, so they can be edited), at most 50, each sent on unchanged after 60 s; never written to disk, a log or `runs.jsonl`. Edits are checked like the Repeater's.
  - **The Repeater** sends only to the project's route (`localRoutes()`: a dev server dx runs) with a path that starts with one `/`; never a host from the request. Header values with `•••` (masked by dx) are refused; its history is in memory and masked like the network log.
  - **A spec** is read from a file inside the project (`readProjectSpec`: no `..`, not under `node_modules`, a plain file, at most 5 MB), from the project's own route on this computer (one of `SPEC_URL_PATHS` or a path), or pasted; kept 0600 under `~/.dx/specs`. The YAML reader refuses anchors, aliases and tags.
  - **The mock server** listens on 127.0.0.1 only and answers only from the project's mock file; it never forwards. CORS headers only for loopback and `*.localhost` origins. `<project>.mock.localhost` is answered by the proxy from the same mocks.
  - **The cache** keeps real answers (2xx–4xx, not redirects, at most 512 KB) as mocks, masked like the history.
  - **AI data** (`aicli.ts`) runs `claude -p` or `codex exec --sandbox read-only` in an empty temp folder with fixed arguments, only on a click; the prompt is built by the server from the mock and the spec, plus the user's note. The answer is only ever used as JSON for the mock's body.
- `server.test.ts`, `stack.test.ts`, `activity.test.ts`, `mocks.test.ts`, `apilab.test.ts`, `frontdoor.test.ts` and core's `dxbrowser.test.ts`, `bugbundle.test.ts`, `mocks.test.ts` and `apilab.test.ts` cover all of this. Run them after touching these files.

## No setup

Every feature must work without the user configuring anything. If something needs setting up, dx does it (first run, or when the dashboard starts); if it can't, `dx doctor` gives the exact fix command in its `fix` field, which AI agents receive through the `dx_setup_check` MCP tool. Tests never touch the real machine's AI tools: pass an `AiEnv`, and set `autoConnectAi: false` in test configs that start a background dashboard.

## The dashboard's front end

- `public/app.js`: hash router, one function per page, helpers `api()`, `h()`, `append(el, ...children)`, `btn()`, `toast()`, `confirmDialog()`, `segmented()`.
- `public/styles.css`: CSS custom-property tokens at the top (light, dark via `prefers-color-scheme`, and `[data-theme]` overrides), 4px spacing base, breakpoint 860px. Use the tokens; don't add literal colours or spacing.
- Status colours carry the CLI's meanings: ok green, warn yellow, danger red, accent cyan.
- Destructive actions (kill, delete) always go through `confirmDialog()` naming what will happen.
- **Data is shown Visual first, with Raw one click away.** Anything a developer reads in detail (payloads, headers, stacks, console output, logs) goes through `liveDetail()` with the shared viewers: `requestDetail()`, `bodyBlock()` (JSON tree, form table), `headersBlock()`, `stackBlock()` (frames, library frames folded, `openAt()` for your own), `consoleBlock()`. Raw is always the exact text, and every part has `copyButton()`. The choice is one dashboard-wide preference (`detailMode`). New pages reuse these rather than printing raw text into a `<pre>`.
- A button handler that awaits (a dialog, a fetch) keeps `ev.currentTarget` in a variable first: it's gone after the first `await`.

## Public repository: nothing personal

This repo is public and open source. Never commit real names, emails, usernames, machine paths (`C:\Users\<name>\…`), tokens, or the names of anyone's own projects, in code, comments, tests, docs or examples. Use neutral examples (`todo-app`, `shop-website`, `octocat`, `/path/to/dx-toolkit`, `~`).

**Commits are the maintainer's alone.** No `Co-Authored-By` trailers, no "Generated with" lines, in commit messages or pull request descriptions.

## Before you finish

- `npm test` passes.
- README updated if a command, option, page or MCP tool changed.
- `docs/MEMORY.md` updated if a decision was made or the backlog changed.
