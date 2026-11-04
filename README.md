# dx toolkit

Your projects, dev servers, ports, work journal and weekly summary in one place: a local dashboard, a `dx` command, and tools your AI assistant can call. Runs on Windows, macOS and Linux.

**Your AI coding agent can run your app and see what it does.** Claude Code, Cursor and the others start the dev server through dx, read its output, see compile errors and stack traces with their file and line, request pages, and check that a fix worked, while you watch the same server in the dashboard. dx connects itself to the AI tools on your computer: there's nothing to configure.

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/images/projects-light.png">
  <img alt="The dx dashboard's Projects page: a running stack called shop, with its api and web services at api.shop.localhost and web.shop.localhost; a todo-app dev server marked Started by AI with 1 error; and the project list below." src="docs/images/projects.png">
</picture>

Each tool is written once in `packages/core` and can be used four ways:

```
packages/core   the tools (projects, ports, journal, …), plain Node, no dependencies
   ├── packages/web      → the dashboard in your browser: `dx ui`
   ├── packages/cli      → `dx` in any terminal, VS Code included
   ├── packages/raycast  → Raycast commands with hotkeys
   └── packages/mcp      → Claude (Desktop / Code) and Raycast AI can call the tools
```

Everything dx stores is in one folder: `~/.dx` (`C:\Users\<you>\.dx`).

| File | What it is |
|---|---|
| `config.json` | Settings: where your projects are, which editor and terminal to open |
| `journal.md` | Your work journal, plain markdown, edit it by hand any time |
| `runs.jsonl` | One line per tool run, so a failure is never silent (`dx runs`) |
| `summaries/` | Saved work summaries, one markdown file per day you ran `dx summary --save` |
| `templates/` | Your project templates for `dx new`, one folder each |
| `activity/` | The activity history: one folder per project, one file per day, kept 7 days |
| `dashboard.json` | While the dashboard runs: its address and access token, readable by you only, so the `dx` command and AI tools can reach it |

---

## Setup

dx runs on **Windows, macOS and Linux**. You need **Node 22 or newer** (`node -v`) and git. Then, in a terminal (PowerShell on Windows):

```bash
npm install -g dx-devkit
```

```bash
dx ui
```

That's all. The first time you use dx it sets itself up:
- **Your projects**: it looks in the usual code folders (`~/projects`, `~/code`, `~/dev`, `~/src`, `~/repos`, `~/Documents/GitHub`, `~/Desktop/projects` and similar) and uses the ones you have.
- **Your editor**: the first of VS Code, Cursor, Windsurf, Zed, Sublime Text or JetBrains it finds.
- **Your AI tools**: it adds itself to Claude Code, Claude Desktop, Cursor, Windsurf and VS Code, whichever are installed, and says so. A tool you install later is connected the next time the dashboard starts. `dx setup --undo` takes it all back.

Projects somewhere else? `dx config add-root <folder>`, or add the folder on the dashboard's Health page. `dx doctor` checks everything and says how to fix what isn't right; your AI tool can run the fixes for you (ask it to "check dx's setup").

- **macOS and Linux**: if `npm install -g` fails with a permissions error, your global npm folder belongs to root. Use a Node version manager (nvm, fnm, Volta) rather than `sudo`.
- **Linux**: `dx port` and `dx kill` need `lsof` (`sudo apt install lsof` or your distro's equivalent). Copying a summary needs `wl-copy` or `xclip`, and "open in a terminal window" uses `x-terminal-emulator`.
- **macOS**: "open in a terminal window" uses Terminal.app; the first time, macOS asks whether your terminal may control it.

> If you switch Node versions with nvm, install dx again on the new version; dx repoints your AI tools at it the next time the dashboard starts.

**Updating**: `npm install -g dx-devkit@latest`. **Removing**: `dx setup --undo` (takes dx out of your AI tools), then `npm uninstall -g dx-devkit`; your settings and journal stay in `~/.dx`.

**From source**, to change dx itself: clone this repository, then run `npm install`, `npm run build` and `npm run link` in it. [CONTRIBUTING.md](CONTRIBUTING.md) has the rest.

---

## The dashboard: `dx ui`

```powershell
dx ui
```

It opens the dx dashboard in your browser, where everything `dx` does is a button:

| Page | What you can do there |
|---|---|
| **Projects** | Search your projects; **Run** a dev server right in the page and watch its output live, open it in the browser when it's ready, **Stop** it; see its **errors** with file and line, and open your editor at that line; **Check page** loads it in a headless browser and lists exceptions, console errors and failed requests; **Requests** shows what the app sent through its `.localhost` address and what came back; see servers your AI agent started; **work that isn't backed up** across all projects; **leave a note** on a project for next time; **check its .env** and look for committed keys; **run its tests** and see each failure with file, line, expected and actual; open a project in your editor, in **a terminal** (pick which one at the top of the page: Windows Terminal, PowerShell, Git Bash, iTerm2, Warp, Ghostty and others, whichever you have) or in File Explorer; run its dev server in a terminal window; save one as a template |
| **New project** | Create a project from a template or a copy of another, with git and packages installed; or **clone a repository** and get it ready to run |
| **Activity** | Everything that happened in your apps, newest first, live: requests with their payloads and responses, pages and route changes, clicks, console output, browser errors, and the dev server starting, stopping and failing. Filter by project, kind or time, search payloads and messages, open an error at its line in your editor. See [The activity history](#the-activity-history) |
| **Ports** | See what's listening and stop it (it asks first, naming the process) |
| **Journal** | Add what you did, read back 7, 30 or 90 days |
| **Summary** | Your week: commits, pull requests, journal, where the time went, uncommitted work; copy it as markdown or save it. **This year** gives the year in review |
| **Cleanup** | See which `node_modules` and build folders can go, pick them, delete them (it asks first) |
| **Dependencies** | Run the audit across all projects (npm, pnpm, yarn and bun) with a progress bar; open a row for its outdated packages, and **Update packages** within their ranges |
| **Health & settings** | `dx doctor`'s checks with how to fix each problem, which AI tools are connected (with Connect and Disconnect buttons), your projects folders, editor, terminal and GitHub username, whether to keep the activity history and for how long, and what dx ran recently |

| Summary | Cleanup |
|---|---|
| ![The Summary page: 11 commits in 3 projects, 4 journal entries, and the week's journal and commits.](docs/images/summary.png) | ![The Cleanup page: 168 MB of node_modules and build folders in three idle projects, selected for deletion.](docs/images/cleanup.png) |

- **It runs on your computer only**, at `http://dx.localhost` (or `http://127.0.0.1:4646`). Every action needs a secret the page gets when it loads, so other websites can't use it.
- **It's started for you when needed.** When an AI tool asks dx to run a dev server, dx starts the dashboard in the background; `dx ui` then just opens it. A background dashboard stops itself after 30 minutes with no dev servers running and nobody using it. `dx ui --stop` stops it now.
- **Dev servers you start from the dashboard stop when the dashboard stops**, like a dev server stops when you close its terminal. For one that keeps running, use **More → Run in a terminal window**.
- Light and dark follow your system, or pick one at the bottom of the sidebar. It works on a phone-sized window too.
- `dx ui --port 5000` uses another port; `dx ui --no-open` doesn't open the browser. From the project folder, `npm run ui` does the same as `dx ui`.

---

## The activity history

Every app you open at its `.localhost` address (the address `dx up`, `dx go` and the dashboard give you) leaves a history of what happened, in order:

- **Requests** with their method, address, status, time, and what was sent and returned;
- **Pages** loaded, and **route changes** without a page load (`/cart → /checkout`);
- **Clicks** on buttons and links, and **forms** submitted. What you type is never recorded;
- **Console output** (`console.log`, `warn`, `error`) with the file and line that wrote it, and **uncaught errors** with their stack;
- the **dev server** starting, getting ready, stopping and crashing, and each **error it printed**.

See it on the **Activity** page, with `dx activity`, or ask your AI agent (`activity_log`). Nothing to set up:

- **How it's recorded.** Requests go through the local domains proxy, which logs them. For the browser side, the proxy adds one `<script>` tag to your app's HTML pages, served from your app's own address. Browser dev tools leave it out of stack traces, so `console.log` still shows your file and line. Requests the page makes to `localhost:<port>` or other addresses are recorded by that script.
- **Only what you open at `.localhost`.** `localhost:5173` is the dev server directly, and nothing passes through dx there.
- **Private.** Passwords, tokens, cookies and API keys are masked before anything is written. It's kept in `~/.dx/activity`, readable by you only, for 7 days (`activityDays` in the settings). Only the page itself can add to its history; no other website can. `dx activity --clear` or **Clear history** deletes it.
- **Off**: untick it in Health & settings, or set `"activity": false`. Pages are then served exactly as your dev server sends them.

---

## Stacks and local domains

**A stack is everything an app needs running**: its front end, API, worker and database. dx finds it by itself, starts every part in order, and serves each one at a readable address:

```bash
dx up shop
```
```
  postgres  ready    http://localhost:5432
  api       ready    http://api.shop.localhost
  web       ready    http://web.shop.localhost
✓ shop is up at http://shop.localhost
```

**How dx finds a stack**, with nothing to configure:

| The project has | dx runs |
|---|---|
| `Procfile.dev` or `Procfile` | one service per line, with `PORT` set like foreman does |
| a root `dev` script that runs turbo, nx, concurrently, npm-run-all or lerna | that one command, as the project intends; its output is split back into services by the prefixes those tools print |
| root scripts `dev:web`, `dev:api`, … | each one as a service |
| npm, yarn or pnpm workspaces whose packages have a `dev` script | each package, in its own folder |
| databases in `docker-compose.yml` (postgres, mysql, mongo, redis, …) | `docker compose up -d` for them, first; services built from your own code are left to run natively |
| a `stack` in `.devrc.json` | exactly that: see below |

- **Start order**: databases first, then back ends (`api`, `server`, `worker`, …), then front ends, each group only once the one before is ready. A service whose dependency failed isn't started, and the dashboard says so.
- **Addresses passed along**: each service gets the others' addresses as environment variables: `DX_API_URL` (direct, for server code) and `DX_API_PUBLIC_URL` (the `.localhost` one, for the browser).
- **One place to watch**: in the dashboard a stack is one card, with a row per service (status, address, errors) and their output combined, labelled by service, with a filter. In the terminal, `dx go shop` follows it the same way, and Ctrl+C stops it all.
- **Two repositories**, such as `shop-web` and `shop-api`, can't be guessed safely. Ask your AI tool to "run shop-web together with shop-api": it uses the `set_stack` tool to write the stack for you. Or write it yourself (below).

**Local domains**: every running app is also at `http://<project>.localhost`, and each stack service at `http://<service>.<project>.localhost`, so you don't need to remember port numbers, and ports clashing stops mattering.
- **No setup**: browsers send every `*.localhost` name to your own computer. There's no hosts file to edit.
- **Live reload keeps working**: WebSocket connections pass through. Redirects to `localhost:<port>` are rewritten to the `.localhost` address.
- **Port 80, or a fallback**: dx serves these on port 80 when it can. When something else has port 80 (or on Linux, where it needs one system setting), it uses port 1355, and the addresses become `shop.localhost:1355`. `dx doctor` says which one and how to get 80; your AI tool can apply that fix for you.
- **Safety**: it listens on your computer only, and forwards only to dev servers dx is running. Any other name gets a "not a dx address" page.
- **Off**: set `"localDomains": false` in `~/.dx/config.json` to turn it off.

**HTTPS**, for what browsers allow only on `https://` (secure cookies, service workers, OAuth callbacks): run `dx https` once. It uses [mkcert](https://github.com/FiloSottile/mkcert) to add a local certificate authority to your system (your system asks you to allow it, once) and makes a certificate for your projects' `.localhost` names. After the dashboard restarts, apps are at `https://shop.localhost` too, and dx hands out the https addresses. A project you add later is added to the certificate the first time you open it. `dx https --off` turns it off. It's opt-in because it changes what your system trusts; `dx doctor` gives the mkcert install command (`winget install FiloSottile.mkcert`, `brew install mkcert nss`, or your distro's package).

---

## The `dx` command

| Command | What it does |
|---|---|
| `dx ui` | The dashboard: everything below, with buttons, in your browser |
| `dx ui --background` / `dx ui --stop` | Start it without a terminal / stop it and the dev servers it runs |
| `dx up shop` / `dx down shop` | Start a project's whole stack in the background, and print its addresses / stop it |
| `dx logs todo-app -f` | Follow the output of a dev server running in the dashboard, one your AI agent started included |
| `dx errors` | Errors in every running dev server, with file and line (`dx errors todo-app` for one) |
| `dx traffic todo-app -f` | The requests the app made through its `.localhost` address, live; `--bodies` for what was sent and returned (passwords, tokens and cookies masked), `--failed` for 4xx/5xx only |
| `dx activity` | What happened in your apps today, in order: requests and responses, routes, clicks, console, errors. `dx activity todo-app -f` follows it live, `--problems` shows only what went wrong, `-q checkout` searches, `-b` adds payloads and stacks, `--since 2h` goes back further |
| `dx terminal todo-app` | Open the project in a new terminal window. `dx terminal --list` shows the terminals on this computer, `dx terminal --use git-bash` picks the one projects open in (the dashboard uses it too) |
| `dx setup` | Connect dx to your AI tools (it does this by itself; `--list` shows them, `--undo` removes dx from them) |
| `dx go todo-app` | Open the project in your editor, start its dev server here (its whole stack, if it has one), open the browser when it's ready |
| `dx go todo-app -w` | Same, but the dev server runs in a new terminal window |
| `dx go` | Pick from your most recently active projects |
| `dx go .` | The project in the current folder |
| `dx new vite-app shop` | New project `shop` from a template or a copy of a project, then open it |
| `dx clone octocat/todo-app` | Clone a repository into your projects folder, install its packages with the tool it uses (npm, pnpm, yarn, bun, pip, uv, go), create `.env` from `.env.example`, then open and run it. It lists the variables that still need a value |
| `dx resume todo-app` | Where you left off: when, which branch, what was running, your last note, commits since, uncommitted files. `dx go` shows it too when you come back after a while |
| `dx resume todo-app --note "next: due dates"` | Leave a note for next time (`--clear` removes it); your AI agent can leave one too |
| `dx status` | Work that exists only on this computer: uncommitted changes, commits no remote has, stashes, repos with no remote; most at risk first |
| `dx test todo-app` | Run its tests (vitest, jest, node:test, pytest, go test) and list each failure with its file, line, expected and actual; `-m cart` runs only the matching ones, `--changed` only those related to uncommitted changes |
| `dx db shop "select * from orders"` | A read-only query against the project's development database in docker-compose (Postgres, MySQL/MariaDB, Redis); `dx db shop` lists the tables. No password needed: it runs inside the container |
| `dx env todo-app` / `dx env --all` | Variables `.env.example` lists that your `.env` doesn't set, `.env` files git would commit, and API keys or tokens in tracked files |
| `dx projects` / `dx ls todo` | List projects (most recent first) / search them |
| `dx port` | Every listening port 1024+, with the process and its command line |
| `dx port 3000` | What's on port 3000 |
| `dx kill 3000` | Kill it (asks first; `-y` skips the question) |
| `dx log "fixed seat map overflow"` | Add a line to your work journal |
| `dx log` / `dx log --days 30` | Read the journal back |
| `dx summary` | Your commits across all projects plus your journal for the last 7 days, as markdown |
| `dx summary --copy` / `--save` | Copy it to the clipboard / save it to `~/.dx/summaries/` |
| `dx summary --year` | The year in review: month by month, projects, busiest day, longest run of days with commits, pull requests merged, your journal (`--year 2025` for another year) |
| `dx clean` | Delete `node_modules` and build folders in projects idle for 30+ days (asks first) |
| `dx deps` | Outdated packages and known vulnerabilities in every Node project (npm, pnpm, yarn, bun) |
| `dx deps --fix todo-app` | Update its packages within `package.json`'s ranges and apply the audit fixes that need no breaking change (asks first); major versions are listed for you |
| `dx https` | Serve `https://shop.localhost` with a certificate your browsers trust (`--status`, `--off`) |
| `dx runs` / `dx runs --failed` | Recent tool runs |
| `dx config` | Show settings; `dx config edit`, `dx config add-root <folder>`, `dx config editor <cmd>`, `dx config github <user>` |
| `dx doctor` | Check the setup |

`dx help <command>` shows every option.

**`dx go` details:**
- It reads the dev command from `package.json` (`dev`, then `start`, `serve`) and uses the right package manager (npm, pnpm, yarn, bun).
- If the port is already taken by this project's own server, it just opens the browser.
- If the port is taken by something else, it offers to kill it.
- Ctrl+C stops the server as usual.

**`dx summary` details:**
- It reads `git log` in every project that's a git repo (all branches, merges left out) and your journal, for the last 7 days with today included. `--days 1` is just today, for a standup.
- Only your commits count: the ones made under the `user.name` or `user.email` git has for that repo. `--all-authors` counts everyone's.
- Commits are listed per project, oldest first, with each message once even if you committed it several times.
- A repo git can't read is skipped with a warning instead of failing the whole summary.
- **Pull requests**: the ones you merged and the ones you reviewed on GitHub. Your username comes from `dx config github <user>`, or is guessed from your repos' GitHub remotes. Without a token only public repos are searched; for private ones set `GITHUB_TOKEN` (a fine-grained token with read access to pull requests), or install the GitHub CLI and run `gh auth login`. `--no-github` skips this.
- **Where the time went**: per project, the days you committed or opened it with `dx go`, and how long its dev server ran when `dx go` ran it in the same terminal.
- **Not committed yet**: projects active in the period with changes you haven't committed. It's a reminder for you; delete the section before sending if you like.

**Every Thursday, automatically:** these save the summary at 4 pm each Thursday. Run them once, after installing dx; they find where npm put it. The file lands in `~/.dx/summaries/<date>.md`, and `dx runs` shows whether it ran.

<details>
<summary><b>Windows</b>: Task Scheduler. If the computer is off or asleep at 4 pm, it runs as soon as it's back on.</summary>

```powershell
$script   = Join-Path (npm root -g) "dx-devkit\dist\index.js"
$action   = New-ScheduledTaskAction -Execute (Get-Command node).Source -Argument "`"$script`" summary --save"
$trigger  = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Thursday -At 4pm
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable
Register-ScheduledTask -TaskName "dx weekly summary" -Action $action -Trigger $trigger -Settings $settings
```

To remove it: `Unregister-ScheduledTask -TaskName "dx weekly summary"`.
</details>

<details>
<summary><b>macOS</b>: a launchd agent. If the Mac is asleep at 4 pm, it runs when it wakes; if it's shut down, that week is skipped.</summary>

```bash
cat > ~/Library/LaunchAgents/dev.dx.weekly-summary.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.dx.weekly-summary</string>
  <key>ProgramArguments</key><array>
    <string>$(command -v node)</string>
    <string>$(npm root -g)/dx-devkit/dist/index.js</string>
    <string>summary</string><string>--save</string>
  </array>
  <key>StartCalendarInterval</key><dict>
    <key>Weekday</key><integer>4</integer>
    <key>Hour</key><integer>16</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
</dict></plist>
EOF
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.dx.weekly-summary.plist
```

To remove it: `launchctl bootout gui/$(id -u)/dev.dx.weekly-summary`, then delete the `.plist` file.
</details>

<details>
<summary><b>Linux</b>: a systemd user timer. If the computer is off at 4 pm, it runs as soon as it's back on.</summary>

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/dx-summary.service <<EOF
[Service]
Type=oneshot
ExecStart="$(command -v node)" "$(npm root -g)/dx-devkit/dist/index.js" summary --save
EOF
cat > ~/.config/systemd/user/dx-summary.timer <<EOF
[Timer]
OnCalendar=Thu 16:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now dx-summary.timer
```

`systemctl --user list-timers` shows when it runs next. To remove it: `systemctl --user disable --now dx-summary.timer`, then delete the two files. Without systemd, a crontab line does the same, but skips a week the computer was off: `0 16 * * 4 "$(command -v node)" "$(npm root -g)/dx-devkit/dist/index.js" summary --save` (write the two paths out in full; cron doesn't run `$(…)` for you).
</details>

**`dx clean` details:**
- It only looks at projects you haven't touched for 30 days (`--days` changes that), and only at folders an install or a build recreates: `node_modules`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `dist`, `build`, `out`, `coverage`, `target` and similar, up to three levels down for monorepos.
- In a git repo a folder only counts if git ignores it, so a committed `build/` folder is never touched. Outside git, `dist`, `build` and the like are left alone, since they may be the only copy.
- It lists everything with sizes and asks before deleting. `--list` only shows, `-y` skips the question. Run `npm install` to get a project's `node_modules` back.

**`dx deps` details:**
- It runs `npm outdated` and `npm audit` in every Node project, four at a time, so it needs the internet and takes a few seconds per project. `dx deps todo-app` checks one, `--active 30` only the projects active in the last 30 days.
- The table shows how many packages are outdated, how many of those are a major version behind (an update that may need code changes), and the vulnerabilities by severity. `--details` lists each package.
- pnpm projects are checked with pnpm when it's installed; yarn and bun projects are skipped for now. Nothing is changed: fix with `npm update` or `npm audit fix` in the project.

**`dx new` details:**
- `dx new <source> <name>`: the source is a template in `~/.dx/templates`, or an existing project. A git project is copied as the files git tracks plus new files it doesn't ignore, so local reports, uploads and caches stay behind; `.git`, `node_modules`, build output and `.env` files are always left out (`.env.example` is kept). The new project goes in your first projects folder (`--in <folder>` to choose), gets a git repository and its packages installed, then opens like `dx go`.
- Make a template from a project with `dx new --save todo-app vite-app`. In template files, `{{name}}` is replaced with the new project's name, in file names too; `package.json` always gets the new name.
- `--no-install`, `--no-git`, `--no-open` and `--no-dev` skip those steps. `dx new` alone lists your templates.

### Per-project settings: `.devrc.json`

Optional, in a project's folder, when the detected values aren't right:

```json
{
  "name": "shop",
  "dev": "npm run dev -- --turbo",
  "url": "http://localhost:3000",
  "editor": "cursor"
}
```

A folder containing only a `.devrc.json` also counts as a project.

**A stack of your own**, for when dx can't find it by itself (two repositories, say). Each service has a command (`dev`), another project's folder (`project`, whose own dev command is used), or a docker compose service (`docker`):

```json
{
  "stack": {
    "web": { "dev": "npm run dev", "dependsOn": ["api"] },
    "api": { "project": "../shop-api", "dependsOn": ["db"] },
    "db": { "docker": "postgres" }
  }
}
```

`dir` runs a command in another folder, `url` says where a service listens if it doesn't print it, and `role` (`data`, `backend`, `frontend`) sets the order when there's no `dependsOn`.

### Settings: `~/.dx/config.json`

Created on first run, with the code folders and editor dx found:

```json
{
  "projectsRoots": ["~/code", "~/Documents/GitHub"],
  "editor": "cursor",
  "scanDepth": 2,
  "ignore": ["node_modules", "dist", "build", "out", "vendor", "target", "bin", "obj"],
  "devServerTimeout": 90,
  "aiToolsSeen": ["claude-code", "cursor"]
}
```

- **`terminal`**: the terminal projects open in, by id (`dx terminal --list`). Without it: Windows Terminal, else Command Prompt, on Windows; Terminal on macOS; the system default on Linux.
- **`activity`** / **`activityDays`**: `false` turns the activity history off (pages are then left exactly as the dev server sends them); a number keeps that many days instead of 7.
- **`localDomains`** / **`localDomainsPort`**: `false` turns `*.localhost` addresses off; a number picks their port instead of 80 (or 1355).
- **`aiToolsSeen`**: the AI tools dx has connected itself to once. A tool you disconnect stays disconnected. Set `"autoConnectAi": false` to stop dx connecting itself to new ones (`dx setup --undo` does both).

A folder counts as a project when it has a `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `requirements.txt`, a `.sln`/`.csproj`, a `.git` folder or a `.devrc.json`.

- **`scanDepth: 2`** also finds projects one folder down, e.g. `projects/archive/old-thing`. To skip a folder like that, add `"archive"` to `ignore`.
- **Folders starting with `.`** are always skipped.

---

## Raycast

Works from a source checkout (see Setup). Needs [Raycast for Windows](https://www.raycast.com) installed and running, and `npm run build` done first.

```powershell
npm run raycast:install
npm run raycast:dev
```

Six commands appear in Raycast:
- **Open Project**: open in the editor, start the dev server, open in the browser, terminal here, show in File Explorer.
- **Kill Port**
- **Log Work**
- **Work Journal**
- **Work Summary**: your week, with copy and save actions and a range to pick.
- **Clean Up Projects**: build folders in idle projects with their size; delete one or all (it asks first).

To give them hotkeys, go to Raycast Settings → Extensions → DX Toolkit and assign one per command (for example Alt+P for Open Project, Alt+K for Kill Port).

If the `dx` command is installed, "Start Dev Server" runs `dx go .` in the new terminal window, so you also get the port check and the browser opening.

---

## Claude and other AI tools (MCP)

dx connects itself to **Claude Code, Claude Desktop, Cursor, Windsurf and VS Code** (Copilot's agent mode), whichever you have: see [Setup](#setup). Restart Claude Desktop once afterwards; the others pick it up in new chats.

### Let your AI run your app

Ask your agent to work on a project and check its own work, for example *"Start todo-app, then fix whatever error the checkout page shows."* It can:

| Tool | What the agent gets |
|---|---|
| `start_dev_server` | Starts the project's dev server, waits until it's ready or has failed, and returns the URL, any errors and the output |
| `wait_for_rebuild` | After it edits files: waits for the server to rebuild, then says whether the change added or fixed errors |
| `check_url` | Requests a page or API route (localhost only) and returns the status, title and start of the body, plus anything the server logged and any error it hit while answering. With `browser: true` it loads the page in a headless Chrome, Edge, Chromium or Brave already on your computer and adds what went wrong **in the browser**: uncaught exceptions, console errors, failed requests and a Vite or Next.js error overlay. A page can answer 200 and still be blank; this catches it. `screenshot: true` returns a picture of the page. **`steps`** clicks through a flow after the page loads (type into a field, click *Sign in*, wait for `/dashboard`), and reports each step with the errors and failed requests it caused |
| `dev_errors` | Current errors across running servers: TypeScript, Vite, esbuild, webpack and Next.js, Node stack traces, Python tracebacks, Go panics, with file and line. An error disappears once the server rebuilds cleanly |
| `dev_logs` | The server's output, only what's new since it last looked |
| `dev_servers`, `stop_dev_server`, `restart_dev_server` | What's running, and stopping or restarting it |
| `set_stack` | Defines a stack dx can't find by itself, such as two repositories, by writing it to `.devrc.json` |
| `clone_project` | Clones a repository and gets it ready: packages installed with the tool it uses, `.env` made from `.env.example`, and the variables that still need a value |
| `check_env` | What a project's `.env` is missing compared with `.env.example`, `.env` files git would commit, and keys or tokens in tracked files |
| `run_tests` | Runs the project's tests and returns each failure with its name, file and line, and expected against actual; `match` reruns just the ones being fixed |
| `network_log` | The requests the app made through its `.localhost` address, with status, timing and bodies (credentials masked): what the front end sent the API, and what came back |
| `activity_log` | What happened in the app, in order: what the user clicked, the routes they went through, each request with its payload and response, console output and errors in the browser and on the server. Ask *"I clicked checkout and nothing happened, why?"* and the agent reads the steps that led there |
| `db_query` | A read-only query against the project's development database (Postgres, MySQL/MariaDB, Redis in docker-compose), to check what an action actually stored |
| `resume_project`, `leave_note` | Where things were left in a project (branch, what ran, open errors, commits since, the last note), and a note for next time. Ask *"carry on with todo-app"* and the agent starts from there |
| `dx_setup_check` | dx's health checks, each problem with the command that fixes it, so the agent can fix your setup for you |

These work on stacks too: `start_dev_server` starts every service in order and reports each with its address, errors are labelled with their service, and `check_url` accepts `.localhost` addresses such as `http://api.shop.localhost/health`.

The servers run in the dx dashboard, not inside the AI tool, so they keep running after the chat ends, and you can watch them, with a **Started by AI** label and their errors, in the Projects page or with `dx logs <project> -f`.

### Your projects, ports, journal and week

- `list_projects`, `open_project`
- `list_ports`, `kill_port`
- `add_log_entry`, `read_log`
- `work_summary`: your commits, pull requests and journal for the last few days
- `find_cleanup`: which folders `dx clean` would delete and how much space that frees (it never deletes)
- `audit_dependencies`: outdated packages and vulnerabilities per project; `fix_dependencies` updates one project within its ranges
- `unsaved_work`: uncommitted changes, unpushed commits, stashes and repos with no remote, across all projects

Then you can say things like "free port 3000 and start todo-app" or "write my standup from what I did this week".

### Connecting by hand

Only needed for a tool dx doesn't know, such as Raycast AI. The server is the `dx-mcp` command. For apps that don't see your PATH, run it with Node instead: `node <global folder>/dx-devkit/node_modules/@dx/mcp/dist/index.js`, where `npm root -g` prints the global folder. In JSON on Windows, double the backslashes. From a source checkout, it's `packages/mcp/dist/index.js`.

For reference, this is what `dx setup` writes for Claude Desktop in `claude_desktop_config.json` (`%APPDATA%\Claude\` on Windows, `~/Library/Application Support/Claude/` on macOS):

```json
{
  "mcpServers": {
    "dx": {
      "command": "/usr/local/bin/node",
      "args": ["/usr/local/lib/node_modules/dx-devkit/node_modules/@dx/mcp/dist/index.js"]
    }
  }
}
```

And for Claude Code:

```bash
claude mcp add -s user dx -- node "$(npm root -g)/dx-devkit/node_modules/@dx/mcp/dist/index.js"
```

**Raycast AI**: add an MCP server in Raycast with the same command (`node`) and path.

---

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

On GitHub, [.github/workflows/ci.yml](.github/workflows/ci.yml) runs them on every push to `main` and every pull request, on Windows, macOS and Linux with Node 22 and 24, and tries the `dx` command itself.

## Working on dx with Claude Code

[CLAUDE.md](CLAUDE.md) tells Claude Code how this repo is built, its conventions and the dashboard's security rules. [docs/MEMORY.md](docs/MEMORY.md) keeps the decisions made so far and why, the gotchas, and the backlog. CLAUDE.md imports it, so both load in every session here. Update MEMORY.md when a decision is made.

## Next on the list

- **Raycast**: try the extension in Raycast itself (it type-checks, but hasn't been run there yet).
- **Coverage in `dx test`**: which lines the failing area's tests don't reach.
- **Comparing screenshots** before and after a change, so an agent sees what it changed visually.

The full backlog is in [docs/MEMORY.md](docs/MEMORY.md).

## Troubleshooting

- **"Access is denied" when killing a process**: it belongs to another user or needs admin rights. Run the terminal as administrator.
- **`dx` not found after `npm run link`**: open a new terminal. If it still isn't found, check that the folder `npm prefix -g` prints is on your PATH.
- **Editor doesn't open**: run `dx doctor`, then set the editor with `dx config editor "C:\Path\To\Editor.exe"`.
- **Debug output**: set `DX_DEBUG=1` to print full error stacks.

## Releasing

For maintainers:
1. Move the CHANGELOG's *Unreleased* notes under a new version, and bump `version` in every `package.json`.
2. Build and check the package:

   ```bash
   npm run release
   ```

   This puts it in `release/` and packs it.

3. Install that package into a temporary folder and try it:

   ```bash
   node scripts/smoke-package.mjs
   ```

4. Publish, after `npm login`:

   ```bash
   npm publish ./release
   ```

5. Once npm has processed it (a minute or two), install it from npm and check it the same way:

   ```bash
   node scripts/smoke-package.mjs --from-npm
   ```

6. Tag `vX.Y.Z` and draft a GitHub release from the CHANGELOG.

CI runs steps 2 and 3 on every push.

## Contributing

Bug reports, ideas and pull requests are welcome: [CONTRIBUTING.md](CONTRIBUTING.md) has the setup and the conventions, and [CHANGELOG.md](CHANGELOG.md) what changed in each version. Please follow the [code of conduct](CODE_OF_CONDUCT.md), and report security problems privately as [SECURITY.md](SECURITY.md) explains.

## License

[MIT](LICENSE)
