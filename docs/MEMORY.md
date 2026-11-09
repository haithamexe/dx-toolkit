# Project memory

What was decided while building dx, and why, so the next session doesn't relearn it. Newest first within each section. Update it when a decision is made or the backlog changes.

## Where it stands (Nov 2026)

- CI is green on Windows, macOS and Linux × Node 22 and 24.
- **On npm** as `dx-devkit` since 1.1.0: `npm install -g dx-devkit`.
- **Built**:
  - the Chaos page (Chaos mode, Gremlins, fake clock, weak phone, languages, missing .env values, behaviour diff, the graveyard, Security) and `dx chaos`, `dx attack`;
  - the Tour page and `dx tour`; proof for the pull request (`dx proof`); trying an upgrade in a copy (`dx try`); queries per request (`dx queries`);
  - the Data page (realistic data and scenes) and `dx data`; Open on my phone and `dx phone`; speed and accessibility per commit;
  - the Tools page (a project's own tools, made in a chat, run without AI) and `dx tools`; .env alerts; your dx on another computer (`dx state`);
  - the core tools;
  - Floppy, the desktop assistant on the Windows taskbar (`dx floppy`), and the dx app: the dashboard in its own Electron window, installed on first use, opening at sign-in on Windows (`dx ui`);
  - the `dx` command: `ui, floppy, go, run, resume, up, down, new, clone, projects, status, port, kill, log, summary, clean, deps, test, env, db, logs, errors, fix, traffic, activity, bug, mock, tools, terminal, git, chaos, attack, data, queries, phone, tour, proof, try, prepare, visual, machine, browser, sites, setup, https, config, state, runs, doctor`;
  - the MCP server with 49 tools, 25 of them for running, checking and breaking apps, and three (`dx_actions`, `dx_do`, `dx_do_risky`) for every dashboard action;
  - stacks and local domains (`shop.localhost`), with opt-in https;
  - the dashboard, arranged by intent: a project switcher, then that project's Overview (with its tour), Code, API, Activity, Tools, Data, Break it and Env & secrets; under Everything, All projects (and New project), This computer (Machine, Ports, Cleanup, Dependencies) and Look back (Summary, Journal); Settings;
  - the activity history (requests, routes, clicks, console, errors, kept 7 days), for deployed sites too through the dx browser, and opening projects in a terminal you pick;
  - error detection in dev-server output, and in the browser (headless check);
  - clone-and-set-up, where you left off, unsaved work, `.env` and secrets checks, `dx deps --fix` (yarn and bun too);
  - tests read from each framework's report, a network log from the proxy, browser flows, read-only database queries, the year in review;
  - setting itself up with no configuration.
- **Latest release**: 1.9.0.
- **This is a public, open-source repository.** Nothing personal goes in it: no real names, emails, usernames, machine paths or names of anyone's own projects. Examples use neutral names (`todo-app`, `shop-website`, `api-gateway`, `octocat`), paths use `~` or `/path/to/dx-toolkit`, and test fixtures are built in temp folders.

## Backlog

- **Your own tools, not yet tried**: a chat with the real Claude Code or Codex (only the stand-in in tests; the maintainer's agent wasn't run during development); running a tool from the terminal (`dx tools` lists, exports and imports only); a watch's system notification (watches speak in dx and on Floppy's line only).
- **.env alerts beyond Windows**: the macOS (`osascript`) and Linux (`notify-send`) notifications are written from their documentation; only the Windows toast was seen.
- **Your dx on another computer, next**: a project in the file that isn't on this computer is left out; offering to clone it (it has its remote) would finish the move. The Settings page's Undo button wasn't clicked through in a rendering window (the pane was hidden, so the dialog's close event never fired); the route, the CLI and the tests undo for real.
- **Raycast**: the extension type-checks (six commands, Work Summary and Clean Up Projects added), but has never been run in Raycast itself.
- **`dx https` end to end**: the proxy's https is tested with a throwaway openssl certificate; the real `mkcert -install` path hasn't been run on a maintainer machine (it changes the system trust store, so it needs the maintainer's go-ahead).
- **Coverage in `dx test`**, and screenshot comparison before and after a change.
- **Terminals beyond Windows**: Command Prompt, Windows PowerShell and Git Bash were opened for real on Windows; the macOS (iTerm2, Warp, Ghostty, kitty) and Linux launch commands are written from each one's documentation and haven't been run on those systems.
- **The localhost door for stacks**: single-project dev servers are recorded at `localhost:<port>`; a stack's front end isn't moved yet. Next.js, Astro, Nuxt, Angular, webpack and Gatsby are moved by the documented flag but only Vite was tried for real.
- **MongoDB in `dx db`**: only Postgres, MySQL/MariaDB and Redis today.
- **The dx app, not yet tried**: pinning it to the taskbar, a real sign-in start from the Startup shortcut, and a real Electron update (the parts were checked on Windows: installing into its own folder, moving `current` while an app runs through it, and the EBUSY check). macOS and Linux (dx.app with plutil and an ad hoc signature, the LaunchAgent, the autostart and launcher entries, `setDesktopName`) are written from Apple's, freedesktop's and Electron's documentation and covered by tests of what's written, but have never run. Checked on the maintainer's machine: the window, its taskbar icon, the Start menu entry (`dx`, with its taskbar id), the Startup shortcut, `dx.exe`'s name and icon, and Floppy coming with it; in a throwaway `DX_HOME`: the stopped page, the minimised start, the security checks and remembering the window's place.
- **Floppy beyond Windows**: the window is WPF, so macOS and Linux need their own (`dx floppy` says so there). On Windows the maintainer tried it by hand and it works.
- **Machine, next parts**:
  - caches (npm, pnpm store, yarn, bun, pip, Go, Gradle, Xcode DerivedData) on the Cleanup page, through each tool's own clean command;
  - developer setup checks in `dx doctor` (git name and email, line endings and long paths on Windows, SSH key, `gh` signed in, PATH with missing folders or two Nodes, the Linux file-watch limit, WSL);
  - `dx machine export` / `restore` for moving to a new computer;
  - a warning on the Projects page before Start when a project doesn't match this computer.
- **Machine beyond Windows**: the process list (`ps`), services (`brew services`, `systemctl`) and update commands for macOS and Linux are written from each tool's documentation and covered by parsing tests, but have only run for real on Windows.
- **The dx browser, not yet**: a visible window wasn't opened during development (the pipe, attaching and recording ran headless on Windows, with Chrome; Edge's pipe answered too); macOS and Linux only through the headless test on CI. Requests from service workers, and a page opened by a link in a new tab before dx has attached to it, can be missed. No WebSocket frames, and the `Set-Cookie` that DevTools' first response event leaves out isn't seen (it would be masked anyway).
- **yarn Plug'n'Play** projects have no node_modules, so `dx deps` can't read installed versions there.
- **Releases**:
  - **1.0.0** was a GitHub-only release; its tag is `1.0.0` on the same commit as `v0.1.0`.
  - **1.9.0** adds several API specs per project, the Agents page (a node graph of sessions and subagents), MCP resources, prompts and structured results, and `dev.*` actions so an AI agent can develop dx.
  - **1.8.0** gives AI agents every dashboard action (`dx_actions`, `dx_do`, `dx_do_risky`), and two projects on one usual port each get their own.
  - **1.7.4** runs the Tools chat like a normal Claude Code or Codex session, and the other AI buttons without tools in one turn.
  - **1.7.3** replaces a background dashboard from an older dx after an update, starting its dev servers again.
  - **1.7.2** finds npm's `claude` and `codex` as their `.cmd` shims on Windows.
  - **1.7.1** takes the length limit off the tool chat.
  - **1.7.0** adds a project's own tools (the Tools page and `dx tools`), .env alerts, and your dx on another computer (`dx state`).
  - **1.6.0** arranges the dashboard by intent (a project switcher, then that project's pages), splits Code into Save, Share, Release and History with GitHub releases through gh, finds an API spec for every project, and adds the line beside Floppy and Run Floppy.
  - **1.5.0** adds the dx app (the dashboard in its own Electron window, opening at sign-in) and Floppy, the new look, the Git page, the Machine page, Chaos, Data, Tour, proof for pull requests, trying an upgrade, queries per request, Open on my phone, Run any commit, the dx browser and recorded sites, Ask Claude to fix, the AI lane, Your year and visual diffs.
  - **1.4.0** adds the Env & secrets page, recording at `localhost:<port>` (the localhost door), and the Activity views.
  - **1.3.0** adds the activity history (with Replay and bug reports), opening projects in a terminal you pick, `dx test`, the network log, browser flows, `dx db` and the year in review.
  - **1.2.0** adds browser errors, `dx clone`, resume and notes, `dx status`, `dx env`, `dx https` and `dx deps --fix`.
  - **1.1.0** is the first on npm, as `dx-devkit`. npm refused `dxkit` as too close to existing names (degit, pdfkit). A free name (`npm view <name>` gives E404) can still be refused: the look-alike check only runs on a real publish, and short names fail it most.
  - **Nothing is released until the maintainer says the features are done.** New work is built, committed and tested locally first; the maintainer's own `dx` runs this repository's build (`npm run link`) so they try each feature before it goes out. No release or npm publish after a single feature.
  - **To release**: add each change to `CHANGELOG.md` under *Unreleased*. When a release is asked for, the agent doing it carries it through, publishing included:
    1. wait for CI to be green on the last commit;
    2. bump every `package.json` (and the lockfile), and move *Unreleased* to a dated `## X.Y.Z` section with a one-line intro;
    3. `node scripts/check-electron.mjs` (the dx app's Electron is the newest of its line; bump `ELECTRON_VERSION` and try the app if not), `npm run release`, then `node scripts/smoke-package.mjs`;
    4. commit "Release X.Y.Z", tag `vX.Y.Z`, push both;
    5. **`.github/workflows/release.yml` does the rest on the tag**: checks the tag against every `package.json` and the changelog, runs the tests, builds and test-installs, `npm publish ./release --provenance`, installs it back from npm (`smoke-package.mjs --from-npm`), and `gh release create` with that changelog section (`scripts/release-notes.mjs`) titled "dx X.Y.Z". Re-running skips what's done;
    6. the agent watches that run and confirms the version on the registry (`https://registry.npmjs.org/dx-devkit`) and the GitHub release.

    **npm trusted publishing** (OIDC) means no npm token anywhere: npmjs.com's package settings name this repository and `release.yml`, set up once by the maintainer. The workflow upgrades npm (trusted publishing needs npm 11.5.1+). By hand, as a fallback, uses the maintainer's own logins on their machine; the agent never logs in or handles a token itself. npm answers a publish without a login with **404 Not Found**, not 401; so does a publish from CI before trusted publishing is set up.
- **README screenshots** (`docs/images/`) come from made-up demo projects under a neutral author (`octocat`, `octocat@example.com`), never from real projects. Retake them the same way when a page changes:
  - **A demo dashboard** with `DX_HOME` in a temp folder, `autoConnectAi: false`, `GITHUB_TOKEN`/`GH_TOKEN` unset and no GitHub remotes (so the Summary fetches nobody's pull requests). Servers started through `POST /api/dev/start` (`by: "ai"` for the AI one); the history, journal and `mcp.*` runs written as files (`appendActivity`, `callRecord`).
  - **Paths read `~\dx-demo\…`** because the page shortens `C:\Users\<name>`: the projects are reached through a junction at `~/dx-demo`, removed afterwards with `rmdir` (the link only).
  - **Each demo repo has a local bare remote** it's pushed to, or the Projects page warns about unpushed work.
  - **Dates by mtime**: every working file first, then `git update-index --really-refresh`, then `.git/index`, `HEAD` and the folder. Dating tracked files after the index makes the dashboard's `git status` rewrite it, and every project reads "Active just now".
  - **Captured through core's `withBrowser`**, not `--screenshot`: `Emulation.setDeviceMetricsOverride` (1280 × 900 for Projects, 1280 × 820 for the rest, scale 1), `setEmulatedMedia` for `prefers-color-scheme`, `dx.aiLane = closed` in localStorage so the agent's lane is its edge tab, fonts ready, then `Page.captureScreenshot`. Dark for all, plus `projects-light.png` for the README's `<picture>`.
  - With port 80 taken (another dashboard), the `.localhost` addresses show `:1355`.

## Decisions

### Agent monitoring, MCP like other MCP servers, developing dx through MCP (`core/src/tools/agents.ts`, `web/src/agentsapi.ts`, `devtoolsapi.ts`, `mcp/src/index.ts`)

- **The maintainer asked to see what running agents are doing and how, with a node view of agents and subagents, and for Claude to be able to change dx and run things through it "like a normal MCP".** Answers to the questions: detect through Claude Code's session files, metadata only; MCP "both" (the standard features, and guarded actions to develop dx).
- **Agents are read from `~/.claude/projects/<folder>/<session>.jsonl` and `<session>/subagents/agent-<id>.jsonl` with `.meta.json`** (`CLAUDE_CONFIG_DIR` moves it). Files can pass 100 MB, so only the first 256 KB and the last 1 MB are read, cached by mtime and size (93 ms first read, 14 ms cached over 27 sessions and 70 subagents). **Fixed fields only**: tool names, model, effort, permission mode, entrypoint, cwd, branch, titles, times, stop reason, pending tool ids. Never a message, prompt, tool input or result. The answer does carry titles, a subagent's one-line task description (model-written, clipped to 80 characters) and the folder it works in, which the page and the `dx://agents` resource show. A subagent's parent is the transcript whose Agent/Task `tool_use` id matches its `toolUseId`. A cwd inside a known project is that project's.
- **Status is a guess from times, said as such**: working (written in the last 45 s, or a tool pending under 30 min), waiting (the session ended its turn, under 60 min), idle, done (a subagent that ended its turn, or older than 10 min), stopped (`stoppedByUser`).
- **The graph is SVG built with DOM nodes** (no `innerHTML`), laid out in tiers by depth, polled every 3 s; edges pulse only while the child works, and not under reduced motion.
- **MCP's standard features** were added to the existing server (SDK 1.32): resources (read-only, never start the dashboard), prompts with a completable project argument, and `outputSchema` plus `structuredContent` on `dx_do` / `dx_do_risky`. The tool count is unchanged (49); long actions stay jobs the agent polls (`dev.job`, chaos jobs) rather than MCP progress notifications, which need a client that asks for them.
- **Developing dx is `dev.*` actions in the catalog, not a new tool**, so it follows the existing rule: reads and builds through `dx_do`, `dev.write` and `dev.restart` through `dx_do_risky`. The repository is found, never given (the project whose package.json is `dx-toolkit` with `packages/core`); the commands are `npm run build` and `npm test`, one job at a time; a file is a relative path with no `..`, not under `.git`, `node_modules`, `dist`, `release` or an `.env*` name, a text extension, links never followed, writes at most 512 KB (a request is 1 MB, escaped), through a temp file and rename. Every change is a line in `dx runs`.

### Your dx on another computer (`core/src/tools/state.ts`, `web/src/stateapi.ts`, the Settings page, `dx state`)

- **The maintainer works on two computers and asked to carry "everything" between them, but not live things like commits.** So: what dx keeps that a person chose or made goes (settings, journal, saved summaries, templates, and per project tools, mocks, rules, a spec given by hand or removed, chaos settings, made and saved data scenes, the note, alert choices, recorded sites); what's live or this computer's own stays (git, the activity history and run log, snapshots, captures, caches, the dx browser's profile, certificates, the dashboard's token, `.env` files, backup scenes, a spec dx found by itself, the app's install, Floppy's place).
- **Projects are named by their remote, never a path**: `remoteKey` makes `host/owner/repo` (lower case, no user or password, `file:` remotes have none), matched first; then the folder name, unless both have remotes that differ. The import can map a project to another one here, or leave it out. Folders and the templates folder go only as `~/…` and are added only if they exist.
- **The file wins where both have something; nothing here is deleted.** Tools replace the same name (`importTools` with replace), mocks and rules merge by id, scenes by slug, journal entries are slotted in under their day (`mergeJournalText`, which leaves hand-written text where it is), a note only when newer. **Mock mode and Chaos mode switches stay as they are here**: carried across, they'd answer or break the app's calls on the other computer without being asked. The clock, weak phone and languages settings do come along; they're shown on Break it.
- **Undo is exact, not a re-import**: before the first write to each file, `Before` keeps its bytes (or that it wasn't there), and the backup in `~/.dx/state-backups` lists them, relative to `~/.dx` or the templates folder only. Undo writes them back or removes the new ones, then forgets that backup; the last 5 are kept.
- **Read like every other file from outside**: strict (unknown fields refused by name), each part through its store's own checker. `cleanMockEndpoint` was added to mocks for this: the same checks as an edit. An editor setting is a command dx runs, so one from a file must be a known editor name.
- **The page's preferences come along from the page only** (`STATE_PAGE_PREFS`, none holding a path): only the page can read its localStorage. The CLI's export leaves them out and says so on import.
- **Size**: at most 25 MB in all, templates 10 MB and data scenes 10 MB (what doesn't fit is named in `left`); the two import routes read up to 26 MB.
- **Found in review, before release**: the templates folder was a setting the file could bring, and templates were written there, so a file could write almost anywhere under the home folder (`~/.config/git/config`). It's no longer a setting a file carries: templates go into this computer's own folder. The backup was written last, so a failure part-way left no undo; now an import that stops part-way is put back at once (all or nothing), and the backup records the folders it wrote to. Two clones of one repository on the other computer could both land on the one here; now each project here is taken once, a name match first, and a lone clone only when no other project in the file has its name.

### .env alerts (`core/src/tools/envwatch.ts`, `web/src/envwatch.ts`)

- **The maintainer asked for a warning in text and sound, and from the system, each time a .env file changes, is staged or is committed, on by default, with a per-project switch for the system part or for all of it.**
- **Polled every 10 s from file times, with no git unless something moved**: each `.env` file's mtime and size every look (a folder walk for new ones every sixth look), git's index mtime for staged (`git diff --cached --name-only` only then), and the lines git appended to `logs/HEAD` since the last look for committed (read straight from the file, so `commit && pull --rebase` in one tick still counts the commit). "Committed" is a reflog entry starting with `commit`, so checking out a branch that has a `.env` isn't reported as committing one. The first look at a project only remembers. "Changed" is said at most once per 10 s per project.
- **The system's notification never goes through a shell**: Windows runs dx's own PowerShell script from stdin with the words in environment variables (a toast under the dx app's id when its Start menu entry exists, else PowerShell's), macOS `osascript` with arguments, Linux `notify-send`. Nothing is sent while `DX_HOME` is set, so tests and demo dashboards stay quiet. Checked on Windows: the toast shows.
- **In dx**: a warning toast with a short sound made with WebAudio (no file to ship), from the page's 5 s checks, and Floppy's line (the alert block in `floppyView`, two minutes).

### Your own tools (`core/src/tools/customtools.ts`, `web/src/toolsapi.ts`, the Tools page, `recorder.js`'s page tools)

- **The maintainer asked for tools made in a chat but run without AI afterwards, kept with the project, editable, deletable, importable and exportable.** Asked how a tool is expressed, they picked **building blocks** over AI-written code: a tool is JSON in dx's own vocabulary (sources, steps, expressions, displays, matches), so dx can check it completely and nothing it runs was written by the AI.
- **Six kinds**: view, watch, operation (asked for first), then answer, page and column when the maintainer asked for tools that change things, and chose all three places offered: the app's API answers, the app's pages, and dx's own pages.
- **Expressions are a small JSON language** (`{"mul": ["price", "qty"]}`, `if`, `concat`, `default`…): a string is always a path, literal text is `{"value": …}`. That one rule keeps the chat's answers unambiguous; it's in the guide the agent gets.
- **The chat is like talking to the agent yourself**, at the maintainer's request after "Reached max turns (1)": `claude -p` with no turn limit, its own tools and the user's MCP servers, in the project's folder, with no time limit (`free` in `askAi`/`runClaude`); Codex the same, with its default sandbox. Claude Code's own permission rules still apply, and in `-p` nobody can approve, so it reads but changes nothing; `--dangerously-skip-permissions` was not used. The prompt asks it to look at the code but change nothing, and its final answer is still checked by `cleanTool`. dx's guide (every block with an example of each kind) plus the project's spec endpoints and recorded calls with one answer each, masked, go in on stdin; the answer's JSON must pass `cleanTool`, or dx sends the problem back once. The model and effort are picked beside the chat (remembered per computer); Codex has no `xhigh`/`max`, so those ask for `high`. No limit on a message's length: the maintainer had a long text to paste, so the chat (message and history) has no size limit at all (it's read only after the token, Host and Origin checks). How much the agent itself can take is up to it.
- **Answer tools are the rules' plan**, applied in `relayWithRules` after the rules' edits, and labelled `tool: <name>` in the history. Their preview asks the dev server directly (the Repeater's sender, which bypasses rules and mocks) for a plain GET, since the history already holds answers as the tool changed them.
- **Page tools ride the recorder script**: only the changes, without their sources, go in front of it; the data comes from dx on the page's own origin, so the page never learns where it's from and nothing crosses origins. Changes are reapplied after the app redraws (a MutationObserver, debounced), marked `data-dx-tool`.
- **Activity's API list measures itself** for the tools' columns, and its narrow layout became a container query: the projects column beside it meant a wide window could still leave the list narrow, and the endpoint was squeezed to a letter (seen while trying the page). Without room, a tool's value sits under the endpoint.
- **Stored per project** like mocks (`~/.dx/tools/<name>-<hash>.json`, 0600, temp file and rename); the proxy rereads them when the file's time or size changes.
- **Found in review, before release**: watch toasts are tracked by the newest event id the page has seen, not by time (a slow request's time is when it started, so it could be older than one already shown and be missed, or one shown twice). An answer a tool changed is labelled in the history and never cached or made into a mock as the server's; the preview of a templated target reads only answers no tool changed. Page tools put the app's styles back and remove their columns when the app moves to a page they aren't for. In a chat, the tool so far goes to the agent with its credential headers hidden (`hideToolSecrets`) and put back in the answer; bodies go as written. An exported tools file holds headers and bodies as written, so it's 0600 and says so.


### The dx app (`core/src/tools/appshell.ts`, `shortcuts.ts`; `web/src/app.ts`, `shellrules.ts`, `ensure.ts`, `appinstall.ts`; `web/shell/`)

- **The maintainer asked for the dashboard to be an application, not a web page, and offered Electron.** An Edge `--app` window (what `dx ui --app` was) still shows Edge's title bar and menu and shares Edge's taskbar group; Electron gives a window of dx's own, its own icon and taskbar id, a Start menu entry that pins as one icon, and a sign-in start. Floppy stays WPF: it's a 48-pixel sprite, and Electron would add nothing there.
- **Electron is installed on first use, not shipped**: one pinned version (`ELECTRON_VERSION`) into `~/.dx/app` with `npm install electron@<v>` and fixed flags (`npm_config_global`/`prefix`/`location` taken out of the environment, so a dx run by `npm run` doesn't install globally). A 100 MB download, about 370 MB installed; 23 s on the maintainer's machine. The npm package stays small, core keeps no dependencies, and dx updates don't download it again. When npm skips install scripts, dx runs Electron's own `install.js`. A lock folder keeps two installs from racing. Behind a firewall, `ELECTRON_MIRROR` works as Electron documents.
- **The window is a folder Electron runs** (`web/shell`: a package.json without a version, so releases don't need to bump it, and an ESM `main.js`), plain JS since the repository doesn't install Electron's types. Its rules are in `shellrules.ts` (no imports, compiled to `dist`), so tests check them and the window imports them from `../dist`. A test parses `main.js` and checks every name it imports exists.
- **The window never sees the token**: it gets the dashboard's address from dx (`--url`), or runs `dist/ensure.js` with dx's own node (named in `~/.dx/app/launch.json`, written each time dx opens the app) to find or start it. The page gets the token from its meta tag as in a browser.
- **What's allowed**: only the dashboard's own http origin on loopback loads (`will-navigate`, `will-redirect`); `window.open` and links elsewhere go to `shell.openExternal`, http(s) only, without user:password; sandbox, context isolation, no node integration, no preload, no `<webview>`, spellcheck off (it downloads dictionaries on some systems). The only permission is the clipboard for the Copy buttons, on the dashboard's main frame: **Electron asks for `clipboard-read` even for `writeText`** (seen in its permission log), so that name is allowed there; the page never reads the clipboard. Checked over DevTools on the real window: no `require`/`process`, `file:` navigation refused, `window.open` denied, geolocation denied, the API still answers.
- **The dashboard runs in the background behind the app**, so `dx ui` frees the terminal; closing the window leaves dev servers running, and the background dashboard's 30-minute idle stop does the rest. The window polls `dashboard.json` every 3 s: a dashboard on another port is followed, a stopped one shows a static page (no script, its own CSP) whose **Start dx** link is `http://dx-app.invalid/start`, caught in `will-navigate` before any request. `--port` and `--no-open` still run the dashboard in the terminal.
- **Windows gives a program's first window the show state it was started with**: launched from a hidden process (the tool shell, Floppy's controller), the window came up minimised. After the first show, `settle()` puts it in the state it asked for, as Floppy's window does.
- **At sign-in it opens minimised** (`--minimized` in the Startup shortcut): dx is a click away without a window at every sign-in. The first `dx ui` adds the shortcut and says how to undo it, as Floppy's first run does, since the maintainer asked for it.
- **Two shortcuts, two writers**: the Startup one by dx itself (`shortcuts.ts`, shared with Floppy), the Start menu one by the app itself through Electron's `shell.writeShortcutLink`, since only that sets the AppUserModelID a pin needs to stay one icon. With `DX_HOME` set, neither is written: a shortcut can't carry it.
- **dx writes .lnk files byte by byte ([MS-SHLLINK])**, not through PowerShell and WScript.Shell: on CI's Windows runners that PowerShell took over 20 s and then hung past 60 s while the test suite ran, and it cost a PowerShell start on every `dx ui`. The file has the header, StringData (description, working folder, arguments quoted as CommandLineToArgvW splits them, icon) and the target in an EnvironmentVariableDataBlock (ANSI and Unicode), the way shortcuts to `%ProgramFiles%\…` hold theirs. A path in LinkInfo alone wasn't enough (checked: the shell found no target). Checked on Windows: opening it runs the program with every argument as written, and Windows then adds its own item IDs to the file (it grew from about 1 KB to 2 KB), after which the shell and WScript.Shell both show the target. Until that first opening they show it empty, since they read the item IDs; dx doesn't write those itself (building Explorer's item IDs by hand is fragile). So a shortcut that already says the same (`shortcutMatches`) is never rewritten, or each `dx ui` would throw Windows' additions away.
- **Floppy's icon became the app's**: `floppy.ico` now holds the 16-pixel art at 16, 32, 48, 64, 128 and 256 pixels (whole multiples, cropped out of its 18-pixel grid), plus `floppy-256.png` for other systems; `SPRITE_VERSION` 2 writes them again.
- **On Windows the app is `dx.exe`, not `electron.exe`**: Windows reads a program's name, company and icon from the program itself (Task Manager, the Startup apps list, the taskbar's menu), and the maintainer saw "Electron" there. rcedit (the Electron project's tool, `RCEDIT_VERSION`, installed with Electron by the same npm command) writes dx's name, company and Floppy's icon into a copy of `electron.exe` (`nameAppProgram`, fixed arguments); Electron's copyright line is left as it was. A copy, then a rename, because the running program is locked; `electron.exe` (250 MB) is removed once nothing runs from it. `program.json` keeps the Electron version and icon hash it was made from, so a new Electron or Floppy colour names it again. Same approach as Electron's own packaging tools.
- **Each Electron version has its own folder, and shortcuts go through a link**: `~/.dx/app/runtime/<version>` is an npm folder of its own, and `current` (a junction on Windows) points at the one in use; the Startup shortcut, the Start menu entry and sign-in entries start `current/dx.exe`, so their path survives updates. An update installs next to the running app (never in its folder), names it, moves `current` (checked on Windows: a program running through the old junction carries on), and old versions are removed once nothing runs from them. The layout before runtime folders (node_modules right in `~/.dx/app`) is one more install in the list, used while it's the pinned version and removed after an update.
- **"Nothing runs from it" is a write test, not a rename**: Windows let a folder be renamed with a program running from it (checked), but refuses to open a running program for writing (EBUSY), so `electronInUse` tries that on dx.exe and electron.exe. macOS and Linux let a running program's files be deleted, so there any process whose command line mentions `~/.dx/app` counts as using every version.
- **Updates reach people who never type `dx ui`**: when the app opens from the Start menu or at sign-in, `ensure.js` starts `appinstall.js` in the background if this dx pins a newer Electron; `dx ui` installs it in front of you. `scripts/check-electron.mjs` (in release.yml) fails a release whose pin isn't the newest of its line, or whose line has left Electron's three supported majors.
- **macOS: Electron.app becomes dx.app**, its Info.plist's name, display name, id (`dx.dashboard`) and icon set with `plutil -replace`, Floppy as `dx.icns` (PNG images, 16 to 1024 pixels, written by core's `icnsFile`), then `codesign --force --deep --sign -`, since changing Info.plist breaks Electron's own signature and Apple silicon won't run a broken one. The executable keeps its name (renaming it means renaming Electron's helper apps too). Sign-in is a LaunchAgent with `RunAtLoad`, written as a file (no `launchctl`), so it applies from the next sign-in.
- **Linux: named by its desktop entries**: `~/.local/share/applications/dx.desktop` (menus, search, the dock's name and icon through `StartupWMClass=dx` and `app.setDesktopName`) and the same in `~/.config/autostart` with `--minimized`. Exec arguments are quoted and escaped as the Desktop Entry spec says (`desktopExecArg`).
- **Floppy comes with the app** (`startFloppyWithApp`, from `dx ui` and from `ensure.js` when the app opens from the Start menu or at sign-in): the maintainer expected Floppy on the taskbar without running `dx floppy`. Sending it away (its menu's Quit, `dx floppy --stop`) sets `floppy.off`, which the app respects; `dx floppy` clears it.
- **The page scrolls inside the sheet on wide screens**: in a window, the whole page scrolling (the desk margin with it) and the sidebar squeezing Floppy behind the theme picker on a short window looked broken. `.app` is the window's height, `.main` and `.sidebar` scroll on their own (thin scrollbars in the theme's colours, the sidebar's only under the pointer), sidebar children don't shrink. Under 860 px the page scrolls as before. A route change resets `.main`'s scroll as well as the window's.
- **`dx ui --remove-app`** removes the shortcuts and `~/.dx/app` (refused while the app is open: Windows locks its files) and sets `dashboard.open` to `browser`; `--app` sets it back.

### The dashboard by intent: project first (`web/public/app.js` router and `pages`, `index.html`, `styles.css`)

- **The maintainer found 16 flat pages confusing and asked for structure by intent.** Two directions were put to them on a proposal page: A, the same pages grouped under intents, and B, project first. They picked B.
- **One project, chosen at the top of the sidebar** (`pref("project")`, seeded from the old per-page keys), for every project page: Overview, Code, API, Activity, Data, Break it, Env & secrets. Before, Tour, Data, Chaos, Requests, Git and Activity each had a picker and a memory of their own, so two pages could silently be on different projects. A page that falls back to another project calls `useProject()` so the switcher follows; a link with `?dir=` (the AI lane, Send to the Repeater) switches the project in `route()`. Activity still offers its other projects and recorded sites on its left, and picking a project there switches it everywhere.
- **Route ids stayed** (`#/git`, `#/requests`, `#/chaos`…), only labels changed (Code, API, Break it, Settings), so links and bookmarks work; `#/tour` moves to `#/overview` (`MOVED`).
- **Overview is the Projects page for one project** (`projectsPage(root, { only })`: its row, its dev server card, its unsaved work) plus the API spec card and the tour (`tourSection`), so running, logs, errors, checks and notes weren't written twice. All projects is the same page for every project; a name there opens that project's Overview.
- **Pages that are tabs of another** (`under`) light up their parent's nav item and get a tab strip of links (`pageTabs`, the `.segmented` look as links): This computer is Machine, Ports, Cleanup and Dependencies; Look back is Summary and Journal. Each page kept its own code.
- **Env & secrets shows the chosen project only** (`/api/env/project`, with the key scan); the all-projects list (`/api/env/all`) is still there for the CLI.
- **The theme moved to Settings** (a select applied at once, per computer, in localStorage as before), at the maintainer's request; the sidebar's foot is Floppy and Run Floppy.
- **Not yet**: the README screenshots (`docs/images/`) show the old sidebar and page names and need retaking the usual way.

### The dashboard's look: Teal Grid, window on the desk (`web/public/styles.css`, `index.html`, `fonts/`)

- **Chosen from a design canvas** of four directions (Desktop, Teal Grid, Night Shift, Graph Paper) and then four Teal Grid variations (Window on the desk, Cut corner, On the grid, Tonal teal). The maintainer picked "Window on the desk": the app is one sheet on the desktop teal (#008080) the maintainer liked behind Floppy, and the teal's grid shows only around it, never under text.
- **Tokens kept their names, new values**: `--bg` is now the sheet, `--desk` and its two grid lines are the background, so every page took the look without page-by-page changes. One teal ramp (#EEFAF9 to #002828) for both themes; Floppy's navy is only in the logo and Floppy; the sparkle yellow (`--marker`) only on the current page's pip. Status colours were evened out so none shouts.
- **Fonts ship in `public/fonts`**: the CSP is `default-src 'self'`, so a font host would be blocked. Geist and Geist Mono (variable, Latin) and Silkscreen 400, taken from the `@fontsource` packages with their OFL licences beside them; about 60 KB in all. The server serves `.woff2` as `font/woff2`.
- **Silkscreen only for the logo and small labels** (table headings), never sentences: pixel type is a brand cue, not a reading face.
- **The sheet uses `overflow: clip`**, not `hidden`, so the sidebar's `position: sticky` still works.
- **Floppy's SVGs** (`floppy.svg` logo and favicon, `floppy-idle.svg` in the sidebar) are drawn by `scripts/floppy-assets.mjs` from the same pixel art as the desktop Floppy: a rect per run of one colour, `crispEdges`.
- **The README screenshots were retaken in the new look** (Projects light and dark, Summary, Cleanup, Activity), as the note on README screenshots says.

### Floppy (`core/src/tools/floppy.ts`, `floppyWindow.ts`, `png.ts`; `web/src/floppy.ts`, `floppyapp.ts`, `floppysnap.ts`)

- **The character was chosen over five rounds** of artifacts (a sticker character, Y2K brutalist, neubrutalist sparkles and pixels, scorpions and bats, Office-assistant era, then six directions for a floppy disk). The maintainer picked the 24-pixel save icon: pixel art on purpose, so it's sharp at any whole multiple. The 16-pixel version (tray, shortcut icon) is drawn on its own, not shrunk.
- **The art lives in code**: palette keys in grids (`composeFloppy`), seven moods frame by frame (`FLOPPY_MOODS`), written as PNGs by a small encoder in core (`png.ts`: RGBA, no filter, node:zlib, its own CRC) under `~/.dx/floppy/sprites`, again only when the version or colours change. A one-pixel white edge on every frame, because the black outline vanishes on a dark taskbar.
- **The window is Windows PowerShell 5.1 and WPF**, on every Windows 10 and 11: no Electron (100 MB) or Tauri (a Rust build per release), and core stays dependency-free. Transparent, borderless, topmost, no taskbar button; WPF lets clicks through its transparent pixels. Whole device pixels only: ×2 at 100%, ×3 at 150%.
- **Run with `Invoke-Expression` of dx's own file**, not `-File`, so PowerShell's execution policy (Restricted by default on Windows clients) isn't touched. The script avoids backticks and dollar-brace so it lives in a template string as written; a test parses it with PowerShell's own parser on Windows.
- **Started hidden, Windows hides the first window shown** (STARTUPINFO's SW_HIDE from `windowsHide`), so the script hides and shows it again once rendered. Checked for real: visible, then hidden over a full-screen app.
- **Out of the way while something is full screen**: `SHQueryUserNotificationState` (2 busy, 3 a Direct3D game, 4 presenting), checked about once a second. Windows also says "busy" for a layered window covering a screen (an overlay: Claude's own "using your computer" frame did it, which is why Floppy was never seen while an agent looked at the screen), so "busy" with a layered window in front doesn't hide it. The maintainer tried it with this rule and it works; looking past the window in front (every full-screen window on every monitor) was considered and not needed.
- **Two processes**: a hidden node controller (`floppyapp.js`) and the window. They talk in JSON lines: moods, tips and menu state in; `click`, `moved`, `menu` with an action name out. Stdin closing closes the window, so killing the controller (`dx floppy --stop`) takes it all down.
- **The mood is a pure function** (`floppyView`) of `GET /api/floppy` and a little memory: an error you haven't looked at, then a server starting, one that just came up (played once), an AI agent, quiet or 30 minutes unchanged (asleep), then idle. Errors wake it from quiet. Clicking while it shows an error counts as looking at it.
- **It never keeps a background dashboard running**: its polls carry `X-DX-Quiet: 1`, which the server doesn't count as activity; a click runs `ensureDashboard` and opens it.
- **The app window is Edge's `--app=`** (always on Windows; else the first Chromium found, else the default browser), only for loopback addresses, and the URL never carries the token: the page gets it as it always does.
- **Startup is a shortcut in the user's own Startup folder**, written by dx itself (see the dx app's shortcut note). It runs node's real path (version managers hand out per-shell links) with Floppy's entry and `--detach`, minimised; that starts the hidden controller and exits. The first `dx floppy` turns it on and says how to turn it off, since the maintainer asked for Floppy to start with Windows; later runs refresh the shortcut's paths.
- **A line beside it, always** (`FloppyView.status`): the maintainer asked to know what's happening and on which project without reading Floppy's face or hovering. It's a third layer window (the balloon's yellow, a coloured dot, one line trimmed at 280 px), on the left of Floppy when there's room (it usually sits near the clock), else the right, just above the taskbar; it follows a drag, hides with Floppy when something is full screen, and hovering or clicking it does what Floppy does. The balloon keeps the detail. Errors already looked at stay counted there (`· 1 error`), since the mood no longer shows them. The AI's project is the newest call's, else its running server's.
- **Run Floppy in the dashboard** (`POST /api/floppy/start`, the sidebar's button): the maintainer wanted to start Floppy from the app. It does what `dx floppy` does (`runFloppy`: clears `floppy.off`, `settleFloppyStartup`, `startFloppy`), shared with the CLI, and shows only on Windows while Floppy isn't running (`GET /api/floppy/status`, polled with the page's other 5 s checks). No Startup shortcut while `DX_HOME` is set, from either.
- **Not yet**: macOS and Linux (the window would need another toolkit), and a project list in the right-click menu.

### Languages (`core/src/tools/locale.ts`, the recorder, the Chaos page)

- **Pseudo text is done in the page, not in the project's translations**: dx's own script (`PSEUDO_SCRIPT`, from core) walks text nodes and a few attributes (placeholder, title, aria-label, alt, button values), keeps the originals in a WeakMap, and does it again when the app changes them (a MutationObserver, its own changes ignored). It works for any app, translated or not. Skipped: scripts, styles, code and pre, editable text, `translate="no"`, numbers, emails and addresses.
- **Longer by the usual amounts**: up to 10 characters doubled, 20 +80%, 50 +50%, longer +30%; wrapped in `[ ]`, so a missing `]` shows what got cut.
- **In your browser it starts after load (and 400 ms)**, so a server-rendered page has hydrated and its framework doesn't see different text from what it rendered. The setting is `locale` in the project's chaos file; the recorder script gets `window.__dxLocale` (flags only) and the script in front of it.
- **"Cut off" and "spills" are measured, not guessed**: an element with its own text whose content is wider than its box (cut off when it or an ancestor within 4 levels clips, or it ends in an ellipsis; spills otherwise), or taller than a clipping box (line clamps). Each is outlined in red in the picture, which is saved under `~/.dx/locale/<project>-<hash>` (0600) and reaches the page as a data URL, named only by `page@pseudo|rtl`.
- **"Not translated" is the page's text compared with the translation files**: JSON, YAML (core's reader) or .po in folders named like `locales`, `i18n`, `messages`, `translations`, `lang`, never `node_modules` or builds. Placeholders (`{{x}}`, `{x}`, `%s`, `:name`, `<0>` tags) match anything; ICU plurals and selects become their options. A translation with a number or symbol next to it ("Total: 40 €") counts. Text found in the page's API answers or its JSON script tags is data (whole values for words under 8 characters, so "ok" inside "token" doesn't count); numbers, codes, emails and addresses too.
- **Where it's written comes from one `git grep -F -o`** over tracked and new files, leaving translation files out.

### Tour (`core/src/tools/tour.ts`)

- **From what's there, nothing run**: the README's first paragraph (badges, headings and code left out), package.json (major versions for frameworks), Python requirements, `declaredRoutes` (the graveyard's route finder) for pages and calls with their files, `readDataSchema`, `planPrepare`, `detectStack`, `detectTestFramework`, git for folders and the files changed most in 90 days (lock files left out).
- **A call belongs to the page in its Referer**, else the page or route the history was on in the 30 s before (as the Activity page groups them). A call no declared route covers is listed on its own; declared ones nobody called are listed with 0.
- **Settings by name only**: from the example file when there is one (it lists everything), else the `.env` files; the regex reads up to the `=`, so values are never read into the tour.

### Proof for the pull request (`core/src/tools/prproof.ts`)

- **The branch is `<base>..HEAD`**, the base being `origin/HEAD`, else origin/main, origin/master, main, master; on the base itself there are no commits and it covers the last day. Its records start an hour before the first commit.
- **Built from dx's own records**: activity events (pages, calls, problems), `runs.jsonl` (the last `test`, and the newest of each check: gremlins, behaviour, attack, locale, env-probe, upgrade, bug-replay, queries, and the agents' equivalents), and the visual index for the branch's commits. "Still open" means an error seen after the last commit.
- **Into the PR only through `gh`, only on request**: `gh pr view` then `gh pr edit --body-file -` with the body on stdin. dx's part is between `<!-- dx:proof:start -->` and `<!-- dx:proof:end -->`, replaced on later runs; the rest of the description stays. The route rebuilds the proof on the server; text never comes from the request. The MCP tool only returns the text.

### Trying an upgrade (`core/src/tools/upgrade.ts`, `createWorkingCopy` in `snapshots.ts`)

- **A copy of the working copy, not a commit**: a detached worktree of HEAD under `~/.dx/snapshots` with `git diff HEAD --binary` applied (new files that aren't added don't come along), the `.env` files copied, registered like a snapshot (`upgrade` set) so Run any commit lists and removes it. Made again for the same package and version, it's replaced.
- **Before, with the project's packages linked; after, with its own**: the type check, build and tests run first with node_modules linked (same lock file, so it's the project as it is), then the links are removed (never followed) and the package manager installs the new version into the copy (`npm install x@v [--save-dev]`, `pnpm|yarn add [-D]`, `bun add [--dev]`). The project's node_modules is never written.
- **The version is checked before anything runs**: a package the project depends on (npm name rules), and a tag or a version number only, no range characters, since the command goes through a shell on Windows. It's resolved on the npm registry (a tag, a major's newest non-prerelease, or an exact version).
- **Checks are the project's own scripts** (`typecheck`, `type-check`, `check-types`, `types`, `tsc`, `check`, `lint:types`, else `npx --no-install tsc --noEmit` for a TypeScript project; `build`), and `runTests` named apart from the project so the PR proof doesn't count the copy. Errors are the output's error lines with the copy's folder taken off; "new" is what the run before didn't have.
- **Pages are compared with the project's own dev server**: behaviour (`checkPage` with requests, `compareBehaviour`), then pictures, speed and accessibility in one browser with the visual diff's freeze and settle scripts. The copy's dev server is stopped afterwards.
- **Breaks** is a failed install, a check that failed where it passed, new errors in one that already failed, more failing tests, or a worse behaviour change; **changes** is a different look, behaviour, speed or new accessibility problems.

### Queries per request (`core/src/tools/querylog.ts`)

- **The database's own log, switched on and back**: Postgres `ALTER SYSTEM SET log_min_duration_statement = 0` and `pg_reload_conf()` (applies to open connections; the container's user is a superuser), `RESET` to put it back; MySQL's slow log to a table at 0 s (`SET GLOBAL`, root, new connections only). dx's fixed SQL through `runSceneSql`. What's on is kept in `~/.dx/querylog.json` (0600) with since when.
- **Read from `docker compose logs --timestamps`** (Postgres: `statement:` and `execute` lines; parse, bind and DETAIL with the parameters left out; a statement's start is the log time minus its duration) or `mysql.slow_log` since then.
- **Values are taken out as statements are read** (`shapeSql`: strings, numbers, `$1`, booleans and nulls become `?`, lists `(?…)`), so an email or hash in a WHERE never reaches dx's records.
- **A statement belongs to the request being answered**: the proxy's request events carry their start and duration; with 30 ms slack for the two clocks, the latest-started request that covers it wins. Statements outside every request are counted, not attributed.
- **Thresholds**: the same statement 10+ times in a request is N+1, 200 ms is slow, 50 statements is busy.
- **Verified with a real Postgres 16** in Docker on Windows (the test runs on Linux CI, or with `DX_TEST_DOCKER=1`); MySQL from its documentation and parsing tests only.

### Open on my phone (`web/src/phone.ts`, `core/src/tools/qr.ts`)

- **The one exception to loopback-only, kept narrow**: a session per project, on request, 30 minutes by default (5–120), listening on this computer's private LAN address only (`lanAddress`: 10.x, 192.168.x, 172.16–31.x, virtual 172.x adapters last), never `0.0.0.0`. It forwards only to that project's dev server (`localRoutes()`), through `relay()`, never the dashboard.
- **A one-time link, then a cookie**: the QR holds `/__dx/phone?c=<32 hex>`; the first request trades it for `dx_phone=<64 hex>` (HttpOnly, SameSite=Lax, expiring with the session) and the code is cleared. Every other request needs that cookie (compared with `timingSafeEqual`); the cookie is removed before the request goes to the app. **New code** restarts the session, which lets the earlier phone go.
- **Labelled `env: "phone"`** on both the proxy's request events and the recorder's page events (`LocalRoute.env`), so the Activity page's environment filter and the card's panel can pick them out.
- **Closes** at expiry, on Stop, when the dashboard's regular check finds the dev server gone (`prunePhones`), and with the dashboard.
- **QR codes are encoded in core** (byte mode, level M, versions 1–10, the lowest-penalty mask), drawn as one SVG path through the DOM (no `innerHTML`, so the CSP is unchanged) and with half blocks in the terminal. Checked against jsQR during development for versions 1, 4, 5, 7, 9 and 10 and unicode; the tests check the structure.

### Realistic data (`core/src/tools/seeddata.ts`, `seedload.ts`, `web/src/dataapi.ts`)

- **Schema from files**: Prisma first (`prisma/schema.prisma`, the `prisma.schema` in package.json, or a `prisma/schema` folder), else `CREATE TABLE` in `.sql` files whose path mentions migrations, schema, db or sql. Relations come from `@relation(fields, references)`, `REFERENCES` and `ALTER TABLE … FOREIGN KEY`; composite uniques are kept so rows don't break them.
- **Rows by name and type, seeded** (mulberry32): emails at example.com, names, products, prices, statuses, dates in the last year, ids written explicitly (so relations line up). Fill order is parents first; a cycle is broken at an optional reference. Owners (users, accounts, customers…) get a dozen rows; children 1–5 per parent, except row 0 (nothing: empty states), row 1 (the long, unicode, sparse one; the big customer's 60 in that recipe) and row 2 (soft-deleted when there's a `deletedAt`, still with children).
- **Loading goes through the project's own tools**: a CommonJS runner written to a temp folder runs with the project's `@prisma/client` (deleteMany children first, then createMany parents first, in one transaction; one by one where createMany isn't there), or SQL dx builds itself goes to the compose database's client (`runSceneSql`: TRUNCATE … RESTART IDENTITY CASCADE / DELETE with foreign key checks off, then INSERT). Postgres sequences are moved past the ids used. Never a statement from a request.
- **Only local**, with the migrations' guard (`isLocalDatabase`) for Prisma, and the compose database (on this computer by definition) for SQL. **A backup scene first**, unless the database is empty; the newest five backups are kept. Verified with real Prisma 6 and SQLite during development; the test uses a stand-in client.
- **Not yet**: SQLite without Prisma, MongoDB, Drizzle/TypeORM schemas (their migrations' SQL works).

### Attack my app (`core/src/tools/attack.ts`, `POST /api/chaos/attack`)

- **From the history, against the project's own dev server only** (loopback, through its `.localhost` address, so the attempts are in Activity too). Only paths the proxy saw; calls the page made to other addresses are skipped.
- **Proof over guesses**: stored and DOM script are reported only when a headless browser finds the injected element (`<dx… data-dx-xss>`) in the page; reflected server-side when the HTML contains it unescaped; SQL errors by the database's own error text after one quote; CSRF only with your cookie and an `Origin` of another site, and only for recorded POST/PUT/PATCH (never DELETE). Other ids are tried only with a session, and reported as "check it belongs to the user", since dx can't know who owns what.
- **A session is used for one run**: kept in memory for the job, never in the report, a log or runs.jsonl.
- **Set-Cookie keeps its flags**: `maskSetCookie` masks the value only, so the cookie check can read HttpOnly/Secure/SameSite from the history.

### Speed and accessibility per commit (`core/src/tools/pagehealth.ts`, in `captureVisual`)

- **Measured on the desktop capture of each page**, after a warm-up load (the dev server compiles on the first request): navigation timing, largest contentful paint, total blocking time and layout shift from observers added before the page's scripts, and the encoded size of the scripts the measured load fetched. Dev-build sizes: compared between commits, not with production.
- **Only clear changes count**: slower means +300 ms and +30% on largest paint (else load), +200 ms blocking, or +0.1 layout shift; heavier means +20 KB and +10% JavaScript.
- **The accessibility audit is dx's own** (no library): alt text, labels, accessible names, WCAG contrast (4.5:1, 3:1 for large text) against the first solid background, `lang`, heading levels, positive tabindex, duplicate ids. New problems are those the compared commit's capture didn't have, by rule and text.

### Chaos (`core/src/tools/chaos.ts`, `gremlins.ts`, `emulation.ts`, `envprobe.ts`, `behaviour.ts`, `graveyard.ts`; `web/src/chaos.ts`, `chaosapi.ts`)

- **Chaos is a fault on the rules' plan**, not a second proxy path: `chaosFor` decides, `withChaos` adds it to the Requests page's `RulePlan` (or makes one), and `relayWithRules` carries it out. Mock mode still comes first: a mocked call isn't broken.
- **API calls only, judged from the request**: not GET with `Accept: text/html`, not `/__dx/`, upgrades or OPTIONS, not Vite's or Next's own paths (`/@vite/`, `/src/`, `/_next/static`…); non-GET always; GET when the path has `/api/`, `/graphql`, `/trpc/`, asks for JSON, or asks for `*/*` with no file extension. Page loads and scripts are never broken, so the app itself always starts.
- **Deterministic from the seed**: a call's fault is `chance(seed, "METHOD /folded/path", n)` against the level's odds, `n` being how many such calls came before in this run (counted in the web process, per `startedAt`, seed and level). Turning chaos on, a new seed, level or faults, or **Start the run again** starts a new run. Page loads aren't counted, so reloading doesn't shift which calls break.
- **Logged out is a window, not odds**: the session "expires" at a seeded call (4–15) and the next 3 calls carrying a cookie or Authorization header get a 401. A call without a session can't be logged out.
- **Out of order** holds an answer until the next call to the same method and path has been answered (or 3 s), so the page gets the older answer last. **Dropped** sends the headers and half the body, then closes. **Odd data** changes one field of a 2xx JSON answer (leaves and lists first), the same field for the same call; not JSON, nothing changes and the call isn't counted as broken.
- **The report is read from the activity history** since the run started: request events carry `rules: ["chaos: …"]`; the page's recorder reports `problem: "blank"` (no text, image or control left, after load or an error) and `problem: "stuck"` (a spinner-like element, `aria-busy`, `role=progressbar`, `*loading*`, `*skeleton*`, still visible after 15 s) as error events. "Sent twice" is the same non-GET method, path and body twice within 3 s in a visit. Each finding lists up to 4 chaos hits of its visit (or the 15 s before it).
- **The clock lives in the recorder script**: when a project has a clock, the script is served with `window.__dxSettings = {clock}` in front (checked values only: an ISO date, a flag, a zone name that `Intl` accepts). `Date` becomes a subclass whose `now()` is shifted (or frozen), wrapped in a Proxy so `Date()` without `new` still gives text; a zone replaces `get*`, `getTimezoneOffset`, `to*String` and `Intl.DateTimeFormat`'s default zone, worked out with `formatToParts`. Setters stay local, and the recorder keeps the real clock for its own timestamps. A time given without an offset is on the chosen zone's clocks (`zonedTime`).
- **Gremlins run in `withBrowser`** (a throwaway headless profile), through the project's `.localhost` address so the history records them and Chaos mode applies. Each step is chosen with a seeded mulberry32 before it runs, so a problem it causes while running counts it among its steps; the steps are `PageStep`s (`double` and `back` were added to page checks and bug bundles for them), so **Replay** is a page check. A link off this computer sends it back to the start. Destructive-looking labels (delete, remove, reset, sign out, unsubscribe…) are skipped unless `bold`: they'd wipe the data the rest of the run needs.
- **Weak phone is DevTools emulation** (`emulation.ts`): device metrics 390 × 844 at 3×, touch, a mobile user agent, CPU throttling 6×, and Chrome's own Fast 3G numbers. The dx browser applies it to every tab as it's attached and to open ones when it changes (and undoes it, back to the browser's own user agent). It's a dashboard-wide switch for the dx browser and a per-project one for Gremlins.
- **Missing values blank a value (`KEY=""`) rather than remove it**: dotenv, Vite, Next.js and `node --env-file` keep a variable that's already set, so this is how it goes missing without touching `.env`. Each run is the project's dev command on a free port (`moveDevPort`, else `PORT`, else the address it prints), a page check, then the process tree stopped. Problems are compared with a first run with everything set, so what was already broken doesn't count. Values the code never mentions (a whole-word search of tracked text files) aren't run.
- **Behaviour diff compares by folded path, not address**: the snapshot and your dev server run at different ports. Only XHR, fetch and EventSource calls count (the dev server's own files are left out). The snapshot's server is stopped afterwards; the snapshot stays, listed with the others.
- **The graveyard finds routes with patterns, not a parser**: router calls with a string path (`app.get("/x"`, `router.post(`, `fastify.`, `hono.`), Python decorators, file-based routing folders, and `path:` / `<Route path=` in files that import a router. Tests, stories and type files are left out. It's only as long as `activityDays`; calls that match no route are counted, so a missed router shows up as a number rather than as false "unused" claims.

### Getting a project ready before Run (`core/src/tools/prepare.ts`, `web/src/dev.ts`, `dx prepare`)

- **Why**: Run failed on real projects for reasons dx could see coming: no `node_modules`, a lock file changed by a pull, no `.env`, Docker not running, migrations not applied, a workspace package not built. Each is now a step before the start.
- **Found from files only** (`planPrepare`: fast, runs nothing), run in order (`runPrepare`), output into the server's own log, so the card and `dev_logs` show it. A blocking step that fails stops the start (status `failed`, no process); warnings (`.env` values missing, a busy port) don't.
- **Two phases**: "before" for everything, "db" for migrations in a stack with Docker databases, run after the Docker wave and before the services that use them.
- **Remembered per project** in `~/.dx/prepare.json` by what each step depends on: the lock file's hash, the schema's, the migrations folder's listing, or (with no migrations folder to watch) the commit checked out, read from `.git` without running git. The first time dx sees an installed project whose `node_modules` is newer than its lock file, it counts as installed.
- **`npm install`, not `npm ci`**: ci deletes `node_modules` every time and fails when `package.json` and the lock disagree.
- **Migrations are guarded twice**: only against a database on this computer (the `DATABASE_URL`, `DB_HOST`… in `.env` files: localhost, a Docker service name, SQLite), and never a project script that also resets, drops, truncates, seeds or pushes the schema. Both show as "skipped" with the command to run by hand.
- **The project's own migrate script first** (`db:migrate`, `migrate`, `migration:run`…), since it knows its setup; then the tool found from its files.
- **Snapshots aren't prepared here**: they link or install their packages themselves.

### Several API specs per project (`openapi.ts` storage and `mapApis`, `putMocks`' `replaceApis`, the API page)

- **The maintainer has projects with more than one swagger file, for mocks and for API setup, and wanted several added "without anything breaking", each endpoint knowing which API it comes from and the mocks working.** Before, a project had one spec in `~/.dx/specs/<project>.json`.
- **A list of named specs in the same file** (`dx-specs`, version 2): `id` (a slug of its name, unique in the project, kept when it's renamed so its mocks keep their ids), `name`, `source`, `doc`, and optionally `service` and `mount`. A file from before (`dx-spec`, or the `dx-spec-off` marker) is read as one API named from its title, or as "removed on purpose"; the first write converts it.
- **Endpoints and mocks carry their API** (`api`, `apiName`): `readStored` reads a stored spec so each endpoint knows it, and `mocksFromSpec` puts the API in the mock's id, so two APIs with the same method, path and status don't overwrite each other (the old id hashed none of that). A mock made from an API with a `service` carries it, and `matchMock` already answers a stack call only from mocks of its service.
- **Telling APIs apart is the user's to say, not dx's to guess**: calls carry only a path (and a stack service), so two APIs with the same path can't be told apart by dx. `mapApis` gives a call to the API with the best-matching endpoint (a stack call only to an API that is its service or has none) and reports `overlaps` (the same method and path in APIs of the same service); the pages say so and point at `service` and `mount`. `mount` is the base path when it isn't the spec's own, so `/health` of Payments can be `/payments/health`.
- **Mocks made again replace only their API's** (`putMocks` with `replaceApis`): the unedited spec-made ones of that API, and, for the first API, the ones made before APIs were told apart (no `api`). Edited mocks always stay. Purge takes an API too.
- **Only the first spec file found is added by itself**; the project's other spec files are offered on the API page, since `openapi.json` and `swagger.json` are often the same API twice. `SPECS_MAX` is 20.
- **State export** carries every API given by hand (`specs`, with name, service, mount; not ones dx found) and "removed on purpose"; an old file's `spec` is read as one.

### An API spec on every project (`projectSpec`, `forgetSpec`, `specTurnedOff` in `openapi.ts`; `lookForServedSpec` in `labapi.ts`)

- **The maintainer wanted to add a Swagger spec to a project and have the rest of dx use it.** It was already stored per project, but only from the Requests page, and only that page used it.
- **Found by itself, so there's nothing to add in the usual case**: `projectSpec` returns the kept spec, else the most likely spec file in the project (`findSpecFiles`), saved with `found: true` and read fresh each time. While dx runs the dev server and there's still none, `GET /api/lab/spec` starts `lookForServedSpec`: the usual `SPEC_URL_PATHS` through dx's own route on this computer, in the background (the page polls), once per 10 minutes per project.
- **Removing it is remembered**: `forgetSpec` writes a `dx-spec-off` marker in place of the spec, so the same file isn't picked up again; giving one again replaces it.
- **Who uses it** (now for every API of the project, see *Several API specs per project*): Overview's card (source, endpoints called this week, calls it doesn't have, endpoints answering differently), Activity's APIs view (the summary beside each call, "not in the spec" for non-GET or `/api/` calls it lacks, "doesn't match the spec" from `mapApi`'s issues, and the spec's uncalled endpoints), the tour (`ProjectTour.spec`, also in its Markdown), the API page and mocks, the graveyard, and the MCP `api_map` tool, which now uses `projectSpec` too.
- **The API page leads with it**: the Requests page became API, its "Spec & mocks" tab first and the default.

### The Requests page (`core/src/tools/rules.ts`, `openapi.ts`, `yaml.ts`, `aicli.ts`; `web/src/apilab.ts`, `intercept.ts`, `labapi.ts`, `mocks.ts`)

- **Rules run in the proxy, after mock mode**: a mocked call never reaches the server or the rules. Page loads (GET with Accept: text/html) and `/__dx/` are left alone, so the recorder still goes into pages. With no rule matching, `relay()` streams as before; a matching rule reads the request (and, only when it edits or holds the body, the answer) whole, up to 8 MB.
- **Rules stack in order**: delays add up, the first `fail` wins, every rule's edits apply. Hit counts are in memory, not in the rules file.
- **Intercept holds in memory, 60 s, 50 at most**, then sends on unchanged: a forgotten hold never hangs the app. Turning a rule's hold off lets go of what it holds.
- **The Repeater bypasses rules and mocks** (like Burp's): what you send is what the server gets. A header still showing `•••` is refused rather than sent; the history is masked.
- **The mock server is the answer to "no back end"**, not a fallback: it answers from the first call from the project's mocks, at its own port (4010 and up, kept in the mock set so the address stays) and `<project>.mock.localhost`. A fallback that answered when the dev server was down was dropped: when dx stops a server it removes its route, so it would almost never fire.
- **Answer selection like Postman**: `x-mock-response-code` / `x-mock-response-name` (and Prism's `Prefer: code=`). Otherwise: an exact path over a template, edited over real (recorded, cache, AI) over spec examples over made-up data, a success over an error.
- **Spec templates match any value** (`/users/{name}` fits `/users/alice`): mocks from a spec carry `pattern`; recorded ones keep folded paths (`/orders/:id`).
- **Made-up data is deterministic** (seeded by method, path and field) and reads by context: `name` under `/products` is a product, under `/users` a person; emails and links at example.com.
- **The cache keeps whole answers** (the recorder now keeps up to 512 KB per answer for it; the network log still keeps 32 KB), masked like the history, written in batches a second apart, until purged by source.
- **YAML is read by a small parser in core** (block maps and lists, scalars, quotes, `|`/`>`, flow collections), since core has no dependencies; anchors, aliases and tags are refused with "give the spec as JSON".
- **AI data uses the coding CLI already installed** (Claude Code, else Codex; `aiCli` in the config picks), never an API key: `claude -p` or `codex exec --sandbox read-only --ephemeral` in an empty temp folder, prompt on stdin. Only the JSON in the answer is used.

### Installing dx itself (`core/src/tools/selfinstall.ts`, `dx update`, `scripts/use.mjs`)

- **npm alone gets stuck switching installs**: `npm install -g dx-devkit` fails with EEXIST while the repository's link (`@dx/cli`) or a half-removed install owns the `dx` shims, and on Windows a dx process running from the old install (the dashboard, an AI tool's dx server) makes the removal fail with EPERM. `--force` hides it and leaves the old copy behind.
- **`switchDx` does it in order**: stop the dashboard, remove the other install, ask before stopping processes that still run from it, delete shims that start an install that's gone, then install. `dx update` (npm), `npm run link` (this folder) and `npm run unlink` (back to npm) all use it.
- **A linked build is a junction on Windows**: only the link is ever removed, never recursively, which would delete the repository's own files.
- **Shims are recognised by the install they start** (`node_modules/dx-devkit/` or `node_modules/@dx/cli/`), never by name alone, so another program's `dx` is left alone.
- **`dx update` from a linked build** says so instead of replacing it; `--npm` switches. When `dx` won't start at all, `npx -y dx-devkit@latest update` runs the same code from npm's cache.

### Visual diff (`core/src/tools/visual.ts`, `web/src/visual.ts`, the Git page's graph)

- **Compared in the browser, not in Node**: core has no PNG decoder and won't take a dependency, so both PNGs go into canvases in a blank tab of the same headless browser that took them, and `diffPixels` (a plain function whose source is sent to the page, and tested in Node on arrays) counts pixels whose largest channel difference is over 24, gives the box of the change, and paints the diff image (changed pixels orange over a washed-out grey copy). Fewer than 16 differing pixels isn't a change.
- **The same page gives the same pixels**: `Emulation.setDeviceMetricsOverride` at 1280 x 800 (390 x 844 with `visualMobile`), scale 1; `prefers-reduced-motion: reduce`; a style added before the page's scripts (`Page.addScriptToEvaluateOnNewDocument`, with `Page.setBypassCSP` since it's the project's own dev server) that ends animations and transitions and hides the caret; after load and a quiet network, fonts ready, `getAnimations()` finished, scrolled to the top, focus dropped, two frames. Viewport-sized shots, not full page: a page's length changes with its content and would make every shot differ.
- **Which pages**: the four most visited paths of the last day in the activity history (page loads and route changes on loopback, `#/route` kept, query strings not, dx's own checks left out), else `/`. They're loaded from the dev server's own address (the `.localhost` route's target), not through the localhost door, so a capture isn't a visit in the history.
- **When**: after `POST /api/git/commit` succeeds, in the background (the response doesn't wait), and when HEAD moves: the Git page's status poll and a 30 s `rev-parse HEAD` per dev server dx runs. The first sighting of a HEAD only remembers it. One capture at a time per project; a request while one runs makes one more afterwards. **Capture now** works with the setting off.
- **Against what**: the first parent's capture, else the newest earlier one, named in `against`. A capture is the app as the dev server showed it then, uncommitted changes included.
- **Where the change is, in words**: the element at the box's centre in the live page, walked up to a button, link, heading, field, image, nav and so on, named by its aria-label, alt or short text ("the Checkout button"); otherwise the region ("near the top left", "across most of the page").
- **Retention**: the newest 30 commits per project, by capture time; folders the index doesn't list are removed, and a capture is written to `<hash>.tmp-...` and renamed in, so a failed one never replaces a good one.
- **Images reach the page as data URLs** in JSON (`GET /api/visual/image`), since every `/api/*` call needs the token header, which an `<img src>` can't send; the CSP already allowed `img-src 'self' data:`, so nothing was widened. The file is found by `visualImageFile` from a known git project, a hex commit the index has (a unique prefix of 7+ works), a capture name that commit lists, and a kind (shot, diff, thumb).

### Every dashboard action for AI agents (`web/src/actions.ts`, `dx_actions`, `dx_do`, `dx_do_risky` in `mcp/src/index.ts`)

- **The maintainer wanted Claude to use dx fully, "like a full MCP"**, not only the 46 tools written one by one. So: a catalog of the dashboard's actions (`DX_ACTIONS`: an id like `git.commit`, a group like the sidebar's, a line, the inputs, and whether it's risky), one tool to read it and two to do them, all through the dashboard's own API (`ensureDashboard`, the token, every check the page gets). New dashboard features reach agents by a line in the catalog; `actions.test.ts` fails when a catalog entry names a route or git action the dashboard doesn't have.
- **Risky actions have a tool of their own**, `dx_do_risky` (`destructiveHint`), because AI tools ask permission per tool, not per argument: allowing `dx_do` must not allow a push. `dx_do` refuses a risky id and `dx_do_risky` a safe one, each naming the other. Risky: deleting, what can't be undone, what leaves the computer, changing the project, packages or database, stopping processes, `.env` values in either direction, settings; and, by the maintainer's choice, commits, merges, rebases, reverts, cherry-picks and switching branch, mock mode and chaos, stopping or restarting dev servers, and saving tools, rules or mocks.
- **Inputs are checked before anything is sent**: required ones, and unknown ones refused by name (so a git action's fixed `action` can't be swapped). Left out of the catalog: what only the page needs (polling, images) and the buttons that ask an AI themselves. Results over 120,000 characters are cut, with a note to ask for less. Calls are recorded like every MCP call; `input` is only counted, and a failure of `dx_do`/`dx_do_risky` is recorded without its text.

### The AI lane (`mcp/src/calls.ts`, `web/src/ai.ts`, the lane in `web/public/app.js`)

- **Every MCP call goes to `runs.jsonl`, not a ring in the dashboard**: as `mcp.<tool>` from source `mcp`, written by a wrapper around `server.registerTool`, so no tool can forget it. The run log already existed, works without the dashboard running (an agent's read-only calls never start it), survives restarts, and `dx runs` shows the same thing. The older semantic records (`go` when an agent starts a server, `resume` for a note) stay: the summary's time per project counts `go`.
- **Nothing secret in a record**: arguments are summarised from a fixed list (project, path, url, port, flags…); bodies, headers, notes, journal text and database queries are only counted (`query=(38 chars)`); addresses go through `maskUrl`. From a result only numbers are read (a status, how many errors, tests passed/failed), and a failure's first line only for tools whose errors can't echo data (not `db_query`, `check_env`, `set_stack`, `add_log_entry`, `leave_note`).
- **Active means a call in the last 5 minutes, or a server the agent started still running.** The page polls `/api/ai` every 4 s; the server reads the run log again only when its size or time changed.
- **Interrupt stops servers, not the agent**: dx can't reach into the AI tool. It stops only dev servers dx runs whose `startedBy` is `ai`, and only those the confirm named (the page sends their dirs). The lane then says "You stopped the agent's servers" until the dashboard restarts.
- **Take over only relabels** (`startedBy` becomes `dashboard`): same process, same port.
- **The lane overlays the page below 1280px** (the page gets room for it above that), and is a bottom sheet under 860px; it collapses to a tab at the edge.
- **"By AI" on the Activity page** matches a headless page check (`from: "check"`) to the agent's `check_url` or `replay_visit` call that was running then (the call's end minus its duration, with a few seconds' slack), since checks the user starts look the same. In Sessions, the agent's other calls sit between the visits in time order.

### Your year (`core/src/tools/yearstory.ts`, the Summary page)

- **Built on the year in review**: the same commits (each repo's `user.name` and `user.email`, `--fixed-strings`), plus one `git log --name-only` per repo for files and languages, counted only for the commits the review counted. Lock files aren't a language or a most-touched file.
- **A summary that ends on a day of its own stops there** (`--until`, and the journal's end): before, a past year counted later commits and journal entries.
- **When you code** uses the commit's author time in local time, weekday Monday first. "Evening" is 18:00 to 05:59.
- **A fix** is a subject with fix/fixed/fixes/fixing, bug, bugfix, hotfix or crash as a word, so "prefix" and "fixtures" don't count.
- **Dev server time** is the `go` runs' `ms` in the year, as the summary counts it.
- **The page gets the story, not the commits**; the last one built is kept a minute, so Save right after viewing doesn't read git again. The heat map's shades are the accent mixed into `--surface-2` (`color-mix`), so they follow light and dark.

### Bug bundles (`core/src/tools/bugbundle.ts`, `web/src/bugreplay.ts`)

- **One JSON file, `{ format: "dx-bug", version: 1 }`**, built from `reportContext` (the events) and `replayFromVisit` (the steps), so a bundle says what Copy as bug report says, in a form that can run. At most 2 MB, 50 steps, 500 events.
- **Nothing that names the sender's computer**: hosts and ports are dropped (paths only), only plain headers are kept (an allowlist: content-type, accept, cache-control…), bodies are masked again on export, and `pathStripper` makes the project folder relative (also as `file:///` and with JSON's doubled backslashes), the home folder `~`, and any other `C:\Users\<name>` or `/home/<name>` `~`.
- **The commit is `commitAt` the error's time** (reflog first), HEAD when git can't say. "Dirty" is the working copy at export: what it was at the error isn't recorded.
- **Read strictly on import** (`readBugBundle`): unknown top-level or step fields are refused, not dropped (a step field a replay doesn't know could be a new action); unknown event fields are dropped. A step's address on another computer is refused; a loopback one keeps only its path. The bundle's host is never used: `bundleUrl` resolves the start path on the importer's own dev server and checks the origin.
- **Replays run as a job** the page polls (`GET /api/activity/bundle/replay?id`), since a snapshot can take minutes to install. Commit mode reuses `runSnapshot`; working-copy mode starts the project's dev server if it isn't running. The replay is `checkUrl` with steps, through the `.localhost` address so its requests are recorded.
- **"Reproduced"** means the same message with numbers blanked (one containing the other counts, for overlays), or the same file and line; for a failed request, the same method, folded path and status. dx's recorder script is never taken as the place: a console error's top frame in a headless check is the recorder.
- The dashboard reads up to 3 MB for this route (and `/api/mocks/update`); everything else stays at 1 MB.

### Mock mode (`core/src/tools/mocks.ts`, `web/src/mocks.ts`)

- **Inside `relay()`**, so the local domains proxy and the localhost door both mock, and only for dev servers dx runs: there is no route to a mock that isn't already a route to a dev server.
- **Which calls**: whatever the mock set has an endpoint for. The set is made only from request events the proxy recorded (API calls by the network log's rule), never from mocked ones. GET with `Accept: text/html` (a page load) is never mocked, so the front end itself always runs for real.
- **Matching**: method and folded path (the APIs view's folding, `foldPath`), then query and body only where the recorded calls differed by them; the newest wins otherwise, also for an unseen query. A body key is a hash of the masked body, so a live password still matches the recording's `•••`.
- **Unmatched calls are forwarded** by default; strict mode answers an API-looking call (non-GET, `/api/`, `/graphql`, `/trpc/`, or a JSON Accept) with a 404 that says no mock matched.
- **Offline is a closed connection**, not a status: that's what a front end sees when the API is down. Fail with 500 is the status case.
- **Stored per project** in `~/.dx/mocks/<name>-<hash>.json` (0600, through a temp file and a rename); the proxy rereads it when its mtime or size changes, so `dx mock on` in a terminal applies at once. Edited endpoints are kept when mocks are made again; Reset unmarks them.
- **Recorded as mocked**: the network log entry and the activity event carry `mocked: true` and the text ends "(mocked)", so the history doesn't pass a mock off as the server.

### The dx browser and recorded sites (`core/src/tools/dxbrowser.ts`, `sites.ts`, `mask.ts`, `web/src/dxbrowser.ts`)

- **A browser window dx starts, not an extension or a proxy**: it's the only no-setup way to see a deployed site's requests with their bodies, its console and its errors in the user's own Chrome-family browser. A proxy for https sites would need a certificate the system trusts, and an extension needs installing.
- **Its own profile, `~/.dx/browser-profile`.** Sign-ins made there persist between runs and never mix with the user's everyday profile; Chrome refuses remote debugging on the default profile anyway. One window per profile: a second start is handed to the first by Chrome and exits at once, which dx reports as "already open".
- **Over `--remote-debugging-pipe`, never a port.** DevTools messages go over file descriptors 3 and 4 (NUL-ended JSON, what Puppeteer's `pipe: true` does), so no other process on the machine can connect, and the browser closes when the dashboard that holds the pipe goes (checked: no browser process is left after the dashboard is killed). Verified on Windows with Chrome and Edge. The headless page check (`checkPage`) keeps its throwaway port and profile.
- **Attached to every tab** (`Target.setAutoAttach` with `waitForDebuggerOnStart` and `flatten`, at the browser and in each page for out-of-process frames), with Network, Runtime, Page and Log on, then resumed. An address dx opens goes into a tab that is already set up (`about:blank` first, then `Page.navigate`), so its first page load is recorded.
- **What's recorded is decided per address, by the tab's page**: a recorded site (`sites` in the config; an exact host before a wildcard, one with a port before one without) or this computer. Everything else is dropped as it arrives: no event, no body asked for. A recorded page's requests to other hosts are kept without bodies. Pages dx's own proxy or localhost door already record (`*.localhost` routes, a dev server's `recorded` address) and the dashboard itself are left alone, so nothing is recorded twice and the dashboard's token never is. A local address a dx dev server answers goes under that project.
- **The same events as the recorder**, so every view, bug reports and the CLI work: `request`/`page` from Network (`getResponseBody` up to 32 KB for API answers, post data up to 16 KB), `console` from `Runtime.consoleAPICalled` (the dev server's chatter left out, as in the page), `error` from `Runtime.exceptionThrown`, `route` from `Page.navigatedWithinDocument`, and clicks and submits from a listener added with `Page.addScriptToEvaluateOnNewDocument` **in an isolated world** whose `Runtime.addBinding` only that world can see, so the page's own scripts can't call it. Its payload is checked like `/__dx/events`: known type, bounded, masked. Visits get the recorder's id format, so grouping works. Times come from the browser's own clock; route changes, which DevTools doesn't stamp, use its measured offset, so they sort with the rest.
- **Masked before storing, by the same code**: `mask.ts` moved to core (`maskHeaders`, `maskBody`, `maskText`, `classify`), shared by the network log, the recorder and the dx browser; addresses also lose user:password and credential-looking query values (`?token=`, `?code=`). `x-dx-token` and `x-xsrf-token` joined the masked headers.
- **Events carry `site`, `env` and `from: "dx-browser"`.** A site linked to a project writes into that project's folder; an unlinked one into `site:<host>` (a folder `site-<host>-<hash>`, not tied to the current directory). In the API, `?site=` reads that folder, `?host=` filters by site anywhere, `?env=` by environment ("local" is everything without one).
- **The environment is guessed from the host when not given** (staging/stage/stg, preview, dev, qa, uat, test, sandbox, demo, with the top-level domain left out, so `shop-website.dev` is production; loopback is local) and stored with the site, so the user sees and can change it.
- **Deployment detection is passive**: from the page's response headers (`x-commit`, `x-git-commit`, `x-commit-sha`, `x-version`, `x-app-version`, `x-vercel-deployment-url`, `x-vercel-id`, `server`) or, when there are none, its `<meta name="version|commit|build|...">`, read once the DOM is parsed (the page event waits up to 3 s for it). Hex of 7 to 40 characters is a commit, also inside a version (`1.4.0+3f2c9e1`). A server name alone isn't a deployment. **Run this commit** shows only when `resolveCommit` finds it in the linked project. dx never requests anything from a site by itself.
- **Opening takes http(s) only**, without user:password; runs.jsonl gets the host, never the address. The dashboard owns the window like its dev servers: it closes with the dashboard, and a background dashboard doesn't stop for being idle while it's open. `DX_BROWSER_HEADLESS=1` runs it without a window (tests).

### Activity page layout (`web/public/app.js` `activityPage`)

- **Like opening a project**: projects and sites on the left from `GET /api/activity/overview` (counts per folder, environment and site since the chosen time, the recorded sites, and the dx browser's state), the selection's timeline on the right. The selection is one preference (`activitySel`: "", `p:<dir>` or `s:<host>`).
- **Rows are one line** (ellipsis; the whole text is in the detail). The environment filter shows only when the events have more than one. APIs are grouped per environment too, so staging's `/api/cart` isn't averaged with yours.
- **Deployed rows don't open your editor**: their files are the build's, not your project's. Replay stays local-only.

### Run any commit (`core/src/tools/snapshots.ts`, `web/src/snapshots.ts`)

- **A detached git worktree, not a clone or an archive**: `git worktree add --detach ~/.dx/snapshots/<project>-<short> <oid>` shares the repository's objects (fast, no network), never moves your branch or index, and `git worktree remove` undoes it. A project in a subfolder of its repository runs from that subfolder of the worktree.
- **Registered in `~/.dx/snapshots.json`** (temp file and rename). Only registered snapshots under `~/.dx/snapshots` are known projects, and only for running, reading output and history, checks and opening; git routes and anything that writes files refuse them. An entry whose folder is gone is dropped from the list.
- **Linked node_modules when the lock file matches** (`git rev-parse <oid>:<lock>` against `git hash-object`, then a line-ending-blind compare for core.autocrlf), a junction on Windows; also workspace packages' own node_modules a few levels down. Otherwise a frozen install (`npm ci`, `--frozen-lockfile`). Linked means shared: tools that cache inside node_modules (Vite's `node_modules/.vite`) share the cache with your own dev server.
- **Removal unlinks every node_modules link first**, then `git worktree remove --force`, then deletes what's left, then `git worktree prune`. A test checks the project's own node_modules survives.
- **Untracked `.env` files are copied in** (not example files, which are tracked; not over a file the commit has). They stay in the user's own `~/.dx`.
- **Its own port**: `moveDevPort` with a free port when the tool is known, else `PORT=<free port>` (ready when that port opens, or at the address it prints). No localhost door: the usual port belongs to the project's own dev server. In a stack, each app service gets `PORT=<free port>` too, and **the project's own Docker services are used, never started or stopped by the copy**: with a compose file that names its project they are the very same containers, and stopping a snapshot once stopped the project's database. The copy skips preparing (it has its own packages) and says which services it shares.
- **The run answers once the commit resolves**; the checkout and install go on in the background, and the page follows `GET /api/snapshots` (step, the install's last lines). A failed install keeps the snapshot so it can be retried or removed.
- **Time travel reads the reflog** (`log -g --date=unix`, the newest entry at or before the moment), falling back to the last commit before then on HEAD. The slider spans the events shown; events within max(30 s, span/60) count as around it.
- **Not yet**: snapshots stay until removed (no automatic clean-up); Python and other non-Node projects aren't set up beyond the checkout.

### Ask Claude to fix (`core/src/tools/fixer.ts`, `claude.ts`, `web/src/fixes.ts`, `/api/fix/*`)

- **Claude Code through `claude -p --max-turns 1`, like Write message**: the runner is shared (`claude.ts`), arguments fixed, prompt on stdin, 90 s timeout. **With `--tools "" --strict-mcp-config`, in an empty temp folder**: the maintainer got "Reached max turns (1)" after editing a tool, since Claude reached for one of its tools (a file, an MCP server) and needed a second turn. dx only wants text back. A Claude Code that doesn't know those flags is asked again without them. The `claude` lookup is cached a minute, and looked up again when PATH changes (tests put a fake one first on PATH).
- **The error is looked up on the server**: a dev-server error by the tracker's id (`devErrors`, the running or last run), an activity event by its id (`reportContext`; exceptions, server errors and console errors only). The page sends only the project, the source and the id.
- **The prompt is built in core**: fixed instructions (a unified diff only, paths from the project root, the smallest change, then `EXPLANATION:`), the error and stack (8 KB), the file it names (whole up to 300 lines, else ±60 lines), up to 3 other project files from the stack (±30 lines), and `git diff HEAD` (40 KB). Files only inside the project, plain files (no links), under 512 KB, never under node_modules/.git/virtualenvs/build caches, never `.env*`, keys or lock files; those are also left out of the diff by pathspec.
- **Claude's diff is rebuilt, not trusted**: dx parses it loosely (fenced or bare, `a/`/`b/` or not), rewrites the headers itself, works out each block's counts again, refuses renames and any path outside the project or in a blocked folder, then applies it to a throwaway index (`GIT_INDEX_FILE`) holding the touched files as they are now (`git apply --cached --recount`, plus `--unidiff-zero` when a block has no unchanged lines around it, or git insists it sits at the file's start or end). The patch kept and shown is `git diff-tree` of before and after, so it's exact and in git's format for `diffBlock()`. A patch that doesn't fit comes back as `ok: false` with why and Claude's whole answer.
- **Git projects only**: the check and Undo both need git, and a temp copy of a non-git project would leave nothing to undo from. The server refuses with the reason; the page hides the button there.
- **Kept in the web process by a random id**, 30 minutes, at most 20, for the project it was made for. Apply takes the id, never a patch; it's forgotten once applied or dismissed, and lost on restart.
- **Apply checks, backs up, then journals**: each file must still hash to what Claude saw (409 otherwise), a raw copy of each goes into git's store (`backupFiles`, shared with Discard), `git apply` (no `--index`), then an undo-journal entry of kind `files` (`recordUndo`), so the Git page's Undo brings the files back (a created file is removed). Changes land unstaged, as cards on the board.
- **Paths are the repository's**: for a project in a folder of a bigger repository, Claude writes project paths and dx prefixes them, so the patch matches the Git page.
- **The panel outlives redraws**: the error lists redraw as output and events come in, so each error's panel is kept by key and moved into the new list.
- **`dx fix` only prints**: it asks through the dashboard (the errors live there) and shows the patch; applying stays on the page, with its review and Undo.

### Machine (`core/src/tools/machine.ts`, `projectNeeds.ts`, `background.ts`, `versions.ts`)

- **Versions from fixed commands only** (`node --version`, `go version`, `java -version`…), run through `cmd.exe /d /s /c` on Windows because npm, pnpm and yarn are `.cmd` shims. The Microsoft Store's `python.exe` stub prints no version, so the `py` launcher is tried next.
- **Support status from endoflife.date** for Node, Python and Go (a line's end-of-support date and its latest release); newest versions from the npm registry (npm, pnpm, yarn, bun) and GitHub releases (gh, deno, Git for Windows). Cached 12 hours in `~/.dx/cache/latest-versions.json`; offline, the installed versions are still listed. "Support ends soon" is 120 days.
- **Node's line to move to is the newest LTS**; Python's and Go's, the newest release.
- **The update command follows how a tool was installed**, read from its path (nvm, nvm-windows by `NVM_HOME`, fnm, volta, mise, asdf, pyenv, rustup, Homebrew, scoop, choco, winget, npm global, corepack). An unknown install gets advice, not a command.
- **dx never runs an update or an install itself**: the dashboard opens it in a terminal (`openTerminal`), where installers can ask for a password or a yes. `POST /api/machine/run` takes a tool (and a known project) and works the command out again; it never takes a command.
- **Project needs come from the project's own files**, the most specific first: `.nvmrc` / `.node-version` / `.tool-versions` / `volta` before `engines`, `packageManager` before lock files. An exact version in a version-manager file means its line (20.11.0 → any 20; 3.12.1 → any 3.12): a different patch isn't worth a warning. `go.mod`'s `go` line is a minimum.
- **Ranges are read by a small matcher in `versions.ts`** (`||`, hyphen ranges, `^ ~ >= <`, `x`, partial versions, `lts/*`, `lts/<codename>`), since core has no dependencies. A range it can't read is not a mismatch.
- **Without a version manager there's one Node**, so a project that wants another gets advice to install fnm, not a command that replaces the system's Node.
- **Processes: one PowerShell CIM query on Windows** (every process, for parents) plus CPU time sampled twice 500 ms apart; `ps` elsewhere. Only developer programs are listed (node, bun, deno, python, ruby, php, java, dotnet, esbuild…).
- **A tree is one entry**: a developer process whose parent is one (directly, or through a shell: npm → cmd.exe → node vite) is folded into it, with memory and CPU added up, and named by its most telling member (Vite rather than `npm run dev`). **dx's own processes split trees**: what the dashboard started is its own entry, marked **run by dx**, and stopped from the Projects page.
- **"Left behind"** means the parent is gone, or its id now belongs to a process started later (ids are reused), or it was handed to init/launchd/systemd. AI tools and editor helpers are never marked: their parent app owns them.
- **Stopping finds the process again in a fresh list** and refuses dx itself, servers dx runs and system processes; the tree goes with it (`taskkill /T`, or children first elsewhere).
- **Docker Clean up uses what `docker system df` counts as reclaimable**: `container prune`, `image prune -a` (images no container uses; a stopped container keeps its image), `builder prune -a`. The button frees what the page says. Volumes are never removed: they hold databases' data.
- **Services are only shown, with commands to copy**: stopping one or changing when it starts needs admin rights, so dx doesn't do it.

### Code: tabs and releases (`gitPage` in `web/public/app.js`, `gitReleaseState` and `gitCreateRelease` in `gitops.ts`, `runGh` in `git.ts`)

- **Four tabs by intent, one main action each**: Save (Commit), Share (Push lives in the branch bar above, always visible), Release (New release), History (none). The branch bar and the operation banner stay above the tabs. The tab is remembered (`gitTab`); counts show on Save (changed files) and Share (commits to push). A merge or rebase that stops on conflicts switches to Save, where the files are. The commit's fly-into-history animation is skipped when History is hidden.
- **Drag and drop stays, but nothing depends on it**: every commit action was already a button in the commit's detail; the hints now say so. Tags moved from the Share card to Release, with New tag, Push all and per-tag push and delete.
- **Releases go through the GitHub CLI already on the computer** (`runGh`, shared with the PR proof: fixed arguments, `GH_PROMPT_DISABLED`, input on stdin), never a token of dx's own. The tag is created (checked as any new tag, refused if it starts with `-`) and pushed first, then `gh release create <tag> --verify-tag --title=<title> --notes-file -`, the title as one `--title=` argument so it can't read as a flag, the notes on stdin. Only on the button, after a confirm naming what will happen; it can't be undone from dx (journaled as such).
- **The suggested version** (`nextVersion`): the last tag reachable from HEAD (`describe --tags`), a minor bump when a commit since starts with Add, New or `feat`, else a patch, keeping a leading v; `v0.1.0` with no tags; nothing when the last tag isn't a version. Notes start as the subjects since that tag (up to 200, no merges), editable.
- **Why there's no release**, said on the tab: gh missing (with the install command), signed out (`gh auth login`), a remote that isn't GitHub, or no remote; tags still work in every case.
- **Tests**: a stand-in `gh` shell script first on PATH checks the exact arguments and stdin (skipped on Windows, where `execFile` can't run a script as `gh`); the real gh is never run.

### Git page (`core/src/tools/git.ts` and `gitops.ts`, the Git page in `web/public/app.js`)

- **git itself, not a library**: every command runs from the repository's top folder (`rev-parse --show-toplevel`), with its arguments as an array, `--literal-pathspecs` (a file called `[ab].txt` is only that file), `GIT_TERMINAL_PROMPT=0` and, for reads, `GIT_OPTIONAL_LOCKS=0`, so polling status every 4 s never takes the index lock from git in a terminal. Long path lists go in on stdin (`--pathspec-from-file`), not the command line.
- **Only what `git status` lists can be staged or unstaged**, checked on a fresh status for each request, like cleanup's fresh scan.
- **A block is staged by its id, never by a patch from the page**: the server diffs the file again, finds the block whose hash matches, and builds the patch from git's own diff (`git apply --cached`, `--reverse` to unstage). If the file changed in between, the block is gone and the page is told to refresh (409). New, deleted, renamed and binary files, and mode changes, go whole.
- **The graph is `log --branches --remotes --tags HEAD --topo-order`**, not `--all`, so stashes don't show up as commits. `layoutGraph` is pure and tested: a lane keeps its place while it lives, a new one takes the leftmost free place, and when a branch further right waits for the same first parent, it moves over (`moves`), so the line the history follows stays on the left.
- **A merge's diff is what it brought in** (`--diff-merges=first-parent`).
- **The board is drawn optimistically**: a card moves at once and git's answer replaces it; on an error it moves back. Cards slide with FLIP through the Web Animations API (allowed by the CSP, unlike inline styles), skipped under `prefers-reduced-motion`. Polling never redraws during a drag, and the commit box is never rebuilt, so typing isn't lost.
- **Drag and drop is the browser's own** (HTML5 drag events); every drag also has a button (the arrow on a card, Stage block), for the keyboard and touch.
- **The operations live in `gitops.ts`**, behind one `POST /api/git/action` that takes an action by name. Each one checks its own arguments: branch, tag and stash names against a fresh listing (`check-ref-format` for a new one), commits resolved to a commit, paths against a fresh status.
- **An undo journal, not just the reflog**: `~/.dx/git-undo/<repo>-<hash>.json` (mode 0600, the last 50) records, before anything else, what each action needs to go back: a reset (`--soft` after a commit or amend, so the changes come back staged; `--keep` after a merge, revert, cherry-pick, rebase or pull, which refuses rather than overwrite uncommitted work), a branch or tag recreated at its old object, a stash stored again, discarded files written back from blobs dx put in git's store first. Only the newest entry can be undone, and a reset only when the branch is still where the action left it. Pushes are journaled as "can't be undone". The reflog covers the rest ("Go back here").
- **Merge previews come from `git merge-tree --write-tree --name-only`** (git 2.38+), so conflicts are named before anything is touched. With an older git the preview says it can't tell.
- **Pull is `--ff-only`**: when both sides moved, the page says to drag one branch onto the other, so merge-or-rebase is a visible choice.
- **Merge and rebase use the short branch name** (it appears in conflict markers and the merge message), and the full ref only when a tag or another ref shares the name.
- **Interactive rebase without an editor**: dx writes the todo from the plan's own hashes and sets `GIT_SEQUENCE_EDITOR` to a two-line script that copies it over git's. A reworded message goes in a file, picked up by an `exec git commit --amend -F <file>` line. A stretch with a merge in it is refused, since replaying it would flatten the merge.
- **Conflicts are resolved from the file's own text**: the page sends a choice per block and the hash of the file it saw; the server rebuilds the file from its own blocks and stages it.
- **`stash push -u` with no paths runs without `--literal-pathspecs`**: with it, git leaves new files behind (it matches its own internal pathspec literally).
- **Committing never pushes**: Push is its own button and drop target (your branch onto the remote), and the commit toast says the commit is only local until then.
- **Write message (`gitmessage.ts`) runs `claude -p --max-turns 1` only on its button**, since it sends the staged diff to the user's Claude account. `POST /api/git/suggest` takes a known project's `dir` and nothing else: the prompt (fixed text, the last 10 subjects for the style, `git diff --cached --stat` and the diff cut at 60 KB) is built on the server and goes in on stdin; the arguments are fixed. A `.cmd` shim (npm on Windows) runs through `cmd /d /s /c` with that fixed line. 60 s timeout; fences, quotes and Co-Authored-By/"Generated with"/sign-off lines are taken off the answer, which only fills the message box. The button shows only when `claude` is on PATH. Tests put a fake `claude` first on PATH and never run the real one.
- **Tags are pushed by name, never forced**: a tag the remote has on another commit is reported, not moved.
- **Not yet**: a three-way merge editor beyond picking sides, and `git bisect` with Replay.


### Activity history (`core/src/tools/activity.ts` and `activityReport.ts`, `web/src/activity.ts`, `web/src/recorder.ts`, `web/public/recorder.js`)

- **On disk, unlike the network log**: the point is a history to go back to, so it's kept, as JSON lines in `~/.dx/activity/<project>-<hash>/<day>.jsonl` (mode 0600), for `activityDays` (default 7). The dashboard keeps the last 2000 in memory for following along and writes in batches every 500 ms; the CLI and the MCP server read the files directly, so they work without the dashboard.
- **The browser side is a script the proxy adds to HTML pages**, right after `<head>`, as the page streams. That was the only no-setup way: a browser extension needs installing, and wrapping the dev server needs knowing each framework.
  - The page is asked for uncompressed so the tag can go in.
  - Nothing is added when the answer isn't 2xx HTML, when the page's CSP wouldn't run a `'self'` script, or when `activity` is off.
- **Served at `/__dx/node_modules/dx-recorder.js` with a source map listing it in `x_google_ignoreList`**, so Chrome's dev tools skip it in stacks and `console.log` keeps showing the app's own file and line. The script reports the caller's line itself, from a stack.
- **Events are accepted only with the page's own `Origin`**, bounded and masked on the server; nothing is read back. A headless page check is told apart by its user agent (`from: "check"`).
- **Never typed values**: clicks are recorded with the control's label, forms with their name and action.
- **Requests the proxy saw aren't recorded twice**: the script records only requests to other origins (`localhost:4000`, other hosts), with bodies only for loopback addresses.
- **Listed by time, followed by id.** The page sends its events in batches a second later, so ids are arrival order; sorting by `at` puts a click before the request it caused. "What's new" uses the highest id seen, not the last in the list.
- **Not recorded**: scripts, styles and images that loaded fine, WebSockets, and `/favicon.ico`.
- **Errors are sent at once, everything else within 250 ms.** A one-second batch lost the last errors when a headless check closed the tab (macOS CI caught it).
- **Size: 100 MB per project per day, then slimmed (no bodies, headers or stacks), then past 200 MB only problems; 500 MB in all (`activityMaxMB`), oldest days first.** Writing is checked per batch against the file's size, so there's no index to keep.
- **Visits** are one page load in one tab: the page's events carry its id. The page groups proxy events into them by time: a page load starts a visit, unless one started under 5 s ago and its page hasn't sent anything yet; requests and server errors join the open visit within 30 s. The dev server's own lines are groups of their own.
- **Replay** rebuilds steps from a visit (`replayFromVisit`): the page the first event was on, each click by the target the page recorded (`[data-testid]`, a unique `#id`, else `text=Label`), and, where a click changed the address within 3 s, a wait for the new address. Typed values aren't recorded, so forms are submitted as the page has them; back and forward are left out. It runs through `checkUrl` with steps, so a replay is a headless check like any other, and shows in the history as one.
- **A route change within a second of a click is that click's**, not the back button: Chrome fires `popstate` for a `#hash` link too.
- **Bug reports** take the error's visit (or, without one, the project) from 10 minutes before to 5 s after, keeping only problems and requests after it.

### Env & secrets (`core/src/tools/envaudit.ts`)

- **The rules are OWASP's secrets-management advice made concrete**: `.env`, `.env.*` (with `!.env.example` and any other example file the project has), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `id_rsa*`, `id_ed25519*`. Each is tested against the project's own root `.gitignore` with a small matcher (`matchesGitignore`) that reads lines the way git does. Not git itself: a global excludes file would hide what teammates don't have.
- **What git would actually do with each file** comes from git (`ls-files`, `check-ignore`), since nested `.gitignore` files count there.
- **Missing rules count as one problem**, not one each: one button adds them all.
- **Values are shown only on request**: the list carries names, sizes and counts; View fetches the file and hides each value until you click; Edit shows the whole text. A save keeps the file's own permissions and line endings.
- **The key scan runs on request per project** (it reads every tracked file); the page's list doesn't wait for it.

### The localhost door (`core/src/tools/devport.ts`, `web/src/frontdoor.ts`)

- **dx takes the app's usual port and moves the dev server**, rather than asking for a browser extension or a framework plugin: it's the only way that records `localhost:5173` in any browser with nothing to set up.
- **Only tools dx knows how to move**: the dev script must be one command whose tool takes a port flag (vite `--port --strictPort`, next `-p`, astro, nuxt, ng, webpack, gatsby, react-router) or `PORT` (react-scripts), with no port of its own. Anything else (a custom `dev` in `.devrc.json`, `concurrently`, `node server.js`) runs as before: a server that ignores the flag would fight dx for the port.
- **Order**: check the usual port is free, take a free hidden port from the system, open the door, then start the server with the moved command. If the server prints an address that isn't the hidden port, the door closes and the app runs where it says.
- **The Host header passes through unchanged**, so the server's links and redirects keep pointing at the usual address; Location headers naming the hidden port are rewritten anyway.
- **The dashboard shows the usual address**, with `recorded: true`; the hidden one is internal (`.localhost` routes use it).
- **Stacks aren't moved yet**: their services keep their own ports.

### Visual and Raw (`web/public/app.js`, the viewers)

- **The maintainer's rule for the whole interface: a modern, readable view first, the raw text one click away.** Every detail shows Visual by default and Raw on request; one preference for the whole dashboard (`dx.detailMode` in localStorage), and every open detail redraws when it changes (`liveDetail` keeps a set of them).
- **JSON** is a tree drawn with DOM nodes (never `innerHTML`): the first two levels open, objects and arrays fold with a count, at most 500 entries per level. A body that doesn't parse is shown as text in both modes.
- **Stacks** are parsed from V8 (`at fn (file:line:col)`) and Firefox (`fn@file:line:col`) lines; frames in `node_modules`, the runtime, Vite's deps and the recorder fold into one line. A frame in the project is a button that opens the editor (`openAt`).
- **Console lines** were joined to text in the page, so objects are found again by matching brackets and parsing what's between them.
- **A request's timing bar** is scaled to a second (longer ones fill it) and coloured fast/ok/slow at 200 ms and 1 s; its width is set through the CSSOM, which the CSP allows.

### Activity views (`web/public/app.js`)

- **Sessions, APIs, Errors, Console are views of the same events**, computed in the page from one request (up to 2000 events), so switching views doesn't reload.
- **APIs are grouped by method and path with ids folded** (`/orders/42` → `/orders/:id`; numbers, UUIDs and long hex), per project.
- **Errors are grouped by kind and message with numbers blanked**, per project; console warnings stay in Console only.
- **The dev server's own console lines** (`[vite] …`, `[HMR] …`) aren't recorded unless they're warnings or errors.

### Terminals (`core/src/tools/terminals.ts`)

- **A fixed list per system, each found where it's usually installed or on PATH**, and `terminal` in the config picks one. The default order keeps what dx did before: Windows Terminal, else Command Prompt; Terminal on macOS; `x-terminal-emulator` on Linux.
- **A command runs and the window stays open** (`cmd /k`, `-NoExit`, `sh -c "…; exec $SHELL -l"`). Warp can't be handed a command, so for one the next terminal is used.
- **If the chosen one fails to start, the next one found is tried**, so a terminal that was uninstalled doesn't break the button.

### Tests (`core/src/tools/tests.ts`)

- **Each framework's own report, never its console output**: vitest `--reporter=json --outputFile`, jest `--json --outputFile --testLocationInResults`, node:test a second TAP reporter to a file through `NODE_OPTIONS` (the usual spec output still prints), pytest `--junitxml`, go `test -json`. Anything else runs the test script and is judged by its exit code, with the end of its output.
- **`NODE_TEST_CONTEXT` is removed from the child's environment**: when dx itself runs under `node --test`, a child `node --test` would otherwise report to the parent and look like it passed.
- **Expected and actual** come from the report (node:test) or the message: jest's "Expected:/Received:", vitest's "expected X to be Y".

### Network log (`web/src/traffic.ts`, `web/src/proxy.ts`)

- **Recorded in the local domains proxy**, since every request to `shop.localhost` already passes through it. Requests to `localhost:<port>` aren't seen; page checks load the page through its `.localhost` address so they are.
- **In memory only**, the last 1000 exchanges, lost when the dashboard stops.
- **Masked before it's stored**: the authorization, cookie and API key headers, and in JSON, form and key=value bodies, keys that look like credentials (password, token, secret, api_key, session id, card number, …). Bodies are kept up to 16 KB (request) and 32 KB (response), decompressed when gzip, deflate or brotli.
- **API calls are listed by default**: requests that aren't GET, JSON/text/XML answers, and `/api/`, `/graphql`, `/trpc/` paths. Scripts, styles and images only with `all`.

### Browser flows (`checkPage` steps)

- **Real input events** (DevTools `Input.dispatchMouseEvent`, `Input.insertText`, `Input.dispatchKeyEvent`), so React and other frameworks see what a user would do; not `element.click()`.
- **Elements by selector or text**: `text=Sign in` looks at buttons, links, labels and similar first, then any element whose own text matches, exactly before partly, visible ones only.
- **Each step waits for what it caused**: a navigation it started, then a quiet network. A failed step stops the rest, since they depend on it. Errors are tagged with their step.
- **`goto` only to loopback addresses**, like the page itself.

### Database queries (`core/src/tools/db.ts`)

- **Inside the container, with its own client** (`docker compose exec -T <service> psql|mysql|redis-cli`), using the container's own user and database variables: nothing to install, no password to ask for or store.
- **Read-only twice**: a statement check (one statement, SELECT/WITH/SHOW/EXPLAIN/DESCRIBE only, no writing keyword outside quotes, no EXPLAIN ANALYZE) and a read-only session (`default_transaction_read_only` for Postgres, `SET SESSION TRANSACTION READ ONLY` for MySQL). Redis allows only a list of reading commands.
- **The SQL goes in on stdin**, never through a shell on the host.
- **The real-database test runs on Linux CI**, where Docker is available; elsewhere it's skipped.

### Year in review (`core/src/tools/year.ts`)

- **The weekly summary's data over the whole year** (1 January to the end of the year, or today), so the commit filtering, journal and pull requests work the same way.

### Browser errors (`core/src/tools/browser.ts`)

- **A browser already on the computer, driven over the DevTools protocol with Node's own WebSocket.** No Puppeteer or Playwright: they'd add a dependency tree and a 150 MB browser download, against the no-dependencies and no-setup rules. Chrome, Edge, Chromium and Brave are looked for in their usual places; `DX_BROWSER` points at another.
- **One page load, then a short settle** (1.5s, until the network is quiet) to catch errors that come after load: hydration, data fetched later.
- **Reported**: uncaught exceptions, console errors and warnings, failed requests (a missing `/favicon.ico` the browser asks for by itself doesn't count), and the text of Vite's, Next.js's or webpack's error overlay.
- **Only loopback addresses**, like `check_url`; `*.localhost` goes straight to the dev server behind it.
- **Screenshots** go to `~/.dx/screenshots` (the newest 30 are kept) and are returned to the agent as an image.

### Clone and set up (`core/src/tools/clone.ts`)

- **Named `dx clone`, not `dx setup <url>`**, because `dx setup` already connects AI tools.
- **Only git addresses get through** (`normalizeGitUrl`: https, ssh, scp-style, file:///, or GitHub's owner/repo), and git gets the URL after `--`, so it can't be read as an option.
- **The install command comes from the lock file**: npm, pnpm, yarn or bun; through corepack, or npx, when pnpm or yarn isn't installed. Python gets a `.venv` and `pip install -r requirements.txt` (or `uv sync` with a uv.lock); Go gets `go mod download`.
- **Install scripts run**, as they would by hand, so the MCP tool's description tells agents to clone only what the user asked for.
- **`GIT_TERMINAL_PROMPT=0` except in the CLI**, so a private repository fails with a "sign in with gh auth login" message instead of hanging the dashboard or an agent.

### Where you left off (`core/src/tools/sessions.ts`)

- **`~/.dx/sessions.json`, one entry per project**: when, branch, commit, what ran, errors open at stop, and a note with who wrote it (you or ai). It's written on `dx go`, on dev server start and stop, and on notes, through a temp file and a rename.
- **The branch isn't switched back for you.** `dx go` says "you were on X, now on Y" with the command; switching silently could carry uncommitted work across.
- **`dx go` shows it only after 2 hours away**, so it isn't noise when you restart a server.

### Unsaved work (`core/src/tools/status.ts`)

- **"Unpushed" means commits no remote has** (`rev-list --not --remotes`), on any local branch, not only the current one's upstream: a branch never pushed counts too.
- **Worktrees share one repository**, so each worktree counts only its own branch, and the main checkout counts the branches no worktree has checked out. Otherwise every worktree reported the same commits.

### `.env` and secrets (`core/src/tools/envcheck.ts`)

- **Patterns match the shape of real credentials only** (AKIA…, ghp_…, sk-ant-…, -----BEGIN PRIVATE KEY-----), so placeholders like `your-key-here` don't match.
- **Values are never shown whole**: the first few characters and the length.
- **Only files git tracks are scanned**, since those are the ones that leak; lock files, minified files and binaries are skipped.
- **Tests build fake keys from pieces** (`"gh" + "p_" + …`), so the repository itself never holds a key-shaped string.

### Local HTTPS (`core/src/tools/https.ts`, `web/src/proxy.ts`)

- **mkcert, opt-in.** Node can't add a certificate authority to the system's trust store, and doing that is a security change, so it's `dx https`, never automatic. `dx doctor` gives the install command.
- **No `*.localhost` wildcard**: browsers reject wildcards that sit right under a top-level name. The certificate lists each project (`shop.localhost`) and its services (`*.shop.localhost`).
- **A name the certificate doesn't cover is added when it's first asked for**: the proxy's SNI callback runs mkcert again and swaps in the new certificate. No restart is needed for a new project.
- **https on 443, falling back to 1356**; when it's on, dev servers' `localUrl` and `DX_*_PUBLIC_URL` use https.

### Deps for yarn and bun, and `--fix`

- **yarn and bun are checked against the registry directly**: `/<name>/latest` for versions, and the bulk advisory endpoint (`/-/npm/v1/security/advisories/bulk`, the one npm audit uses) for the installed versions in node_modules, nested ones included. Their own CLIs print different formats from version to version.
- **`--fix` stays within the ranges**: `npm update` + `npm audit fix` (never `--force`), `pnpm update`, `bun update`, `yarn upgrade` (or `yarn up -R` on yarn 2+). Major versions are listed for the user, since they can need code changes.

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
- **A port another dev server dx runs has, or was given, isn't this one's** (`portOwner` in `dev.ts`): the maintainer started two projects with the same usual port and both `name.localhost` names opened the first. The "already busy" check runs once at launch, so two started before either listened both kept the guessed port, the second quietly moved, and dx saw the port open and took it as the second's. Now the second is given a free port (`PORT`, as snapshots are) and a port owned by another is never taken as ready; `twoservers.test.ts` reproduces it.
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
- **After an update, an older background dashboard is replaced** (`ensureDashboard` in `link.ts`): the maintainer updated dx and still saw the old version, since the dashboard kept running. `dashboard.json` and `/api/ping` carry the version; one from an older dx (or with none, from before 1.7.3) is stopped, this version's started, and the dev servers it ran (starting or ready, by project, an AI's still labelled AI) started again. Never a newer one: an AI tool's MCP server can still be the old dx after an update, and must not downgrade the dashboard. Never one running in a terminal (`dx ui --no-open`): `dx ui` says how to switch instead. A linked build has the same version on every rebuild, so rebuilding doesn't restart it.
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

- **`where` on Windows also lists a file with no extension**: npm installs a Git Bash script (`npm\claude`) next to each `claude.cmd`, and `where claude` lists it first; spawning it fails with ENOENT. `commandExists` puts PATHEXT matches first (`runnableFirst`). Seen on the maintainer's other computer, where Claude Code came from npm.
- **Clipboard on Windows**: `clip.exe` pastes a UTF-8 BOM as a visible character. Write UTF-16LE without a BOM.
- **Shell-mangled regexes**: tests built through a shell lost their backslashes; prefer `includes` checks in tests over regexes that pass through a shell.
- **Editing code through a shell breaks escapes**: `\n`, `\r` and `\\` in a python/sed/heredoc edit came out as real line breaks or lost backslashes, several times. Edit `.ts` and `.js` files with an editor tool, not a shell script.
- **`Number(null)` is 0**: a missing query value (`URLSearchParams.get` gives null) read as a number became 0, not the default. `clampInt` in `api.ts` treats null and "" as not given.
- **git checks files out with CRLF on Windows** (`core.autocrlf`): compare file contents in tests after `.replace(/\r\n/g, "\n")`.
- **The dashboard was blank** because `append` was called with an array where it takes `...children`. Keep the signature `append(el, ...children)`.
- **Horizontal scroll at phone width** came from a visually hidden `th` label positioned against the page. `.table-wrap { position: relative }` contains it.
- **LF/CRLF warnings** on commit are harmless (`core.autocrlf`).
- **Node 22 on CI, 24 locally**: the code avoids anything newer than 22.
