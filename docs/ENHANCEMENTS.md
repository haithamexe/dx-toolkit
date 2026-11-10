# Enhancing what dx already does

Researched 10 Nov 2026 from five angles: local running and machine setup, debugging and observability, git and pull requests, AI agents and MCP, and an audit of dx itself (measured on a maintainer machine with 22 projects). The rule: **make existing features better, add nothing new.** Each item names the feature it improves, where the idea comes from, and its size (S = hours, M = a day or two, L = a week). Items from other tools were read from their docs or, where marked *snippet*, only from search results: check the source before building.

## Batch 1: foundations (all small, low risk, felt every day)

**Done** (Nov 2026, unreleased). What differed from the list: #1 caches the project list, not the config (reading the config costs 0.1 ms and callers change what it returns); the focus and reduced-motion gaps in #7 were already covered by global rules, so only the dialog queue, its labels and the error role changed; #8 trimmed descriptions and added narrowing hints (`bodies` and `limit` already are the concise/full switch); #9's jobs maps already capped themselves, so they share one `trimJobs` helper and the route tables are merged and checked.

| # | Enhancement | Evidence | Size |
|---|---|---|---|
| 1 | **Cache the project scan and config** (short TTL keyed by the config file's time; dropped on save, clone, new project, add-root). The membership check stays. | `scanProjects` 17 ms, run for every route that takes a `dir` and by two watchers every 60 s, on the event loop | S-M |
| 2 | **Poll only while the page is visible**: one `poll(fn, ms)` helper that pauses when hidden and refreshes at once on return. | 5 `document.hidden` checks in `app.js`; the app opens minimised at sign-in and polls all day, which also stops the background dashboard from ever idling out | S |
| 3 | **Static files with an ETag and gzip, cached in memory.** | 591 KB of JS and 102 KB of CSS re-read and re-sent on every load (`no-store`) | S |
| 4 | **A page that throws shows an error and Retry, not a blank area**; add a JS syntax/type check to `npm test` and CI. | `render()` has no try/catch; nothing checks `public/*.js` | S |
| 5 | **Honest "dx isn't running" message** with a Start dx button and one offline banner, instead of "Is `dx ui` running in your terminal?" and about 100 silent `catch {}` in pollers. | `app.js:19` | S |
| 6 | **One `writeFileAtomic`** for every state file; make the `runs.jsonl` trim safe against appends from MCP processes. | config, dashboard info, Floppy, seed, scaffold, prepare, AI setup write in place | S-M |
| 7 | **Dialogs and toasts for screen readers**: queue `confirmDialog` (a second call today strands the first promise), label the dialog, errors as `role=alert`, visible focus on `.main` and agent nodes. | `app.js:169`, `index.html:33`, 3 `:focus-visible` rules | S |
| 8 | **MCP tool answers that steer the agent**: `detail: concise \| full` on the big tools, every truncated answer ends with how to narrow it, descriptions cut to about 300 characters (longest are 970), tools listed in a fixed order. | Anthropic's *Writing tools for agents*: concise answers used 72 tokens against 206 | S per tool |
| 9 | **Fail loudly on duplicate routes** (one merged route map built at start, with a test) and a shared capped `JobStore` for the jobs maps (visual's never forgets). | ten route tables chained with `??` | S-M |

## Batch 2a: speed and freezes

**Done** (Nov 2026, unreleased), from measuring every GET route on 22 real projects. The Env audit, the tour and the doctor's npm check no longer hold the dashboard up; the Summary's GitHub search runs while commits are read; Activity polls read the end of the file. Not done, on purpose: caching the health check (its answer includes the config, which changes when Settings saves) and the Summary (a stale answer right after a commit would confuse); the unsaved-work list was already parallel and costs its git spawns (about 1.6 s for 22 projects).

## Batch 2: accuracy and less noise in features people use

**Errors and debugging**
- **Group errors by the app's own frames**, not line numbers, and show "grouped because…" with Merge/Unmerge. Today one edit above an error splits its group. (Sentry grouping docs.) M
- **Error states: new, seen, resolved, back again after commit X** with a toast only for new and back-again. (PostHog alerts, *snippet*.) S-M
- **Visual diff stability**: capture again until two frames match, and per-page "ignore this region" masks kept as selectors, an ignore applying to one commit only. (Vitest visual testing, Argos, Chromatic: *snippets*.) S + M
- **Mock drift**: when a call was forwarded to the real server, compare its masked shape with the mock and mark the mock stale, with "re-record from the cache". (MSW, WireMock: *snippets*.) M
- **Repeater**: a visible "send through my rules and mocks" toggle (off by default), decode query and form parameters in the request view, host:port filters, and "compare with the recorded answer" ignoring ids, dates and `•••`. (Proxyman, Chrome DevTools 152.) S + M
- **Agents' view of the activity log**: a summary answer (slowest, failing, repeated N+1) instead of 2,000 events. (Chrome DevTools AI assistance.) S-M

**Running things**
- **Declared readiness** per service (`ready` in `.devrc.json`: http path, port, command or log match) shown on the card ("ready: GET /health 200"), with defaults for `/health` and `pg_isready`. Replaces "5 s up, 2.5 s quiet". (Tilt, Nx 24, Compose.) M
- **Service kinds**: `oneshot` (migrate, codegen: done means success) and restart-on-failure with a capped back-off and a "crash loop" state; restart one service or those matching. (Overmind, Compose.) S-M
- **Stack order from the project's own `dependsOn`** (turbo.json, nx.json) over the guessed roles, drawn as a small graph with what each service waits for. (Turborepo, Nx.) M
- **Log filter per service**, error/warn level, pause on scroll, "jump to first error"; `dev_logs` gets a `service` filter. (Tilt, Nx terminal UI.) S
- **Named domains**: a `<branch>.shop.localhost` for a snapshot, a "domains" section in `dx doctor` (proxy port, resolution, routes to dead ports to prune), a per-project "run without a domain". Not borrowed: tunnels, LAN mode and hosts-file editing (they break loopback-only). (portless README; the project's own status is unclear, so treat it as a reference.) S-M
- **`dx machine`**: a read-only check of the export against this computer that exits non-zero, `restore --plan`, each exported entry saying why it was recorded, per-platform entries. (mise lock, `brew bundle check`.) M
- **Prepare phases named on the card**: once per clone, when files change, every start, with the hash that decided "skipped". (Dev Containers.) S
- **`dx doctor --project <name>`** and `--json`. S

**Git and pull requests**
- **`--force-if-includes`** next to the lease (git 2.30+), with "N commits on the remote you don't have, M of yours rewritten" before the confirm. S
- **Release notes grouped** by `feat:`/`fix:` prefixes and PR labels, bots and merges left out, and `!`/BREAKING CHANGE giving a major bump. S-M
- **Write message** detects the repo's convention from recent subjects and lints length, mood and stray trailers, as a warning. S
- **PR proof** gets a changes table and a review-effort estimate from git alone, above the evidence. S-M
- **Conflicts**: show the base pane beside ours and theirs, build blocks from zdiff3 (smaller hunks), and offer `rerere` once, saying what it records. S + M
- **A failing commit hook** shows its output in the commit panel with fix and retry; names Husky or Lefthook; never a one-click `--no-verify`. (Lefthook, GitHub Desktop 3.5.5.) M

**Agents and MCP**
- **Read agent state from `claude agents --json` first** (a supported contract with `state`, `status`, `waitingFor`) and keep the file reader as a fallback. S-M
- **Agents page grouped as a review queue**: Needs input first with the wait time, then Working, Ready for review (PR label from `gh`), Completed, plus state filters. (Claude Code agent view.) M
- **Collapse same-type subagents** into one counted node with a Tree/Timeline switch. (Langfuse agent graphs.) S-M
- **Optional slim tool set** (`dx mcp --slim` or groups) and a `file` option that writes long output to `~/.dx` and returns the path. (Playwright MCP, Chrome DevTools MCP.) S-M
- **A "Copy as prompt"** beside Copy as bug report, reusing what Ask Claude to fix already builds, masked and size-capped. (Playwright.) S

## Batch 3: bigger, worth doing deliberately

- **Undo any journal entry, with restores themselves undoable, and a read-only "show the graph as it was then"; a Timeline list on History; Redo.** The journal only undoes the newest entry today. (GitButler oplog, jj operation log, lazygit.) M
- **Activity reads from the tail of the day's file** with a small in-memory ring for "what's new" polls. Today's file is 30 MB and one read takes about 135 ms on the event loop, 3-second polling. M
- **Split `app.js`** (11.8k lines; `gitPage` alone 2.2k) into ES modules, core first, then a page each. `script-src 'self'` allows it. L, low risk when mechanical.
- **Hooks as the source for waiting and stuck** (an opt-in `http` hook to loopback keeping only tool name, ids and timing) instead of guessing from file times. M
- **Cost and context numbers** from Claude Code's statusline JSON written to a small file (no transcripts), shown on nodes and in Floppy. M
- **MCP tasks** for the long tools (`run_tests`, `try_upgrade`, `visual_diff`), only for clients that declare it; **elicitation** for `dx_do_risky` where supported. Check the pinned SDK first. M-L
- **Timeline per visit with a dragged range** that filters requests, console, queries and server lines (Playwright trace viewer). M; screenshots at the failing step are L and need masking.
- **Tests where secrets and parsing live**: `mask`, `rules`, `openapi`, `yaml`, `versions`, `status`, `devport`, `terminals` have no test file by name (31 of 80 core tool files); plus a headless smoke test that opens each route and fails on a console error, and `npm run test:quick`. M

## What dx already does better than all of these

Everything is masked before it's stored and stays on the computer; recording needs no extension or certificate; one timeline joins clicks, requests, queries and server errors and reaches agents through MCP; the undo journal and lease-only force push; the PR proof comes from measured evidence, not from an AI reading the diff; risky agent actions are guarded by a separate tool and checked inputs; the localhost door keeps the usual port; prepare-before-run guards migrations.

## Not worth borrowing

Flox and Devbox (a different install model), Docker Compose watch (no containers to sync into), Vibe Kanban (being wound down), any cloud session upload (breaks the local-only rule), tunnels and system trust-store changes without a click.

## Could not be checked

UX findings come from reading the code and CSS, not from rendering at 375 px. Event-loop lag under load wasn't measured, only per-call costs. macOS and Linux behaviour wasn't run. Items marked *snippet* were seen only in search results.
