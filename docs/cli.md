# The `dx` command and its settings

Every command, the per-project `.devrc.json` and `~/.dx/config.json`. Back to the [README](../README.md).

## The `dx` command

| Command | What it does |
|---|---|
| `dx ui` | dx: the dashboard, everything below with buttons, in its own window ([the dx app](features.md#the-dx-app)) |
| `dx ui --background` / `dx ui --stop` | Start it without a terminal / stop it and the dev servers it runs |
| `dx ui --startup` / `--no-startup` | Open dx on the taskbar (or Dock) when you sign in, or stop |
| `dx ui --browser` | Open the dashboard in your browser instead, this once. `--remove-app` removes the app, `--app` brings it back |
| `dx floppy` | Put Floppy on your desktop (Windows, macOS, Linux): it shows what dx is doing, and a click opens the dashboard. `--stop`, `--no-startup`, `--colour` |
| `dx up shop` / `dx down shop` | Start a project's whole stack in the background, and print its addresses / stop it |
| `dx logs todo-app -f` | Follow the output of a dev server running in the dashboard, one your AI agent started included |
| `dx errors` | Errors in every running dev server, with file and line (`dx errors todo-app` for one) |
| `dx fix` | Asks Claude Code for a fix to the newest error of a project's dev server and prints the patch; nothing is applied (`dx fix todo-app`) |
| `dx traffic todo-app -f` | The requests the app made through its `.localhost` address, live; `--bodies` for what was sent and returned (passwords, tokens and cookies masked), `--failed` for 4xx/5xx only |
| `dx activity` | What happened in your apps today, in order: requests and responses, routes, clicks, console, errors. `dx activity todo-app -f` follows it live, `--problems` shows only what went wrong, `-q checkout` searches, `-b` adds payloads and stacks, `--since 2h` goes back further, `--site <host>` and `--env staging` for a deployed site |
| `dx browser [url]` | Open the dx browser, which records the sites you chose (staging, production) like your local apps; `--close` closes it. See [Record deployed sites](features.md#record-deployed-sites) |
| `dx sites` | The sites the dx browser records: `dx sites add staging.shop-website.dev --project shop-website --env staging`, `dx sites remove <host>` |
| `dx git todo-app` | The project's branch, what's staged and changed, and its last 20 commits as a graph (`-n 50` for more). `dx git todo-app --ui` opens the dashboard's Code page, where you stage by dragging and commit |
| `dx visual shop-website` | Which recent commits changed how the app looks, and by how much (`--pages` for each page and where it changed; `--capture` captures now through the dev server dx runs). See [Visual diff](features.md#visual-diff) |
| `dx bug export todo-app <event-id>` | Save an error's [bug bundle](features.md#replayable-bug-reports): its steps, requests and commit, without hosts, secrets or your folders. `dx bug replay <file> [project]` runs that commit as a snapshot and replays the steps (`--working` for your working copy) |
| `dx mock make todo-app` | Make [mocks](features.md#mock-mode) from the API calls recorded in the last hour (`--since 3h`). `dx mock on todo-app` answers them from dx (`--strict`: calls with no mock get a 404), `dx mock off`, `dx mock list`, `dx mock clear`. `dx mock spec todo-app` makes them from its OpenAPI spec, `dx mock server todo-app on` serves them at an address of their own, `dx mock cache todo-app on` keeps real answers, `dx mock purge todo-app cache` deletes those |
| `dx tools todo-app` | The project's [own tools](features.md#your-own-tools); `dx tools export todo-app` saves them in one file, `dx tools import <file> todo-app` adds a file's tools (`--replace` swaps one with the same name) |
| `dx data todo-app` | [Realistic data](features.md#realistic-data) for the development database: `dx data make todo-app --recipe big-customer`, `dx data load todo-app <scene> --yes`, `dx data save todo-app "Demo"` |
| `dx attack todo-app` | [A friendly security pass](features.md#attack-my-app) on your own app (`--cookie` to test signed-in calls, `--read-only`) |
| `dx phone todo-app` | [Open it on your phone](features.md#your-real-phone-as-a-test-device): a one-time link and its QR code in the terminal (`--stop` ends it) |
| `dx tour todo-app` | [A map of the project](features.md#tour-a-map-of-a-project) as Markdown: how to run it, its pages and calls, the files behind them, its data and settings (`--json`) |
| `dx proof` | [How this branch was tested](features.md#proof-for-the-pull-request), for its pull request; `--pr` puts it into the branch's open pull request |
| `dx try todo-app react@19` | [Try an upgrade](features.md#try-an-upgrade) in a throwaway copy: type check, build, tests and pages, before and after |
| `dx queries todo-app on` | [Queries per request](features.md#queries-per-request) from the compose database's own log: `dx queries todo-app` lists N+1, slow and busy requests, `off` puts it back |
| `dx chaos on todo-app` | Break the app's API calls on purpose (`--level wifi\|deploy\|blackfriday`, `--seed 4812`, `--only /api/**`); `dx chaos todo-app` says what broke, `dx chaos off`. Also `dx chaos gremlins`, `env`, `diff`, `graveyard`, `clock`, `phone` and `languages`. See [Chaos](features.md#chaos-break-the-app-before-your-users-do) |
| `dx run todo-app abc1234` | Run the project as it was at a commit (a hash, or words from its message, author or files), next to your own dev server, without touching your working copy. `dx run --list` shows the snapshots, `dx run --remove <id>` deletes one. See [Run any commit](features.md#run-any-commit) |
| `dx terminal todo-app` | Open the project in a new terminal window. `dx terminal --list` shows the terminals on this computer, `dx terminal --use git-bash` picks the one projects open in (the dashboard uses it too) |
| `dx machine` | Tools to update or no longer supported, projects that don't match this computer, and processes left behind. `dx machine tools`, `projects`, `processes` or `docker` for one part in full; `dx machine --stop <pid>` stops a process from the list (it asks first); `--offline` skips looking up the newest versions; `dx machine export [file]` writes what this computer has for development (tools and versions, global npm packages, git's name, email and settings, editor extensions, the names of your SSH keys: no key, token, password or path) and `dx machine restore <file>` shows what another computer still needs to match it, as commands to run yourself (`--script <out>` writes them as a script; dx never installs anything itself) |
| `dx update` | Update dx to the newest version, cleaning up an old, linked or broken install first (`--npm` switches from a linked build to the npm package) |
| `dx uninstall` | Remove dx from this computer: every install, the app, its shortcuts, its place in AI tools and what runs from it (`--everything` deletes `~/.dx` too, `--yes` doesn't ask) |
| `dx claude todo-app` | Point the project's Claude Code sessions at dx: a note in `CLAUDE.local.md`, the dx tools that run and test allowed without asking, and a hint when Claude is about to run a test or dev command in a shell (`--all` for every project, `--undo`, `--status`). See [AI tools](ai-tools.md) |
| `dx hook pre-bash` | What that hint runs: reads Claude Code's JSON on stdin, prints guidance or nothing. Not run by hand |
| `dx setup` | Connect dx to your AI tools (it does this by itself; `--list` shows them, `--undo` removes dx from them) |
| `dx go todo-app` | Open the project in your editor, start its dev server here (its whole stack, if it has one), open the browser when it's ready |
| `dx prepare todo-app` | What [Run does first](features.md#run-gets-the-project-ready) and why: packages, `.env`, Docker, generated code, builds, migrations, the port. `--run` does it now, `--again` forgets what was done so every step runs |
| `dx go todo-app -w` | Same, but the dev server runs in a new terminal window |
| `dx go` | Pick from your most recently active projects |
| `dx go .` | The project in the current folder |
| `dx new vite-app shop` | New project `shop` from a template or a copy of a project, then open it |
| `dx clone octocat/todo-app` | Clone a repository into your projects folder, install its packages with the tool it uses (npm, pnpm, yarn, bun, pip, uv, go), create `.env` from `.env.example`, then open and run it. It lists the variables that still need a value |
| `dx resume todo-app` | Where you left off: when, which branch, what was running, your last note, commits since, uncommitted files. `dx go` shows it too when you come back after a while |
| `dx resume todo-app --note "next: due dates"` | Leave a note for next time (`--clear` removes it); your AI agent can leave one too |
| `dx status` | Work that exists only on this computer: uncommitted changes, commits no remote has, stashes, repos with no remote; most at risk first |
| `dx test todo-app` | Run its tests (vitest, jest, node:test, pytest, go test) and list each failure with its file, line, expected and actual; `-m cart` runs only the matching ones, `--changed` only those related to uncommitted changes, `--coverage` also how much of the code the tests run and the files with the least (vitest with a coverage provider, jest, node:test, pytest-cov, go; a custom test script can't be measured) |
| `dx db shop "select * from orders"` | A read-only query against the project's development database in docker-compose (Postgres, MySQL/MariaDB, Redis); `dx db shop` lists the tables. No password needed: it runs inside the container |
| `dx env todo-app` / `dx env --all` | Variables `.env.example` lists that your `.env` doesn't set, `.env` files git would commit, API keys or tokens in tracked files, and what `.gitignore` is missing to keep secrets out of git; `--gitignore` adds it |
| `dx projects` / `dx ls todo` | List projects (most recent first) / search them |
| `dx port` | Every listening port 1024+, with the process and its command line |
| `dx port 3000` | What's on port 3000 |
| `dx kill 3000` | Kill it (asks first; `-y` skips the question) |
| `dx log "fixed seat map overflow"` | Add a line to your work journal |
| `dx log` / `dx log --days 30` | Read the journal back |
| `dx summary` | Your commits across all projects plus your journal for the last 7 days, as markdown |
| `dx summary --copy` / `--save` | Copy it to the clipboard / save it to `~/.dx/summaries/` |
| `dx summary --year` | The year in review: month by month, projects, busiest day, longest run of days with commits, pull requests merged, your journal, and the year in numbers: when you code, the busiest week, bugs squashed, the most-touched file, languages, dev server time, first and last commit (`--year 2025` for another year; `--json` for every number) |
| `dx clean` | Delete `node_modules` and build folders in projects idle for 30+ days (asks first) |
| `dx deps` | Outdated packages and known vulnerabilities in every Node project (npm, pnpm, yarn, bun) |
| `dx deps --fix todo-app` | Update its packages within `package.json`'s ranges and apply the audit fixes that need no breaking change (asks first); major versions are listed for you |
| `dx https` | Serve `https://shop.localhost` with a certificate your browsers trust (`--status`, `--off`) |
| `dx state export` | [Your dx on another computer](features.md#your-dx-on-another-computer): everything you've set up, in one file; `dx state import <file>` shows what it would change (`--yes` brings it in, `--no-settings` keeps this computer's settings), `dx state undo --yes` puts it back |
| `dx runs` / `dx runs --failed` | Recent tool runs |
| `dx config` | Show settings; `dx config edit`, `dx config add-root <folder>`, `dx config editor <cmd>`, `dx config github <user>` |
| `dx doctor` | Check the setup |

`dx help <command>` shows every option.

**`dx go` details:**
- It reads the dev command from `package.json` (`dev`, then `start`, `serve`) and uses the right package manager (npm, pnpm, yarn, bun). Without one, from the project's other files: a `dev`, `run`, `start`, `serve`, `up` or `watch` target in a Makefile, justfile, Taskfile or `deno.json`; `bin/dev` or `bin/rails server` for Rails, `php artisan serve` for Laravel, `mix phx.server` for Phoenix, `python manage.py runserver` for Django, uvicorn for FastAPI, `flask run` for Flask, `dotnet watch run` for .NET; `go run .` and `cargo run` last.
- **Run it another way**: `dx go todo-app --modes` lists them, `--mode production` builds it and runs its own server (`build` then `start`, `preview` or `serve`, with `NODE_ENV=production`), `--mode script:start:staging` runs one of its per-environment scripts (with `build:staging` first when there is one), `--mode devrc:<name>` one of its `.devrc.json` modes, and `--env .env.staging` lays that file's values over `.env` (they win over `.env` in dotenv, Vite, Next.js and `node --env-file`). A mode brings its environment's file by itself (`production` uses `.env.production`); `--env ""` runs it without one. In the dashboard, **Run as** beside Run offers the same, the card says how it runs, and Restart and Run again run it the same way.
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

**Ways to run it of your own**, for **Run as** and `dx go --mode devrc:<name>`: a command (`run`), an optional `build` that runs first (the server starts only if it worked), an optional `.env.<name>` file (`env`) and variables (`vars`):

```json
{
  "modes": {
    "staging": { "label": "Staging build", "build": "npm run build -- --mode staging", "run": "npx serve dist", "env": ".env.staging", "vars": { "APP_ENV": "staging" } }
  }
}
```

**Steps of your own before Run** (see [Run gets the project ready](features.md#run-gets-the-project-ready)), in order; `after: "db"` waits for a stack's databases. `"prepare": false` turns preparing off:

```json
{
  "prepare": ["npm run codegen", { "run": "npm run db:seed", "after": "db", "title": "Seed the database" }]
}
```

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
- **`activity`** / **`activityDays`** / **`activityMaxMB`**: `false` turns the activity history off (pages are then left exactly as the dev server sends them); a number of days to keep instead of 7; and how many megabytes it may take in all instead of 500.
- **`visualDiff`** / **`visualMobile`**: `false` stops the screenshots after each commit ([Visual diff](features.md#visual-diff)); `true` captures each page at a phone's size too.
- **`sites`**: the sites the dx browser records, as `{ "host": "staging.shop-website.dev", "project": "/path/to/shop-website", "env": "staging", "label": "Shop staging" }`. Easier with `dx sites add` or **Record a site**.
- **`envAlerts`** / **`projectAlerts`**: `false` turns off the warnings when a `.env` file changes, is staged or is committed; per project (by folder), `{ "off": true }` silences its alerts and `{ "osOff": true }` only the system's notifications. Easier on the Env & secrets page.
- **`localhostRecording`**: `false` stops dx answering at an app's usual `localhost:<port>`; the dev server then runs there itself, and only its `.localhost` address is recorded.
- **`localDomains`** / **`localDomainsPort`**: `false` turns `*.localhost` addresses off; a number picks their port instead of 80 (or 1355).
- **`floppy`**: `{ "startup": true, "x": 1640, "colourway": "navy" }`, whether Floppy starts when you sign in, where along the bottom of the screen you left it, and its colours; `"off": true` after you send it away, so the app doesn't bring it back. Set by `dx floppy` and Floppy's menu.
- **`dashboard`**: `{ "open": "app", "startup": true }`, whether `dx ui` opens the dx app or your browser (`"browser"` after `dx ui --remove-app`), and whether the app opens when you sign in. Set by `dx ui`.
- **`aiToolsSeen`**: the AI tools dx has connected itself to once. A tool you disconnect stays disconnected. Set `"autoConnectAi": false` to stop dx connecting itself to new ones (`dx setup --undo` does both).

A folder counts as a project when it has a `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `requirements.txt`, a `.sln`/`.csproj`, a `.git` folder or a `.devrc.json`.

- **`scanDepth: 2`** also finds projects one folder down, e.g. `projects/archive/old-thing`. To skip a folder like that, add `"archive"` to `ignore`.
- **Folders starting with `.`** are always skipped.
