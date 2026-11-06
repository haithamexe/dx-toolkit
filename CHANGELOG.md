# Changelog

Notable changes to dx, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Changed

- **The dashboard is arranged by what you came to do.** Pick a project at the top of the sidebar, and every page under it is about that project: **Overview** (run it, its output and errors, its API spec and its tour), **Code**, **API**, **Activity**, **Data**, **Break it** and **Env & secrets**. Before, six pages each had their own project picker and their own memory. Under **Everything**: **All projects** (with New project), **This computer** (Machine, Ports, Cleanup and Dependencies as tabs) and **Look back** (Summary and Journal). **Settings** is at the foot, and the theme moved there. Old links still work.
- **Code** (the Git page) is four tabs, each with one main action, under a branch bar with Fetch, Pull, Push and Undo: **Save** (the commit board and the shelf), **Share** (branches, merge and rebase, proof for the pull request), **Release** and **History** (the graph, Run any commit, and the undo history). Every commit action has a button as well as a drop target, and a merge that stops on conflicts opens Save.

### Added

- **Releases** on the Code page: **New release** suggests the next version from the last tag and notes from the commits since, then tags, pushes the tag and creates the GitHub release through the GitHub CLI, only on the button and after saying what it will do (Draft and Pre-release too). **Only tag it** makes the tag alone. Tags are listed, made, pushed and deleted there, where before they could only be made by dragging a commit.
- **An API spec on every project, with nothing to set up**: dx finds an OpenAPI or Swagger file in the project, or the running app's usual spec address, and keeps it with the project; you can still give it one on the API page, and removing it is remembered. Overview shows it, Activity's APIs view names each call by its endpoint and marks calls it doesn't have, the tour lists it, and mocks, Break it's unused routes and the AI agents' `api_map` use it.

- **A line beside Floppy** says what's going on and in which project, always, so you don't have to read its face: `todo-app running`, `shop-website: Install packages…`, `todo-app: error in cart.ts:42`, `AI: Checked /health on api-gateway: 200`, with a coloured dot. Errors you've already looked at stay counted (`todo-app running · 1 error`). Hover it for the balloon, click it to open dx.
- **Run Floppy** in the dashboard: a button beside the Floppy at the bottom of the sidebar, shown on Windows while Floppy isn't on the desktop. It does what `dx floppy` does, so it also brings back a Floppy you'd sent away.

## 1.5.0 (2026-11-06)

dx is an app now: `dx ui` opens it in a window of its own that starts with you, with Floppy on the taskbar and a new teal look. Also new since 1.4.0: the Git page, the Machine page, Chaos, Run any commit, the dx browser for deployed sites, Ask Claude to fix, the AI lane and Your year. Update with `npm install -g dx-devkit@latest`.

### Added

- **Floppy** (`dx floppy`): a pixel-art floppy disk that sits on your Windows taskbar and shows what dx is doing: a project starting (a progress bar on its label), a server coming up (a hop), an error (red eyes and a balloon with the file and line, until you look), an AI agent at work, asleep after 30 quiet minutes. Click it to open the dx app; drag it along the taskbar; right-click for Quiet for an hour, Start with Windows and Quit. It starts with Windows from the first run (a shortcut in your Startup folder, removed with `--no-startup`), hides while something is full screen, and doesn't keep a background dashboard running. Nothing to install: Windows PowerShell and WPF.
- **The dx app**: `dx ui` opens dx in a window of its own, with Floppy as its icon, a Start menu entry you can pin, and no browser around it; the dashboard runs behind it in the background, so the terminal is free. It opens on the taskbar or Dock when you sign in (a Startup shortcut on Windows, a LaunchAgent on macOS, an autostart entry on Linux; set the first time, `dx ui --no-startup` turns it off). The window is Electron, one pinned version installed into `~/.dx/app` the first time (a 100 MB download), so the npm package stays small; until then, or if it can't download, an Edge app window. Only the dashboard's own address loads in it, links open in your browser, and the page has no Node and no permission but the clipboard. When the dashboard stops, the window says so, with **Start dx**. On Windows it runs as `dx.exe`, with dx's name and Floppy's icon (written in by rcedit, installed with Electron), on macOS as `dx.app`, and on Linux through a launcher entry named dx, so nothing says Electron. Electron updates come with dx: a newer pinned one installs next to the running app, which switches the next time it opens; a release checks the pin is Electron's newest (`scripts/check-electron.mjs`). Floppy comes with it, unless you sent Floppy away. The page scrolls inside the window and the sidebar stays put. `dx ui --browser` opens your browser this once; `dx ui --remove-app` removes the app. Floppy's click opens it too. `dx doctor` reports it.
- **Languages** on the Chaos page: **Pseudo text** makes every text on the app's pages longer and accented, as German or Finnish run ("[Šàṽé ~~~~]"), and **Right to left** flips them, in your own browser through dx. **Check the pages** loads each page as it is, with pseudo text and right to left in a headless browser, and reports text that's cut off or spills out of its box (outlined in a picture) and text that isn't in the project's translation files (JSON, YAML, .po; placeholders and ICU plurals understood), with its file and line. Text from the app's own API answers is left out. `dx chaos languages`, and the `translation_check` MCP tool.
- **Tour**: a new page (and `dx tour`) with a map of a project for someone new to it: what it is and what it's built with, how to run it, its pages with the API calls each makes (from the history) and the file that answers each call, its database tables, the settings it needs (names only), its folders and where the work happens. **Copy as Markdown**. The `project_tour` MCP tool.
- **Proof for the pull request** on the Git page (and `dx proof`): the "how was this tested" section, from what dx saw on the branch: the last test run, the pages tried, errors and which still came after the last commit, visual, speed and accessibility changes, and dx's other checks. Copy it, or **Add to the pull request** through the GitHub CLI (dx's own section, replaced on later runs). The `pr_proof` MCP tool.
- **Try an upgrade**: **Try it** next to each outdated package on the Dependencies page (and `dx try <project> <package>@<version>`) upgrades it in a throwaway copy of the working copy, runs the type check, build and tests before and after, and compares the copy's pages with your running app: looks, calls, errors, speed and accessibility. Your own folder and node_modules aren't touched. The `try_upgrade` MCP tool.
- **Queries per request** on the Data page (and `dx queries`): the compose Postgres or MySQL's own statement log switched on, and each statement matched to the request it ran in: N+1 (the same query 10+ times), slow queries (200 ms+) and busy requests (50+). Values are taken out of every statement; switching it off puts the setting back. The `db_queries` MCP tool.
- **Realistic data**: the Data page and `dx data` read a project's Prisma schema (or CREATE TABLE in its SQL migrations) and make believable, connected rows (users with orders, orders with items) with the edge cases that break apps: an empty one, a 200-character name, emoji, missing optional values, a deleted user who still has orders. Recipes (Typical, Big customer, First-time user, Empty), seeded; named scenes to switch between in seconds; **Save the data that's there**. Before a scene goes in, the current data is saved as a backup scene. Only a database on this computer, through the project's own Prisma client or its docker-compose Postgres/MySQL. The `realistic_data` MCP tool.
- **Attack my app**: Security on the Chaos page and `dx attack` try the requests and pages in the history against the project's own dev server: unescaped script (reflected and stored, confirmed in a headless browser), calls that answer without signing in, another record's id, CSRF, CORS, cookie flags, security headers, stack traces, SQL errors and logins without a rate limit. Each finding has the request that shows it, the fix, and the route's file and line. A session can be given for signed-in calls (used for that run only), and a read-only run skips what changes data. The `security_check` MCP tool.
- **Your real phone as a test device**: **On my phone** on a running project's card (and `dx phone`, with the QR code in the terminal) opens the app on your phone over Wi-Fi, for one project and 30 minutes, through a one-time link that becomes a cookie only that session accepts. What the phone does shows up on the card and in Activity, labelled phone. dx listens on this computer's local address only then, and forwards only to that project's dev server.
- **Speed and accessibility per commit**: each visual-diff capture also measures the page (largest paint, load, main-thread blocking, layout shift, JavaScript size) and checks it for accessibility problems (alt text, labels, names, contrast, lang, heading levels, tabindex, duplicate ids). The Git graph marks a commit **slower** or **a11y** when it made a page clearly worse, and its detail shows before and after. In `dx visual` and the `visual_diff` MCP tool too.

### Fixed

- **Running a commit of a stack** (Run any commit, and the copy an upgrade is tried in) uses the project's own Docker services and runs its app services on ports of their own. Before, the copy started on the project's port, and stopping it could stop the project's database when the compose file names its project.
- The Security tab on the Chaos page now follows a run to its end, as the other tabs do.
- Buttons that are meant to be hidden stay hidden (Write message on the Git page when Claude Code isn't installed).
- **Queries per request missed a request already under way when logging was switched on**, and counted all its statements as outside every request. Every request still being answered then counts now.
- **On Linux with Node 24 the Machine page listed no Node processes**: Node 24 names its main thread "MainThread", so the name now also comes from the command line.
- **Run any commit failed on Windows when a folder had a short name** (`C:\Users\RUNNER~1`): paths are compared as real paths.
- **A past year's review counted later work.** `dx summary --year 2025` (and the Summary page, and `work_summary`) included commits and journal entries made after that year; now a summary that ends on a day of its own stops there.

### Changed

- **A new look for the dashboard**: the app now sits like a window on a teal desktop with a faint pixel grid, with Floppy as the logo and favicon. One teal colour scale for light and dark, Geist and Geist Mono for text and code, Silkscreen pixel labels on table headings, larger light numbers, and a yellow pip on the current page. The fonts ship with dx, so the dashboard still loads nothing from the internet.
- The history keeps a set cookie's name and flags (HttpOnly, Secure, SameSite), never its value; before, the whole header was masked.

- **The Chaos page: break the app on purpose, before your users do.**
  - **Chaos mode** breaks a project's API calls as they pass through dx the way real networks and servers do: slow answers, 500s, connections dropped halfway, a 401 halfway through (an expired session), answers out of order, 429s and odd data (a field null, empty, -1 or 10,000 characters long). Pages, scripts and styles always load. Three levels (Bad Wi-Fi, Monday deploy, Black Friday) or the faults you pick, for every API call or a path pattern. Seeded, so the same seed breaks the same calls the same way, and **Start the run again** meets them again. **What broke** lists pages that went blank, errors nothing caught, loading indicators still spinning after 15 s and the same order sent twice, each with the chaos that hit first and a link to the visit.
  - **Gremlins**: a headless browser goes through the app on its own, clicking, typing nonsense, double-clicking submit, pressing Enter and going back, and brings back each problem with the steps to reproduce it (**Replay**, **Copy steps**). Destructive-looking controls are left alone unless you ask. Seeded.
  - **Clock**: the app's pages see another time and time zone (`Date`, `Date.now()`, formatting), with presets for New Year's Eve, a leap day, daylight-saving changes, UTC+14 and UTC−11, and 2038. Optionally frozen.
  - **Weak phone**: every dx browser tab, and Gremlins, as a cheap phone on 3G (390 × 844 with touch, CPU 6× slower, Chrome's Fast 3G).
  - **Missing values**: the app started once as it is and once per `.env` value with only that value blank, on a port of its own; which values crash it, break the page, go unnoticed, or are never used in the code. `.env` isn't changed.
  - **Behaviour diff**: the working copy and an earlier commit (as a snapshot) loading the same pages, with their API calls, answers, errors and warnings compared.
  - **Graveyard**: routes the code declares (Express, Fastify, Hono, Next.js, SvelteKit, Nuxt, FastAPI, Flask, the saved API spec), pages from file-based routing and router paths, and mocks, that nothing used in the activity history.
  - The page notices for itself when it went blank or a spinner never stopped, so these show in Activity too. Page checks can now double-click and go back as steps.
  - `dx chaos on|off|clock|phone|gremlins|env|diff|graveyard`, and the `chaos_mode`, `run_gremlins`, `behaviour_diff`, `env_values_that_matter` and `find_unused` MCP tools.

- **Run gets the project ready first**, so Run works on a fresh clone or after a pull: packages installed when they're missing or the lock file changed, `.env` made from its example, Docker running for a stack's databases, `prisma generate`, workspace packages built, migrations applied (only to a database on this computer, never with a script that resets or seeds), and the usual port checked. Each step shows on the project's card with its output; a failed one stops the start and says why and how to fix it. `dx prepare <project>` shows or runs the plan, and `.devrc.json` adds steps of the project's own (`"prepare": [...]`) or turns it off.

- **The Requests page**: Burp- and Postman-style tools for the app you run.
  - **Rules** (match and replace): for a method and path, change the request or its answer on the way (headers, JSON fields, the body, the status), add a delay, or make it fail with a 500, never answer, or drop the connection. Changed calls are marked in Activity.
  - **Intercept**: hold matching requests or answers, edit them, then send them on or drop them; they go on by themselves after a minute.
  - **Repeater**: edit and resend any request to the dev server, and see the answer Visual or Raw. **Edit and resend** and **Make a rule** on every request in Activity.
  - **API spec**: an OpenAPI or Swagger spec (JSON or YAML) found in the project, read from the running app, or pasted. The **API map** shows each endpoint's calls, answers that don't fit the spec, and calls that aren't in it.
  - **Mock server**: the project's mocks at an address of their own (`localhost:4010` and `<project>.mock.localhost`), answering from the first call with or without the back end, like a Postman mock server. Mocks come from the spec's examples, data made up from its schemas, a **cache** of real answers kept until you purge it, recordings, or **Write data** by Claude Code or Codex. Pick an answer with `x-mock-response-code` or `x-mock-response-name`.
  - `dx mock spec|server|cache|purge`, and the `api_map` and `mock_server` MCP tools.

- **`dx update`**: updates dx to the newest version and cleans up first, so npm no longer stops with EEXIST (another or half-removed install owns the `dx` command) or EPERM (a dx process still runs from it). It removes the other install and its leftover shims, and asks before stopping dx processes. `npx -y dx-devkit@latest update` does the same when `dx` won't start, and `dx doctor` warns about two installs or leftover shims. In a clone, `npm run link` and `npm run unlink` switch between your build and the npm package the same way.

- **A visual diff for every commit.** While dx runs a project's dev server, each commit made on the Git page (or HEAD moving under it, from a terminal) is captured: the pages you used most in the last day, screenshotted in a headless Chrome, Edge, Chromium or Brave at a fixed size with animations off once the network is quiet, and compared with the commit before's. The graph shows a small picture in the commit's row and an orange ring on its dot when the look changed; open it for before and after as a wipe, side by side, or the changed pixels, with "12% of the page changed, around the Checkout button" (Raw: the numbers and files). **Capture now** on the Git page, `dx visual <project>` (`--pages`, `--capture`), and the `visual_diff` MCP tool with the diff image. Kept under `~/.dx/visual`, the newest 30 commits per project; off with **Visual diffs** in Health & settings (`visualDiff`), phone size too with `visualMobile`.
- **The AI lane: watch what your AI agent does, live.** Every tool call the MCP server handles is recorded in `~/.dx/runs.jsonl` as `mcp.<tool>`, with a sentence saying what the agent did, the project, a short secret-free summary of its arguments, ok or failed, and how long it took (`dx runs` lists them). While an agent is active, a panel slides in at the dashboard's right edge with that feed ("Started shop-website's dev server", "Loaded /checkout on shop-website: 2 errors"), each line linking to the server's card, the Activity page or the page it touched. **Interrupt** stops every dev server the agent started, after a confirm naming them; **Take over** makes one of its servers yours. It collapses to a tab, remembered. The Activity page's new **By AI** filter shows only the agent's page checks, with its other calls in between.
- **Your year as a story.** The Summary page's **Your year** (with a year picker) shows the year one card at a time: commits, active days and the longest streak, the busiest week, a heat map of when you code, the project of each month, the most-touched files, bugs squashed, the biggest day, languages by files changed, time with dev servers running, the first and latest commit, your journal's most-used words and your AI agent's calls. Light and dark, phone-sized, with a count-up and fade-in unless you've asked for reduced motion. Copy as markdown and Save include the new numbers, and so does `dx summary --year` (and its `--json`). Built from your own commits on this computer; nothing leaves it.

- **Bug reports a teammate can replay.** **Download bug bundle** on an error or a visit on the Activity page (or `dx bug export <project> <event-id>`) saves a `.dxbug.json` file: the visit's steps, the requests around the error with their masked payloads and answers, the console and errors, the error, and the commit you were on then, with its branch and whether there were uncommitted changes. No hosts, cookies, tokens, `.env` values or folders of yours: stack paths are made relative to the project. **Open a bug bundle** (or drop the file on the page) replays it: dx runs its commit as a snapshot (or your working copy), waits for the dev server and does the steps in a headless browser, then shows the original error next to what happened now, "Reproduced: the same error at src/cart.js:12" or "Not reproduced". The bundle is checked field by field, its commit must be in your repository, and its steps run only on your own dev server. `dx bug replay <file> [project]` in the terminal.
- **Mock mode.** Answer a project's API from recorded traffic, so its front end runs without the back end: **Make mocks** from a visit or the last hour, then **Turn on** in the Activity page's Mock mode panel (or `dx mock make|on|off|list|clear <project>`). Endpoints are matched by method and path with ids folded (`/orders/:id`), and by query or body where the recordings differed. Page loads and assets still come from the dev server; calls with no mock go there too, or get a 404 in strict mode. Edit each endpoint's status, delay, content type and body (checked as JSON, shown as a tree), or use **Fail with 500**, **Empty list**, **Slow (3 s)**, **Offline** and **Reset to recorded**. The Projects page shows **Mocked: N endpoints** while it's on, and mocked answers are marked in the network log and the activity history.
- **Record deployed sites in the dx browser.** **Record a site** on the Activity page (or `dx sites add staging.shop-website.dev --project shop-website --env staging`), then **Open dx browser** (`dx browser <url>`): a Chrome, Edge, Chromium or Brave window with a profile of its own, whose sign-ins persist. On the sites you chose, and apps on this computer, it records the same history as your local apps (requests with payloads and responses, pages, routes, clicks, console, errors), masked before it's written, labelled with the site and its environment, and under the project the site belongs to. Anything else you browse there isn't recorded. dx drives it over a pipe, not a port, so no other program can. A visit shows which deployment answered when the site says so (`x-commit`, `x-version`, `x-vercel-deployment-url`, a `<meta name="version">`…), with **Run this commit** when your repository has it. `dx sites list|remove`, `dx activity --site/--env`, and `site`/`env` on the `activity_log` MCP tool.
- **A more compact Activity page**, organised like opening a project: projects and recorded sites on the left with their environments, counts and **Open in dx browser**, the chosen one's timeline on the right, one line per event, with a filter for local and each environment. Under 860px the list becomes a select.
- **Run any commit**: search commits on the Git page by message, hash, author or a file they changed, and **Run this commit** (from a result, a commit's detail, or by dragging it onto the dock). dx checks it out in its own folder under `~/.dx/snapshots` and runs its dev server on a port of its own, next to yours, without touching your working copy. `node_modules` is linked in when the lock file is the same as now, and installed as locked otherwise; your untracked `.env` files are copied in. Snapshots show on the Projects page as `shop-website @ abc1234`, with their output, errors and **Remove**. On the Activity page, **time travel**: drag to a moment, see what happened around it and the commit you were on then, and **Run it as it was then**. `dx run <project> <commit>`, `dx run --list` and `dx run --remove <id>` in the terminal.
- **Ask Claude to fix**, when Claude Code is installed: on a dev server's error (Projects page) or an exception, server error or console error (the Activity page's Errors view), dx sends the error, the code around it, the files in its stack and your uncommitted changes to Claude Code, and shows the patch it proposes with its explanation, Visual side by side or Raw. Nothing changes until you click **Apply fix**; the change lands as ordinary unstaged changes on the Git page, and Undo puts the files back. A patch that doesn't fit the files is shown with why and Claude's own answer, with **Ask again**. It only runs when you click. `dx fix <project>` prints the patch for the newest error without applying it.
- **Git page** in the dashboard:
  - **A staging board.** A project's changed files are cards in **Changes** and **Staged**. Drag them across, press the arrow on a card, or pick several with Ctrl+click and Shift+click. Cards slide to their new place; under "reduce motion" they don't.
  - **One block at a time.** Open a file to see its changes side by side and stage or unstage one block, by its button or by dragging it.
  - **Commit** from the page, with Ctrl+Enter. The committed cards fly into the history, where the new commit appears.
  - **The history as a graph**: every branch, tag and remote branch in its own coloured lane. Open a commit for its message and its diff, Visual side by side or Raw.
  - Changes you make in your editor or a terminal show up by themselves.
  - **Branches by dragging.** Drop a branch onto the one you're on to merge it, after a preview of the commits that come in and the files that would conflict (from `git merge-tree`, without touching any file). Choose Merge, Squash or Fast-forward. Drop yours onto another branch to rebase it. Create, switch, rename and delete branches; create, delete and push tags (one by its button or by dragging it onto the push box, or all of them).
  - **Commits by dragging.** Drag a commit out of the graph onto **Revert**, **Copy onto this branch** (cherry-pick), **New branch here**, **Tag here**, **Edit history from here** or **Go back here**. Each one is also a button in the commit's detail.
  - **Edit history** as cards: reorder commits by dragging them, and reword, squash, fold or drop each one (an interactive rebase).
  - **A shelf** (git stash): drag changes onto it to put them aside, and back to Changes to take them back. Switching branch with changes in the way offers to shelve them.
  - **Conflicts**, side by side, with Keep yours, Keep incoming or Keep both for each block (or one side for the whole file). Then Continue or Abort the merge, rebase, cherry-pick or revert.
  - **Discard** changes, by the bin you drop cards on or a button. dx keeps a copy first, so Undo brings them back.
  - **Amend** the last commit, with a warning when it's already pushed.
  - **Write message**, when Claude Code is installed: it writes the commit message from the staged changes, in the style of the repository's recent commits, into the box for you to edit. It only runs when you click, since it sends the staged diff to your Claude account. Nothing is committed for you.
  - **Fetch, Pull and Push**, with what's ahead and behind, separate from committing: push with the button or by dragging your branch onto the remote. Pull only fast-forwards. Force push is only ever `--force-with-lease`, after a confirm.
  - **Undo for everything** done from the page: the Undo button, and an Undo history with git's reflog to go back further.
  - **A livelier graph.** It draws itself in. A branch's path lights up under the mouse, the dots show each author's initials, branch pills take their lane's colour, and the commit you're on pulses.
- **`dx git <project>`** prints the branch, what's staged and changed, and the recent history as a graph in the terminal. `--ui` opens the Git page.
- **Machine page**, `dx machine` and the `machine_info` MCP tool: what this computer has, and what runs on it.
  - **Tools**: Node, npm, pnpm, yarn, bun, deno, git, gh, docker, Python, Go, Java and Rust, with the installed version, the newest one, and whether yours still gets security fixes (from endoflife.date, the npm registry and GitHub releases, kept for 12 hours). **Update** opens the command that fits how the tool was installed (nvm, fnm, volta, mise, asdf, winget, Homebrew, scoop, npm, corepack…) in a terminal you can watch.
  - **Your projects**: what each project asks for (`.nvmrc`, `.node-version`, `.tool-versions`, `engines`, `volta`, `packageManager`, lock files, `.python-version`, `requires-python`, `go.mod`, compose files) next to what's installed, with the command that switches or installs it.
  - **Running in the background**: dev servers, watchers, AI tools and editor helpers, each with the child processes it started, its memory, CPU now, ports and project. Ones whose terminal is gone are marked **left behind**; ports other computers on your network can reach are marked **open to your network**. **Stop** asks first; dx's own servers are stopped from the Projects page.
  - **Docker**: containers, and the space images, stopped containers and the build cache take, with **Clean up** for each. Volumes, which hold data, are never removed.
  - **Services**: Postgres, MySQL, Redis, MongoDB and other services that start with the computer, with the commands to stop them or start them only when needed.

## 1.4.0 (2026-11-04)

Keep secrets out of git with the new Env & secrets page, see your app's APIs, errors and console in their own views, and have it recorded at the address you always open, `localhost:<port>`, in any browser. Update with `npm install -g dx-devkit@latest`.

### Added

- **Env & secrets page**: every project's `.env` files, subfolders included. See one with its values hidden until you ask, edit and save it, or open it in your editor. Warnings for `.env` files git would commit or already has, projects with no `.gitignore`, `.env.example` ignored by mistake, and keys in committed files. What `.gitignore` is missing to keep secrets out of git, following OWASP (`.env`, `.env.*`, private keys, certificates, keystores, SSH keys), with an **Add to .gitignore** button. `dx env --gitignore` does the same from the terminal, and `check_env` tells AI agents.
- **Apps are recorded at `localhost:<port>` too, in any browser.** When dx starts an app whose tool it knows (Vite, Next.js, Astro, Nuxt, Angular, webpack, Gatsby, Create React App), it answers at the usual address itself and runs the dev server on a free port behind it. Requests, clicks, routes, console and errors are in the activity history there as at `.localhost`; live reload passes through. `"localhostRecording": false` turns it off.
- **Activity views**: **Sessions**, **APIs** (each endpoint with its calls, payloads, responses, average and slowest time, failures), **Errors** (grouped, with counts and where in the code) and **Console** (repeats folded), with each project's visits, API calls and problems at the top.
- **Visual and Raw** for every request, error and console line, in the Activity page and the Requests panel. Visual is the default, and the choice is remembered:
  - **Requests**: method, status (coloured by class), address, a timing bar and sizes at a glance, then **Response**, **Request** and **Headers** tabs. JSON bodies are colour-coded trees whose objects and arrays fold, forms are tables, headers are tables.
  - **Errors**: the stack as frames; your own code's frames open your editor at the line, and library frames fold into one line.
  - **Console**: objects in a log line show as trees.

  Raw shows the exact text. Each part has a **Copy** button.

### Changed

- **Releases are published by GitHub Actions** when a version tag is pushed, with npm trusted publishing: the package now carries provenance (the commit and workflow that built it).
- The dev server's own console chatter (`[vite] connected.`, `[HMR]` and the like) isn't recorded; its warnings and errors still are.
- A missing `/favicon.ico` (404) isn't counted as a failed request any more.

### Fixed

- **Clear history** on the Activity page did nothing after you confirmed it.

## 1.3.0 (2026-11-04)

dx now keeps a history of what happens in your apps (requests, clicks, routes, console and errors), can replay a visit to reproduce a bug, and opens projects in the terminal you pick. Your AI agent can also run your tests, read the network log, click through pages and query the development database. Update with `npm install -g dx-devkit@latest`.

### Added

- **`dx test` and the `run_tests` MCP tool**: run a project's tests and get each failure with its name, file and line, the message, and expected against actual, read from the framework's own report (vitest and jest JSON, node:test TAP, pytest JUnit XML, go test JSON). `-m` runs only matching tests; `--changed` only those related to uncommitted changes (vitest, jest). In the dashboard: **Run tests** in a project's menu, with a button that opens your editor at the failing line.
- **A network log** of the requests that go through an app's `.localhost` address: method, path, status, timing and the start of each body, with passwords, tokens and cookies masked. It's the **Requests** panel on a running server in the dashboard, `dx traffic <project>` (`-f` to follow), and the `network_log` MCP tool. Page checks now load the page through its `.localhost` address, so what they trigger is in the log too.
- **Clicking through a page**: `check_url` takes `steps` (go to, click, type into, press a key, wait for an element, text or address, screenshot) and reports each step with the exceptions, console errors and failed requests it caused. Elements are found by CSS selector or by their text (`text=Sign in`).
- **`dx db` and the `db_query` MCP tool**: read-only queries against the development database in docker-compose (Postgres, MySQL/MariaDB, Redis), run inside the container as the user it was set up with, so no credentials are needed. Only reading statements get through, one at a time, and the session itself is read-only.
- **The year in review**: `dx summary --year` (and **This year** on the Summary page, and `year` in the `work_summary` MCP tool). It covers month by month, projects with their first and last commit, the busiest day and month, the longest run of days with commits, pull requests merged, and your journal.

- **The activity history**: everything that happens in an app opened at its `.localhost` address, in order, kept 7 days. It covers:
  - requests with their payloads and responses;
  - pages and front-end route changes;
  - clicks and form submits (never typed values);
  - console output with the line that wrote it, and uncaught errors;
  - the dev server starting, stopping and printing errors.

  Passwords, tokens and cookies are masked. It's on the new **Activity** page (live, grouped by visit, filtered by project, kind and time, searchable), in `dx activity` (`-f` to follow, `--problems`, `-q`, `-b` for payloads), and the `activity_log` MCP tool. The browser side comes from a small script the local domains proxy adds to the app's HTML pages. Turn it off with `"activity": false`, or in Health & settings.
- **Copy as bug report** on any error in the Activity page: markdown with the steps that led there, what went wrong, each request with what was sent and returned, and the stack.
- **Replay a visit**: dx opens the page it started on in a headless browser and clicks what you clicked, in order, then lists what broke. On the Activity page, and for AI agents as the `replay_visit` MCP tool, to reproduce a bug and confirm its fix.
- **The activity history has a size limit**: 500 MB in all (`activityMaxMB`), the oldest days going first; past 100 MB in a project's day, events are kept without bodies, and past 200 MB only errors. Health & settings shows how much it takes.
- **A hint on the Activity page** when a running app has nothing from its browser side, which usually means it's open at `localhost:<port>`: it says which `.localhost` address to open instead.
- **Open a project in a terminal, in the terminal you pick**: a **Terminal** button on every project, and a dropdown at the top of the Projects page (and in Health & settings) listing the terminals installed on the computer: Windows Terminal, PowerShell, Command Prompt, Git Bash, WezTerm and Alacritty on Windows; Terminal, iTerm2, Warp, Ghostty, kitty, WezTerm and Alacritty on macOS; the usual ones on Linux. `dx terminal <project>` opens one; `dx terminal --list` and `--use <id>` pick it. **Run in a terminal window** and `dx go -w` use the same choice.

### Changed

- The **Recent activity** section of Health & settings is now **Recent runs**, since the new Activity page is something else.

### Fixed

- Dashboard API routes treated a missing number in the address as 0: the Cleanup route without `days` looked at projects idle for 0 days instead of 30.
- Browser checks gave up when the browser took more than 20 seconds to start, which a first start on a fresh machine can. It now has 60 seconds, the page's own time starts once the browser is up, and it starts without its sandbox on systems that don't allow one.
- `dx test` showed a failing test's file as a full path instead of one relative to the project when the project's folder is reached through a link (on macOS, anything under the temp folder).

## 1.2.0 (2026-11-04)

Your AI agent now sees what breaks in the browser, a repository goes from URL to running in one command, and dx remembers where you left off. Update with `npm install -g dx-devkit@latest`.

### Added

- **AI agents see errors in the browser too.** `check_url` with `browser: true` loads the page in a headless Chrome, Edge, Chromium or Brave already on the computer and reports:
  - uncaught exceptions, console errors and warnings;
  - failed requests (4xx, 5xx, refused);
  - a Vite or Next.js error overlay;
  - what the server logged during the same page load.

  `screenshot: true` returns a picture of the page. Nothing to install: dx talks to the browser over the DevTools protocol. In the dashboard, **Check page** on a running server does the same.
- **`dx clone <repo>`**: clones into your projects folder and installs packages with the tool the repository uses (npm, pnpm, yarn, bun, pip, uv, go). It creates `.env` from `.env.example`, lists the variables that still need a value, then opens and runs the project. The same is on the dashboard's New project page and in the `clone_project` MCP tool.
- **Where you left off**: dx remembers each project's branch, what was running and the errors open when it stopped.
  - `dx resume` shows it, with commits since, uncommitted files and journal entries.
  - `dx go` shows it when you come back after a while.
  - Notes for next time come from you (`dx resume --note`, the dashboard) or your AI agent (`leave_note`), and `resume_project` reads it all back.
- **`dx status`**: work that exists only on this computer, most at risk first: uncommitted changes, commits no remote has, stashes and repositories with no remote. Worktrees count only their own branch. It's also a panel on the Projects page and the `unsaved_work` MCP tool.
- **`dx env`**: compares `.env` files with `.env.example`, flags `.env` files git tracks or doesn't ignore, and finds keys and tokens in tracked files (AWS, GitHub, OpenAI, Anthropic, Stripe, Slack, Google, npm, SendGrid, private keys), always masked. It's also in the project menu in the dashboard and the `check_env` MCP tool.
- **`dx https`**: https://shop.localhost with a certificate your browsers trust, through mkcert.
  - It's opt-in, since it changes what the system trusts.
  - New projects are added to the certificate the first time they're opened.
  - `dx doctor` checks it.
- **`dx deps --fix`**: updates a project's packages within package.json's ranges and applies non-breaking audit fixes. Major versions are listed instead. It's also the **Update packages** button on the Dependencies page and the `fix_dependencies` MCP tool.
- **yarn and bun projects in `dx deps`**, checked against the npm registry directly: latest versions, and advisories for the installed versions.
- **`dx doctor`** checks for a headless browser and, when you have GitHub repositories, for a GitHub login (private pull requests in the summary).
- **Raycast**: Work Summary and Clean Up Projects commands.
- **Tests for the `dx` command**.

## 1.1.0 (2026-11-03)

Your AI coding agent can now run your app and see what it does, whole stacks start with one command at readable `.localhost` addresses, and nothing needs setting up. Install it with `npm install -g dx-devkit`.

### Added

- **Published on npm as `dx-devkit`**: one global install gives the `dx` command, the dashboard and the MCP server.
- **Stacks**: a project's front end, API, workers and databases start together, in order, with one command or button (`dx up`, `dx go`, Run, or an AI agent's `start_dev_server`).
  - **Found with no configuration** from:
    - Procfiles;
    - turbo, nx, concurrently, npm-run-all or lerna dev scripts, with their output split back into services;
    - `dev:*` scripts;
    - npm, yarn and pnpm workspaces;
    - databases in docker-compose.
  - **Order**: databases first, then back ends, then front ends. A service whose dependency failed isn't started.
  - **Addresses passed along** as `DX_<SERVICE>_URL` and `DX_<SERVICE>_PUBLIC_URL`.
  - **Two repositories**: `set_stack` (MCP) or `"stack"` in `.devrc.json` define a stack dx can't guess.
- **Local domains**: running apps at `http://<project>.localhost`, stack services at `http://<service>.<project>.localhost`, and the dashboard at `http://dx.localhost`.
  - **Nothing to set up**: browsers resolve `*.localhost` by themselves.
  - **Live reload works**: WebSockets pass through, and redirects are rewritten.
  - **Port**: 80, or 1355 when 80 isn't available.
- **Dashboard**:
  - A stack shows as one card, with a row per service (status, address, errors) and their combined output labelled by service, with a filter.
  - Errors show which service they came from.
- **`dx up` and `dx down`** start and stop a stack in the background.
- **`dx doctor`** checks Docker (when a stack needs it) and whether local domains got port 80, with fixes.
- **Project detection**: projects with only a Gemfile, a Procfile or a compose file are found too.
- **AI agents can run your app and see what it does.** Nine new MCP tools:
  - `start_dev_server` waits until the app is ready and reports its URL, errors and output.
  - `wait_for_rebuild` says whether an edit added or fixed errors.
  - `check_url` requests a page and returns what the server logged while answering.
  - `dev_errors` and `dev_logs` read errors and output.
  - `dev_servers`, `stop_dev_server` and `restart_dev_server` list, stop and restart servers.
  - `dx_setup_check` gives each setup problem with its fix.
- **Error detection in dev server output**:
  - TypeScript, Vite, esbuild, webpack and Next.js, Node stack traces and syntax errors, Python tracebacks, Go errors and panics.
  - Each error has its file and line and a repeat count, and is cleared once the server rebuilds cleanly.
- **Dashboard**:
  - Each dev server shows its errors; clicking an error's file opens your editor at that line.
  - A "Started by AI" label marks servers an agent started.
  - The Health page shows which AI tools are connected, with buttons, and how to fix each failed check.
- **No setup**:
  - On first use dx finds your code folders and editor, and connects itself to Claude Code, Claude Desktop, Cursor, Windsurf and VS Code, whichever are installed.
  - AI tools start the dashboard in the background when they need it; it stops itself when idle.
- **New commands**:
  - `dx setup` (`--list`, `--undo`) manages the AI tool connections.
  - `dx logs <project> -f` follows a server's output.
  - `dx errors` lists current errors.
  - `dx ui --background` and `dx ui --stop` start and stop the dashboard without a terminal.
- **Better `dx doctor`**: each problem now comes with how to fix it.

### Changed

- `dx ui` opens the running dashboard instead of starting a second one.
- On a new install, the default projects folder is the code folders dx finds, rather than `~/Desktop/projects`.

## 1.0.0 (2026-11-03)

The first public release, on GitHub only (its git tag is `v0.1.0`).

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
