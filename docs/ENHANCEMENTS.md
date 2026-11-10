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

## UX batch: faster to use, and more fun

**Done** (Nov 2026, unreleased): everything below. Seen in a real browser on 22 projects; the palette, a page-by-page load and the folder grouping are covered by browser tests. A review for less text and more automation followed (see below).

From two read-only reviews of the running dashboard on 22 real projects (task walkthrough with click counts; keyboard, 375/768/1280/1920 px, light and dark, states). The skip link and nav findings were checked in the code.

**Bugs worth fixing first (small):**
- The **skip link** (`href="#main"`) changes the route to an unknown page, so the app falls back to All projects. A click handler that focuses `main` instead.
- On narrow screens the nav links **have no accessible name** (`.nav-label` is `display: none`), the **current page is off-screen** in the scrolling bar (never scrolled into view), and the active item's label overlaps its neighbour.
- **Agents graph**: pressing Enter on a node redraws the SVG and focus falls to the page; **More menus**: Esc leaves focus on a hidden button, and tabbing out leaves the menu open.
- **Activity with the history off** shows the full toolbar over "Nothing recorded yet"; the real fix ("turn it on in Settings") is plain text 1,300 px down the Settings page.
- **Code**: clicking a file card shows its diff about 15,000 px below, under all 117 cards, so it looks like nothing happened. The Staged and Commit columns scroll out of view while you stage from the bottom of Changes.
- **Git page when its load fails** shows "Changes 0" next to the error, which reads as a real empty state.
- Control borders are **1.8:1 (dark) and 1.4:1 (light)** against 3:1; two light badges are just under 4.5:1; there is no `:active` press style; `spin` and `pulse` keep looping under reduced motion.

**Streamlined (existing screens, fewer steps):**
- **Ctrl+K / "/" palette** over the pages array and project list: jump to a page, switch project, "Run <project>"; plus `?` for the shortcut list. No global shortcuts exist today (the biggest speed win).
- **All projects**: Run is the one primary action; Open in editor and Terminal move into More (or show on hover and focus), and the name links to the project's Overview. The "not backed up" rows become links to that project's Code page.
- **Settings**: a "3 things need attention" strip first, passing checks folded, anchor chips (Settings, AI tools, Activity, Alerts), one name for the page ("Settings", not also "Health & settings"), copy buttons on fix commands.
- **Code**: show the diff beside the list (sticky right pane) or under the card, keep Staged and Commit sticky, group Changes by folder past about 30 files, trash icon only on hover or in a menu, and an accurate name on each card.
- **Mobile**: 44 px targets on coarse pointers, labels back at 640-860 px, wider Activity and Git on big screens.
- **Run for a stack**: per-service chips (postgres, app) that go green as each is ready.

**More fun (small, on what's there):**
- **Skeletons instead of spinners** with the final height reserved (the terminal select and the "not backed up" banner currently pop in and push content down).
- **Toasts with an action** (Push now, Undo, Open), a short slide-in, a check icon, pause on hover.
- **Floppy in the sidebar reacts**: the same seven pixel moods the desktop Floppy has (working while a dev server starts, a worried face on an error, asleep when quiet).
- **A small success moment**: all backed up, tests green, a commit landing.
- **Agents tiles as filters** ("waiting for you" highlights those nodes); tiles on one row.
- Quick press feedback and a 120 ms transition on buttons and nav links.

## Less, and automatic (the next big step)

The owner asked for a hard look at how much text and how many sections there are, and for everything to be automatic unless it truly can't be. Three fresh reviewers (a minimalist editor measuring every page, an automation auditor reading the code, and a first-time user) agree. What they found, measured on 22 real projects:

**Too much.** The tallest pages are Overview of a real project (1,009 words, 11 screens; the endpoint list alone is 184 rows), Summary (2,879 words, 8 screens), Machine (920 words, 6 screens) and Ports (546 words, 56 buttons); Settings has 10 sections. On Data, Tools, Activity, Cleanup and Dependencies the subtitle is longer than what the page holds. All projects prints about 66 controls. The README is 940 lines and about 19,000 words. Several things are said twice (the terminal picker on four pages, alert text on Env and Settings, "unsaved work" on two).

**Too manual.** About 25 things make the user press a button or copy a command that dx could do (Refresh and Check again in six places, Make mocks in four, Run audit, Scan again, Write the proof, Create .env, Add to .gitignore, Turn on the history, Save settings, every `fix:` command in Settings). Of 27 settings, about 19 have one sensible value and shouldn't be settings.

### The rules

- **Copy:** a page subtitle is at most 8 words or absent; no hint paragraph unless it prevents a mistake (one line, warning first); field hints are tooltips; an empty state is a title and one action; zero-state widgets ("0 calls, 0 broken, 0 problems") aren't drawn; buttons are one or two words; a path or command with a Copy button next to it isn't printed; each thing is said once.
- **Layout:** at most three blocks visible at first paint and about 1.5 screens; lists show 5 to 10 rows and "Show all N"; what needs attention first, otherwise one line ("All good"); one primary action per page, the rest in More; at most 4 sub-tabs; advanced options (seed, retention, depth, service and mount, fault chips) under a closed Advanced.
- **Automation:** dx notices (a project first seen, a dev server up, a commit, a lock-file change), does it, tells you afterwards, with Undo. A confirm dialog needs a real reason (irreversible, public, or a secret); a reversible action gets a toast with Undo. If dx can detect it, it never asks (roots, editor, terminal, GitHub user, spec, .env, ports). A setting with one sensible value is deleted. No Refresh buttons: data stays live, and a stale page is a bug. A doctor fix is run, not copied. Background work stays inside the security model and is recorded in `dx runs`.

### Phase 1: copy and defaults (small, safe, big visual drop). Done, except what is listed under "Left"

1. Delete or shorten every subtitle over 8 words and the hint paragraphs (about 15 subtitles; the longest is Break it's 40 words); move field hints to tooltips; drop zero-state widgets and the "nothing recorded" explanations; one-line empty states.
2. Collapse by default: Overview's API spec, About this project and Settings it needs (top 5 rows plus "Show all" for the endpoint, folder and commit lists); Machine's sections (a one-line strip of the four headline numbers, then only what needs attention; the fnm instruction once, not six times; tool paths in a tooltip); Summary lists capped at 5 with "Show more"; Settings opens on Checks only, the rest folded.
3. Say things once: one terminal picker (in Settings), one alert switch, one unsaved-work banner.
4. Delete settings that only have one sensible value (history, localhost recording, local domains and ports, history size, visual diffs, alert switches, scan depth, dev-server timeout, AI auto-connect and the like) and hide the few that remain (retention, depth, editor, terminal, GitHub user) under Advanced, auto-detected.
5. Turn the "history is off" page into nothing: it's on by default, and the only way to reach the off state is to have turned it off; show one line with a switch.

**Done:** 87 subtitles and hints cut or turned into tooltips (`pageHead` takes `[text, tooltip]`); empty paragraphs take no room (CSS `:empty`); Overview is the project, a one-line API spec and a closed "About this project" with closed parts and `foldRows` (5 rows, "Show all N", shared with Summary and Machine); Summary's lists are capped and its switches are in a More menu; Machine shows what needs attention and four closed sections with a one-line note each; Settings opens on the checks, the rest folded, Advanced inside Preferences, one alert switch; zero-state widgets are gone (Break it's "What broke", "Everything is backed up", Cleanup's reason line); the terminal picker is only in Settings.
**Left:** the one-value settings are hidden, not deleted (the keys stay in the config and `dx config`, so nothing that reads them changes); a separate pass is needed to delete them with their API fields, CLI flags and tests. The Env page and Settings still each say something about alerts. Break it, API and Activity have not had their advanced parts collapsed yet.

### Phase 2: automatic (each with Undo, recorded in `dx runs`). Partly done, see "Done in phase 2" below

- Live data instead of Refresh and Check again (the visible page polls, as the dev log does); `git fetch --prune` every few minutes for open projects (fixed arguments, never a merge or pull), shown as "3 behind".
- On a project's first sight: create `.env` from the example (never overwrites), add the missing `.gitignore` rules, scan for committed keys, and say so afterwards. No confirm.
- Dependencies audited in the background after an install or lock-file change and once a day, cached, as a badge; Cleanup scanned weekly as a badge (deleting still asks); the spec found on every dev-server start; mocks kept current from recorded calls (edited ones never overwritten); the visual capture on the first dev-server start when there's no baseline; the proof built when a branch has a pull request (adding it to GitHub stays one click); the commit message prefilled once AI is on; settings autosave with "Saved. Undo".
- Doctor fixes that dx can run itself (`dx setup`, reconnect AI tools, update shims, detect folders, editor and terminal) just run and say "dx did X"; installers that need a password stay in a terminal.
- Auto-journal from commits, releases and applied fixes; a weekly summary saved on its own.

**Done in phase 2:** `livePoll(fn, ms)` replaces the Refresh and Check again buttons (Overview, All projects, Ports, Machine, Env & secrets, Settings' checks, Code, Cleanup, Docker); Dependencies audits when opened or stale (6 h); Settings autosaves with an Undo toast; `git fetch --prune --no-tags` for projects with a dev server or a recently viewed Code page (`web/src/gitfetch.ts`); first-sight setup (`core/tools/autosetup.ts`: `.gitignore` rules for a new project with an exposed `.env`; existing projects are baselined, never touched); `autoFixConfig` (missing editor, no projects folder); journal lines for an applied fix and a release; a weekly summary saved on its own.
**Left in phase 2:** Undo for the `.gitignore` addition (it's an appended, commented block, visible in `git diff`); `.env` from the example is still made by Run's prepare step, not on first sight; background cleanup scan and the mock refresh, the visual capture on first start, the PR proof and the pre-filled commit message; the Env page and Create-mocks buttons that remain; the deps audit isn't scheduled when nobody has the page open.

### Phase 3: fewer pages (the sidebar goes from 13 items to about 7). Mostly done, see "Done in phase 3" below

1. **Projects** (the landing page): a searchable list with Run, status and badges; "+ Add project" (new, clone, from a template); opening one shows one page: Run, address, logs and errors, a banner for unsaved work and secrets, and tabs only when relevant. 2. **Git** (was Code). 3. **Requests**, shown when there's history or a spec: activity and the API pages, with Rules and Intercept behind More. 4. **Stress test** (was Break it), shown while the server runs: slow network, click everything, another date, slow phone; the rest under More tests. 5. **Computer**: tools, ports, cleanup, dependencies, Docker, as collapsed sections of one page. 6. **Summary** with the Journal as an add line. 7. **Settings**: Setup, AI tools, Preferences; Advanced holds the rest.
Shown only when they have something: Agents (as the existing edge tab while an agent works), Tools (once one exists), Data (when a schema is found). Env & secrets becomes a warning badge with a one-click fix.

**Done in phase 3:** the sidebar is Projects (This project and All projects as tabs), Git, Requests (API and Activity as tabs), Stress test (while the server runs), Computer (Machine, Ports, Cleanup, Dependencies), Summary (Journal as a tab) and Settings; Tools, Data, Secrets and Agents show only with something in them (`GET /api/nav`: counts, no names; `pageShown`, `when:` on a page); old names stay searchable (`aka`); tab labels renamed; README is 66 lines and the rest is in `docs/`.
**Left in phase 3:** Requests' Rules and Intercept behind a More menu (they're tabs, renamed); Journal as an add line on Summary; Env and Break it keep their own pages rather than a badge with a one-click fix; the in-page headings and buttons still use some old words (Repeater, Gremlins, Weak phone and so on in text, the CLI and MCP); a project page's opening state with several tabs is not yet trimmed.

### Words

Plainer names: Spec & mocks, Mock server, Mock mode become API docs, Fake API, Use fake answers; Repeater, Rules, Intercept become Resend a request, Change requests, Pause requests; Sessions become Page visits; Behaviour diff, Graveyard, Gremlins become Compare with an earlier version, Unused code and routes, Click everything; Clock, Weak phone, Languages become Another date, Slow phone, Long text; Scenes, Snapshots, Proof, Bug bundle become Saved data sets, Run an old version, Pull request summary, Shareable bug file; Take over becomes Mine now; "Not pushed anywhere" becomes "Not on GitHub yet"; This computer, Code, Look back, Env & secrets become Computer, Git, Summary, Secrets. The route ids stay, so links keep working.

### README

About 120 lines: the pitch, install, five things you can do with one screenshot, a docs index, troubleshooting. The CLI reference (about 250 lines), the MCP list, the architecture, the feature deep-dives, Raycast and the contributor sections move to `docs/` and are linked.

One note on the reviews: the first-time reviewer saw the Activity history off, because the demo instance's throwaway settings turned it off; the real default is on.

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
