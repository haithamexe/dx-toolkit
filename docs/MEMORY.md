# Project memory

What was decided while building dx, and why, so the next session doesn't relearn it. Newest first within each section. Update it when a decision is made or the backlog changes.

## Where it stands (Nov 2026)

- CI is green on Windows, macOS and Linux × Node 22 and 24.
- **On npm** as `dx-devkit` since 1.1.0: `npm install -g dx-devkit`.
- **Built**:
  - the core tools;
  - the `dx` command: `ui, go, resume, up, down, new, clone, projects, status, port, kill, log, summary, clean, deps, test, env, db, logs, errors, traffic, activity, terminal, git, machine, setup, https, config, runs, doctor`;
  - the MCP server with 31 tools, 15 of them for running and checking apps;
  - stacks and local domains (`shop.localhost`), with opt-in https;
  - the dashboard with 12 pages (Projects, New project, Ports, Machine, Git, Activity, Env & secrets, Journal, Summary, Cleanup, Dependencies, Health & settings);
  - the activity history (requests, routes, clicks, console, errors, kept 7 days) and opening projects in a terminal you pick;
  - error detection in dev-server output, and in the browser (headless check);
  - clone-and-set-up, where you left off, unsaved work, `.env` and secrets checks, `dx deps --fix` (yarn and bun too);
  - tests read from each framework's report, a network log from the proxy, browser flows, read-only database queries, the year in review;
  - setting itself up with no configuration.
- **Latest release**: 1.4.0. Under *Unreleased*: the Git page (staging board and commit graph) and `dx git`; the Machine page, `dx machine` and `machine_info`.
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

### Git page (`core/src/tools/git.ts`, the Git page in `web/public/app.js`)

- **git itself, not a library**: every command runs from the repository's top folder (`rev-parse --show-toplevel`), with its arguments as an array, `--literal-pathspecs` (a file called `[ab].txt` is only that file), `GIT_TERMINAL_PROMPT=0` and, for reads, `GIT_OPTIONAL_LOCKS=0`, so polling status every 4 s never takes the index lock from git in a terminal. Long path lists go in on stdin (`--pathspec-from-file`), not the command line.
- **Only what `git status` lists can be staged or unstaged**, checked on a fresh status for each request, like cleanup's fresh scan.
- **A block is staged by its id, never by a patch from the page**: the server diffs the file again, finds the block whose hash matches, and builds the patch from git's own diff (`git apply --cached`, `--reverse` to unstage). If the file changed in between, the block is gone and the page is told to refresh (409). New, deleted, renamed and binary files, and mode changes, go whole.
- **The graph is `log --branches --remotes --tags HEAD --topo-order`**, not `--all`, so stashes don't show up as commits. `layoutGraph` is pure and tested: a lane keeps its place while it lives, a new one takes the leftmost free place, and when a branch further right waits for the same first parent, it moves over (`moves`), so the line the history follows stays on the left.
- **A merge's diff is what it brought in** (`--diff-merges=first-parent`).
- **The board is drawn optimistically**: a card moves at once and git's answer replaces it; on an error it moves back. Cards slide with FLIP through the Web Animations API (allowed by the CSP, unlike inline styles), skipped under `prefers-reduced-motion`. Polling never redraws during a drag, and the commit box is never rebuilt, so typing isn't lost.
- **Drag and drop is the browser's own** (HTML5 drag events); every drag also has a button (the arrow on a card, Stage block), for the keyboard and touch.
- **Not yet**: push, pull, branches, merging by dragging, undo, discarding changes. Those change more than the index and want their own safety (undo through the reflog first).


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
