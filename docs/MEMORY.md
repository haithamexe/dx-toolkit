# Project memory

What was decided while building dx, and why, so the next session doesn't relearn it. Newest first within each section. Update it when a decision is made or the backlog changes.

## Where it stands (Nov 2026)

- CI is green on Windows, macOS and Linux × Node 22 and 24.
- **On npm** as `dx-devkit` since 1.1.0: `npm install -g dx-devkit`.
- **Built**:
  - the core tools;
  - the `dx` command: `ui, go, run, resume, up, down, new, clone, projects, status, port, kill, log, summary, clean, deps, test, env, db, logs, errors, fix, traffic, activity, bug, mock, terminal, git, visual, machine, browser, sites, setup, https, config, runs, doctor`;
  - the MCP server with 32 tools, 15 of them for running and checking apps;
  - stacks and local domains (`shop.localhost`), with opt-in https;
  - the dashboard with 12 pages (Projects, New project, Ports, Machine, Git, Activity, Env & secrets, Journal, Summary, Cleanup, Dependencies, Health & settings);
  - the activity history (requests, routes, clicks, console, errors, kept 7 days), for deployed sites too through the dx browser, and opening projects in a terminal you pick;
  - error detection in dev-server output, and in the browser (headless check);
  - clone-and-set-up, where you left off, unsaved work, `.env` and secrets checks, `dx deps --fix` (yarn and bun too);
  - tests read from each framework's report, a network log from the proxy, browser flows, read-only database queries, the year in review;
  - setting itself up with no configuration.
- **Latest release**: 1.4.0. Under *Unreleased*: the Git page (staging board, commit graph, and git operations by drag and drop with undo) and `dx git`; the Machine page, `dx machine` and `machine_info`; Ask Claude to fix and `dx fix`; Run any commit (snapshots, time travel on the Activity page) and `dx run`; the dx browser and recorded sites (`dx browser`, `dx sites`) and the two-column Activity page; the AI lane (every MCP call recorded, Interrupt, Take over, By AI on the Activity page); Your year (the year as a story on the Summary page); visual diffs per commit on the Git page, `dx visual` and `visual_diff`.
- **This is a public, open-source repository.** Nothing personal goes in it: no real names, emails, usernames, machine paths or names of anyone's own projects. Examples use neutral names (`todo-app`, `shop-website`, `api-gateway`, `octocat`), paths use `~` or `/path/to/dx-toolkit`, and test fixtures are built in temp folders.

## Backlog

- **Raycast**: the extension type-checks (six commands, Work Summary and Clean Up Projects added), but has never been run in Raycast itself.
- **`dx https` end to end**: the proxy's https is tested with a throwaway openssl certificate; the real `mkcert -install` path hasn't been run on a maintainer machine (it changes the system trust store, so it needs the maintainer's go-ahead).
- **Coverage in `dx test`**, and screenshot comparison before and after a change.
- **Terminals beyond Windows**: Command Prompt, Windows PowerShell and Git Bash were opened for real on Windows; the macOS (iTerm2, Warp, Ghostty, kitty) and Linux launch commands are written from each one's documentation and haven't been run on those systems.
- **The localhost door for stacks**: single-project dev servers are recorded at `localhost:<port>`; a stack's front end isn't moved yet. Next.js, Astro, Nuxt, Angular, webpack and Gatsby are moved by the documented flag but only Vite was tried for real.
- **MongoDB in `dx db`**: only Postgres, MySQL/MariaDB and Redis today.
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
  - **1.4.0** adds the Env & secrets page, recording at `localhost:<port>` (the localhost door), and the Activity views.
  - **1.3.0** adds the activity history (with Replay and bug reports), opening projects in a terminal you pick, `dx test`, the network log, browser flows, `dx db` and the year in review.
  - **1.2.0** adds browser errors, `dx clone`, resume and notes, `dx status`, `dx env`, `dx https` and `dx deps --fix`.
  - **1.1.0** is the first on npm, as `dx-devkit`. npm refused `dxkit` as too close to existing names (degit, pdfkit). A free name (`npm view <name>` gives E404) can still be refused: the look-alike check only runs on a real publish, and short names fail it most.
  - **Nothing is released until the maintainer says the features are done.** New work is built, committed and tested locally first; the maintainer's own `dx` runs this repository's build (`npm run link`) so they try each feature before it goes out. No release or npm publish after a single feature.
  - **To release**: add each change to `CHANGELOG.md` under *Unreleased*. When a release is asked for, the agent doing it carries it through, publishing included:
    1. wait for CI to be green on the last commit;
    2. bump every `package.json` (and the lockfile), and move *Unreleased* to a dated `## X.Y.Z` section with a one-line intro;
    3. `npm run release`, then `node scripts/smoke-package.mjs`;
    4. commit "Release X.Y.Z", tag `vX.Y.Z`, push both;
    5. **`.github/workflows/release.yml` does the rest on the tag**: checks the tag against every `package.json` and the changelog, runs the tests, builds and test-installs, `npm publish ./release --provenance`, installs it back from npm (`smoke-package.mjs --from-npm`), and `gh release create` with that changelog section (`scripts/release-notes.mjs`) titled "dx X.Y.Z". Re-running skips what's done;
    6. the agent watches that run and confirms the version on the registry (`https://registry.npmjs.org/dx-devkit`) and the GitHub release.

    **npm trusted publishing** (OIDC) means no npm token anywhere: npmjs.com's package settings name this repository and `release.yml`, set up once by the maintainer. The workflow upgrades npm (trusted publishing needs npm 11.5.1+). By hand, as a fallback, uses the maintainer's own logins on their machine; the agent never logs in or handles a token itself. npm answers a publish without a login with **404 Not Found**, not 401; so does a publish from CI before trusted publishing is set up.
- **README screenshots** (`docs/images/`) come from made-up demo projects under a neutral author, taken with headless Edge/Chrome (`--screenshot`, `--blink-settings=preferredColorScheme=0|1`). Retake them the same way when a page changes; never from real projects.

## Decisions

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
- **Its own port**: `moveDevPort` with a free port when the tool is known, else `PORT=<free port>` (ready when that port opens, or at the address it prints). No localhost door: the usual port belongs to the project's own dev server. A stack runs as it is (its services may want the same ports).
- **The run answers once the commit resolves**; the checkout and install go on in the background, and the page follows `GET /api/snapshots` (step, the install's last lines). A failed install keeps the snapshot so it can be retried or removed.
- **Time travel reads the reflog** (`log -g --date=unix`, the newest entry at or before the moment), falling back to the last commit before then on HEAD. The slider spans the events shown; events within max(30 s, span/60) count as around it.
- **Not yet**: snapshots stay until removed (no automatic clean-up); Python and other non-Node projects aren't set up beyond the checkout.

### Ask Claude to fix (`core/src/tools/fixer.ts`, `claude.ts`, `web/src/fixes.ts`, `/api/fix/*`)

- **Claude Code through `claude -p --max-turns 1`, like Write message**: the runner is shared (`claude.ts`), arguments fixed, prompt on stdin, 90 s timeout. The `claude` lookup is cached a minute, and looked up again when PATH changes (tests put a fake one first on PATH).
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

- **Clipboard on Windows**: `clip.exe` pastes a UTF-8 BOM as a visible character. Write UTF-16LE without a BOM.
- **Shell-mangled regexes**: tests built through a shell lost their backslashes; prefer `includes` checks in tests over regexes that pass through a shell.
- **Editing code through a shell breaks escapes**: `\n`, `\r` and `\\` in a python/sed/heredoc edit came out as real line breaks or lost backslashes, several times. Edit `.ts` and `.js` files with an editor tool, not a shell script.
- **`Number(null)` is 0**: a missing query value (`URLSearchParams.get` gives null) read as a number became 0, not the default. `clampInt` in `api.ts` treats null and "" as not given.
- **git checks files out with CRLF on Windows** (`core.autocrlf`): compare file contents in tests after `.replace(/\r\n/g, "\n")`.
- **The dashboard was blank** because `append` was called with an array where it takes `...children`. Keep the signature `append(el, ...children)`.
- **Horizontal scroll at phone width** came from a visually hidden `th` label positioned against the page. `.table-wrap { position: relative }` contains it.
- **LF/CRLF warnings** on commit are harmless (`core.autocrlf`).
- **Node 22 on CI, 24 locally**: the code avoids anything newer than 22.
