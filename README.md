# dx toolkit

Your projects, dev servers, ports, work journal and weekly summary in one place: a local dashboard, a `dx` command, and tools your AI assistant can call. Runs on Windows, macOS and Linux.

**Your AI coding agent can run your app and see what it does.** Claude Code, Cursor and the others start the dev server through dx, read its output, see compile errors and stack traces with their file and line, request pages, and check that a fix worked, while you watch the same server in the dashboard. dx connects itself to the AI tools on your computer: there's nothing to configure.

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/images/projects-light.png">
  <img alt="The dx dashboard's Projects page: six projects with Run, Open in editor and More buttons, and a running dev server for shop-website at localhost:5173." src="docs/images/projects.png">
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
| `config.json` | Settings: where your projects are, which editor to open |
| `journal.md` | Your work journal, plain markdown, edit it by hand any time |
| `runs.jsonl` | One line per tool run, so a failure is never silent (`dx runs`) |
| `summaries/` | Saved work summaries, one markdown file per day you ran `dx summary --save` |
| `templates/` | Your project templates for `dx new`, one folder each |
| `dashboard.json` | While the dashboard runs: its address and access token, readable by you only, so the `dx` command and AI tools can reach it |

---

## Setup

dx runs on **Windows, macOS and Linux**. You need **Node 22 or newer** (`node -v`) and git. Then, in a terminal (PowerShell on Windows):

```bash
git clone <this repository's URL> dx-toolkit
cd dx-toolkit
npm install
npm run build
npm run link      # puts the `dx` command on your PATH
dx ui             # opens the dashboard
```

That's all. The first time you use dx it sets itself up:
- **Your projects**: it looks in the usual code folders (`~/projects`, `~/code`, `~/dev`, `~/src`, `~/repos`, `~/Documents/GitHub`, `~/Desktop/projects` and similar) and uses the ones you have.
- **Your editor**: the first of VS Code, Cursor, Windsurf, Zed, Sublime Text or JetBrains it finds.
- **Your AI tools**: it adds itself to Claude Code, Claude Desktop, Cursor, Windsurf and VS Code, whichever are installed, and says so. A tool you install later is connected the next time the dashboard starts. `dx setup --undo` takes it all back.

Projects somewhere else? `dx config add-root <folder>`, or add the folder on the dashboard's Health page. `dx doctor` checks everything and says how to fix what isn't right; your AI tool can run the fixes for you (ask it to "check dx's setup").

- **macOS and Linux**: if `npm run link` fails with a permissions error, your global npm folder belongs to root. Use a Node version manager (nvm, fnm, Volta) rather than `sudo`.
- **Linux**: `dx port` and `dx kill` need `lsof` (`sudo apt install lsof` or your distro's equivalent). Copying a summary needs `wl-copy` or `xclip`, and "open in a terminal window" uses `x-terminal-emulator`.
- **macOS**: "open in a terminal window" uses Terminal.app; the first time, macOS asks whether your terminal may control it.

> If you switch Node versions with nvm, run `npm run link` again on the new version.

---

## The dashboard: `dx ui`

```powershell
dx ui
```

It opens the dx dashboard in your browser, where everything `dx` does is a button:

| Page | What you can do there |
|---|---|
| **Projects** | Search your projects; **Run** a dev server right in the page and watch its output live, open it in the browser when it's ready, **Stop** it; see its **errors** with file and line, and open your editor at that line; see servers your AI agent started; open a project in your editor, in a terminal window or in File Explorer; save one as a template |
| **New project** | Create a project from a template or a copy of another, with git and packages installed |
| **Ports** | See what's listening and stop it (it asks first, naming the process) |
| **Journal** | Add what you did, read back 7, 30 or 90 days |
| **Summary** | Your week: commits, pull requests, journal, where the time went, uncommitted work; copy it as markdown or save it |
| **Cleanup** | See which `node_modules` and build folders can go, pick them, delete them (it asks first) |
| **Dependencies** | Run the audit across all projects with a progress bar; open a row for its outdated packages |
| **Health & settings** | `dx doctor`'s checks with how to fix each problem, which AI tools are connected (with Connect and Disconnect buttons), your projects folders, editor and GitHub username, and recent activity |

| Summary | Cleanup |
|---|---|
| ![The Summary page: 11 commits in 3 projects, 4 journal entries, and the week's journal and commits.](docs/images/summary.png) | ![The Cleanup page: 168 MB of node_modules and build folders in three idle projects, selected for deletion.](docs/images/cleanup.png) |

- **It runs on your computer only** (`http://127.0.0.1:4646`). Every action needs a secret the page gets when it loads, so other websites can't use it.
- **It's started for you when needed.** When an AI tool asks dx to run a dev server, dx starts the dashboard in the background; `dx ui` then just opens it. A background dashboard stops itself after 30 minutes with no dev servers running and nobody using it. `dx ui --stop` stops it now.
- **Dev servers you start from the dashboard stop when the dashboard stops**, like a dev server stops when you close its terminal. For one that keeps running, use **More → Run in a terminal window**.
- Light and dark follow your system, or pick one at the bottom of the sidebar. It works on a phone-sized window too.
- `dx ui --port 5000` uses another port; `dx ui --no-open` doesn't open the browser. From the project folder, `npm run ui` does the same as `dx ui`.

---

## The `dx` command

| Command | What it does |
|---|---|
| `dx ui` | The dashboard: everything below, with buttons, in your browser |
| `dx ui --background` / `dx ui --stop` | Start it without a terminal / stop it and the dev servers it runs |
| `dx logs todo-app -f` | Follow the output of a dev server running in the dashboard, one your AI agent started included |
| `dx errors` | Errors in every running dev server, with file and line (`dx errors todo-app` for one) |
| `dx setup` | Connect dx to your AI tools (it does this by itself; `--list` shows them, `--undo` removes dx from them) |
| `dx go todo-app` | Open the project in your editor, start its dev server here, open the browser when it's ready |
| `dx go todo-app -w` | Same, but the dev server runs in a new terminal window |
| `dx go` | Pick from your most recently active projects |
| `dx go .` | The project in the current folder |
| `dx new vite-app shop` | New project `shop` from a template or a copy of a project, then open it |
| `dx projects` / `dx ls flam` | List projects (most recent first) / search them |
| `dx port` | Every listening port 1024+, with the process and its command line |
| `dx port 3000` | What's on port 3000 |
| `dx kill 3000` | Kill it (asks first; `-y` skips the question) |
| `dx log "fixed seat map overflow"` | Add a line to your work journal |
| `dx log` / `dx log --days 30` | Read the journal back |
| `dx summary` | Your commits across all projects plus your journal for the last 7 days, as markdown |
| `dx summary --copy` / `--save` | Copy it to the clipboard / save it to `~/.dx/summaries/` |
| `dx clean` | Delete `node_modules` and build folders in projects idle for 30+ days (asks first) |
| `dx deps` | Outdated packages and known vulnerabilities in every Node project |
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

**Every Thursday, automatically:** these save the summary at 4 pm each Thursday. Run them from the `dx-toolkit` folder, after `npm run build`, so they pick up the right paths. The file lands in `~/.dx/summaries/<date>.md`, and `dx runs` shows whether it ran.

<details>
<summary><b>Windows</b>: Task Scheduler. If the computer is off or asleep at 4 pm, it runs as soon as it's back on.</summary>

```powershell
$script   = Join-Path $PWD "packages\cli\dist\index.js"
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
    <string>$PWD/packages/cli/dist/index.js</string>
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
ExecStart="$(command -v node)" "$PWD/packages/cli/dist/index.js" summary --save
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

`systemctl --user list-timers` shows when it runs next. To remove it: `systemctl --user disable --now dx-summary.timer`, then delete the two files. Without systemd, a crontab line does the same, but skips a week the computer was off: `0 16 * * 4 "$(command -v node)" "$PWD/packages/cli/dist/index.js" summary --save` (write the two paths out in full; cron doesn't run `$(…)` for you).
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

- **`aiToolsSeen`**: the AI tools dx has connected itself to once. A tool you disconnect stays disconnected. Set `"autoConnectAi": false` to stop dx connecting itself to new ones (`dx setup --undo` does both).

A folder counts as a project when it has a `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `requirements.txt`, a `.sln`/`.csproj`, a `.git` folder or a `.devrc.json`.

- **`scanDepth: 2`** also finds projects one folder down, e.g. `projects/archive/old-thing`. To skip a folder like that, add `"archive"` to `ignore`.
- **Folders starting with `.`** are always skipped.

---

## Raycast

Needs [Raycast for Windows](https://www.raycast.com) installed and running, and `npm run build` done first.

```powershell
npm run raycast:install
npm run raycast:dev
```

Four commands appear in Raycast:
- **Open Project**: open in the editor, start the dev server, open in the browser, terminal here, show in File Explorer.
- **Kill Port**
- **Log Work**
- **Work Journal**

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
| `check_url` | Requests a page or API route (localhost only) and returns the status, title and start of the body, plus anything the server logged and any error it hit while answering |
| `dev_errors` | Current errors across running servers: TypeScript, Vite, esbuild, webpack and Next.js, Node stack traces, Python tracebacks, Go panics, with file and line. An error disappears once the server rebuilds cleanly |
| `dev_logs` | The server's output, only what's new since it last looked |
| `dev_servers`, `stop_dev_server`, `restart_dev_server` | What's running, and stopping or restarting it |
| `dx_setup_check` | dx's health checks, each problem with the command that fixes it, so the agent can fix your setup for you |

The servers run in the dx dashboard, not inside the AI tool, so they keep running after the chat ends, and you can watch them, with a **Started by AI** label and their errors, in the Projects page or with `dx logs <project> -f`.

### Your projects, ports, journal and week

- `list_projects`, `open_project`
- `list_ports`, `kill_port`
- `add_log_entry`, `read_log`
- `work_summary`: your commits, pull requests and journal for the last few days
- `find_cleanup`: which folders `dx clean` would delete and how much space that frees (it never deletes)
- `audit_dependencies`: outdated packages and vulnerabilities per project

Then you can say things like "free port 3000 and start todo-app" or "write my standup from what I did this week".

### Connecting by hand

Only needed for a tool dx doesn't know, such as Raycast AI. The server is `node /path/to/dx-toolkit/packages/mcp/dist/index.js` (on Windows in JSON, for example `C:\\Users\\you\\dx-toolkit\\…`). For reference, this is what `dx setup` writes for Claude Desktop in `claude_desktop_config.json` (`%APPDATA%\Claude\` on Windows, `~/Library/Application Support/Claude/` on macOS):

```json
{
  "mcpServers": {
    "dx": {
      "command": "node",
      "args": ["/path/to/dx-toolkit/packages/mcp/dist/index.js"]
    }
  }
}
```

And for Claude Code, run from the `dx-toolkit` folder:

```bash
claude mcp add -s user dx -- node "$PWD/packages/mcp/dist/index.js"
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

`npm test` builds everything and runs the tests in `packages/core`, `packages/web` and `packages/mcp`:
- **core**: the tools, including error detection on real output from each tool it knows and connecting to AI tools on a pretend computer.
- **web**: the dashboard's server, meaning its security checks, and a real dev server started, streamed, checked for errors and stopped through it.
- **mcp**: a real MCP client that starts an app, finds an error through a request and sees it cleared, as an agent would. On GitHub, [.github/workflows/ci.yml](.github/workflows/ci.yml) runs them on every push to `main` and every pull request, on Windows, macOS and Linux with Node 22 and 24, and tries the `dx` command itself.

## Working on dx with Claude Code

[CLAUDE.md](CLAUDE.md) tells Claude Code how this repo is built, its conventions and the dashboard's security rules. [docs/MEMORY.md](docs/MEMORY.md) keeps the decisions made so far and why, the gotchas, and the backlog. CLAUDE.md imports it, so both load in every session here. Update MEMORY.md when a decision is made.

## Next on the list

- **Raycast**: install and check the extension, and add commands for the summary and cleanup.
- **Stacks and local domains**: start a front end, API and worker together with `dx up`, at addresses like `shop.localhost` instead of port numbers.
- **Browser console errors** for agents: dx sees the server's output; pairing it with a browser MCP server covers what happens in the page.
- **Tests for the CLI**: `core`, the dashboard and the MCP server are tested today.
- **`dx deps --fix`**, and yarn and bun projects in `dx deps`.

The full backlog is in [docs/MEMORY.md](docs/MEMORY.md).

## Troubleshooting

- **"Access is denied" when killing a process**: it belongs to another user or needs admin rights. Run the terminal as administrator.
- **`dx` not found after `npm run link`**: open a new terminal. If it still isn't found, check that the folder `npm prefix -g` prints is on your PATH.
- **Editor doesn't open**: run `dx doctor`, then set the editor with `dx config editor "C:\Path\To\Editor.exe"`.
- **Debug output**: set `DX_DEBUG=1` to print full error stacks.

## Contributing

Bug reports, ideas and pull requests are welcome: [CONTRIBUTING.md](CONTRIBUTING.md) has the setup and the conventions, and [CHANGELOG.md](CHANGELOG.md) what changed in each version. Please follow the [code of conduct](CODE_OF_CONDUCT.md), and report security problems privately as [SECURITY.md](SECURITY.md) explains.

## License

[MIT](LICENSE)
