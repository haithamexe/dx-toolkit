# Claude, other AI tools and Raycast

What your AI assistant can do through dx, and the Raycast extension. Back to the [README](../README.md).

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

dx connects itself to **Claude Code, Claude Desktop, Cursor, Windsurf and VS Code** (Copilot's agent mode), whichever you have: see [Install](install.md). Restart Claude Desktop once afterwards; the others pick it up in new chats.

### Make dx the way your agent runs, tests and checks your app

dx tells every client when to prefer its tools (the MCP server's own instructions): `start_dev_server` and not `npm run dev`, `run_tests` and not `npm test`, `dx_verify` after an edit, `check_url` for a page, `dx_status` for where things stand. For a project's Claude Code sessions in particular, one command makes it stick:

```bash
dx claude todo-app
```

(or `dx claude` inside the project, `dx claude --all` for every project; a project dx first sees later gets it by itself; **Set up Claude to use dx** is in a project's More menu). It adds three local things, none of them committed (both files are listed in the repository's own `.git/info/exclude`, never its `.gitignore`):

- **`CLAUDE.local.md`**: a short marked block naming the dx tools to use here, with the project's own test and dev commands.
- **`.claude/settings.local.json`**: the dx tools that read, or run the project's own tests and dev server, allowed without a prompt (`run_tests`, `start_dev_server`, `dx_verify`, `dx_status`, `dev_errors`, `check_url` and a few more). Commits, deletes, `.env` values and the like keep asking, because they go through `dx_do_risky`.
- **A hint hook**: when Claude is about to run a test or dev command in a shell (`npm test`, `vitest`, `pytest`, `go test`, `npm run dev`, `vite`…), `dx hook pre-bash` adds a line telling it to use the dx tool instead. It only nudges: the command still runs, and still asks you as it would have. A command that isn't a test or dev command costs about 80 ms.

What was already in those files is kept, and `dx claude --undo` removes only what dx added (`--status` says what's set up). A settings file that isn't valid JSON is left exactly as it is.

**`dx_status`** answers in one call: whether the dev server runs and where, the errors it shows now, how the last test run went and when, and unsaved work. **`dx_verify`** does the loop after an edit in one call: waits for the rebuild, runs the tests related to the change (all of them where the framework can't tell), and with a `path` loads that page in a headless browser; the answer is one short verdict with only what failed.

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
| `check_env` | What a project's `.env` is missing compared with `.env.example`, `.env` files git would commit, keys or tokens in tracked files, and the `.gitignore` rules that keep secrets out of git |
| `run_tests` | Runs the project's tests and returns each failure with its name, file and line, and expected against actual; `match` reruns just the ones being fixed |
| `network_log` | The requests the app made through its `.localhost` address, with status, timing and bodies (credentials masked): what the front end sent the API, and what came back |
| `activity_log` | What happened in the app, in order: what the user clicked, the routes they went through, each request with its payload and response, console output and errors in the browser and on the server. Ask *"I clicked checkout and nothing happened, why?"* and the agent reads the steps that led there. `site` and `env` narrow it to a deployed site the dx browser recorded |
| `replay_visit` | Does what you did again in a headless browser: opens the page a visit started on, clicks what you clicked, and reports what broke. The agent reproduces your bug, fixes it, and replays it to confirm |
| `visual_diff` | Whether a commit changed how the app looks: each page changed or the same, the share of pixels and where ("around the Checkout button"), with the diff image. `capture: true` captures the current HEAD first |
| `security_check` | A friendly security pass on the app: unescaped script, calls that work without a session, CSRF, CORS, cookies, headers, stack traces, SQL errors, login limits, each with the request that shows it and what to fix |
| `realistic_data` | Fills the development database with realistic, connected data from its schema (list, make a scene, load one; what was there is saved first) |
| `chaos_mode` | Turns Chaos mode on or off (level, seed, which calls), sets the page's fake clock and the weak phone, and reports what broke: blank pages, uncaught errors, stuck spinners, orders sent twice, each with the chaos before it |
| `run_gremlins` | A headless browser clicks, types nonsense and double-submits through the app at random, and returns each problem with the steps to reproduce it |
| `behaviour_diff` | The same pages on the working copy and an earlier commit: calls, answers, errors and warnings compared |
| `env_values_that_matter` | Which .env values crash the app or break the page when missing, which nothing notices, and which the code never uses |
| `translation_check` | Pages with longer, accented text and right to left: text that's cut off or spills out, and text that isn't in the translation files, with its file and line |
| `try_upgrade` | Upgrades one package in a throwaway copy and reports what breaks or changes: type check, build, tests, and the pages' looks, calls, errors and speed |
| `db_queries` | Switches the compose database's statement log on or off, and lists each request's queries: N+1, slow queries, busy requests |
| `db_query` | A read-only query against the project's development database (Postgres, MySQL/MariaDB, Redis in docker-compose), to check what an action actually stored |
| `resume_project`, `leave_note` | Where things were left in a project (branch, what ran, open errors, commits since, the last note), and a note for next time. Ask *"carry on with todo-app"* and the agent starts from there |
| `dx_setup_check` | dx's health checks, each problem with the command that fixes it, so the agent can fix your setup for you |

These work on stacks too: `start_dev_server` starts every service in order and reports each with its address, errors are labelled with their service, and `check_url` accepts `.localhost` addresses such as `http://api.shop.localhost/health`.

The servers run in the dx dashboard, not inside the AI tool, so they keep running after the chat ends, and you can watch them, with a **Started by AI** label and their errors, on the project's Overview or with `dx logs <project> -f`.

**Watch what the agent does.** Every tool call the MCP server handles is written to `~/.dx/runs.jsonl` as `mcp.<tool>`: a sentence saying what it did, the project, a short summary of its arguments, whether it worked and how long it took. The dashboard's **AI lane** follows it live and `dx runs` lists it. Nothing secret is kept: only arguments on a fixed list are summarised (never a request body, headers, a note, a journal entry or a database query; those are counted, not kept), addresses are masked, and from a result only numbers are kept (a status code, how many errors), never `.env` values or query results. **Take over** on a server the agent started makes it yours; **Interrupt** stops the servers it started.

### Resources, prompts and structured results

Like other MCP servers, dx offers more than tools:

- **Resources** your AI tool can read without a tool call: `dx://projects`, `dx://actions` (the whole catalog), `dx://agents` (the agents running now), and `dx://project/<name>` for each project (how it runs and its dev server). Reading one never starts the dashboard.
- **Prompts**, ready-made requests with the project filled in (its name completes as you type): `fix_errors`, `ship_check`, `understand_project`, `break_it` and `whats_running`. They show up as slash commands in tools that support prompts.
- **Structured results**: `dx_do` and `dx_do_risky` answer with the result as data (`structuredContent`) as well as text, so a client can use it without parsing.

### Developing dx through your AI agent

When dx's own repository is one of your projects, your agent can work on dx itself through `dx_do` / `dx_do_risky`: `dev.info` (where the source is, its branch and changes, whether the build on disk is newer than the running dashboard), `dev.files` (list by part of a name, or search the text), `dev.read` (a file, from a line), `dev.build` and `dev.test` (as jobs it follows with `dev.job`), `dev.write` and `dev.restart` (**risky**: your AI tool asks first). Writing is limited to text files inside the repository (never git's folder, `node_modules`, builds or `.env` files, no links, 512 KB at most), the commands are fixed (`npm run build`, `npm test`, one at a time), and `dev.restart` stops the dashboard and the servers it runs so the next call starts the new build. Without dx's repository among your projects these say so and do nothing.

### Everything the dashboard does

Your agent can also use dx the way you do on the dashboard, every page of it: run and check apps, git (status, staging, commits, branches, tags, releases, undo), the API spec, mocks, rules and the Repeater, the activity history, the project's own tools, realistic data, chaos and the security pass, `.env` files, this computer (processes, Docker, ports, cleanup, dependencies), the summary and journal, and dx's settings. Ask it things like *"commit what's staged on shop-website with a good message and push"* or *"turn chaos on for todo-app, click through checkout, and tell me what broke"*.

| Tool | What the agent gets |
|---|---|
| `dx_actions` | What dx can do: the groups, then each group's actions with what they do and the inputs they take |
| `dx_do` | Does an action that isn't risky (reading, listing, starting a server, checking a page, staging…), through the dashboard's own API and checks |
| `dx_do_risky` | Does a risky one. **Your AI tool asks you before each call**: anything that deletes, can't be undone, leaves this computer (push, release), changes the project, its packages or its database, stops a process or a dev server, reads or writes `.env` values, commits, merges, rebases or switches branches, turns mock mode or chaos on, saves tools, rules or mocks, or changes dx's settings |

Allowing `dx_do` once in your AI tool doesn't allow `dx_do_risky`. Every call shows in the dashboard's AI panel and in `dx runs`.

### Your projects, ports, journal and week

- `list_projects`, `open_project`
- `list_ports`, `kill_port`
- `machine_info`: the tools installed and their versions (with whether a newer one is out or support has ended), what each project needs from this computer, and what's running in the background, so the agent's commands fit your computer
- `api_map`: the project's OpenAPI spec next to what the app called: each endpoint's calls, answers that don't fit the spec, and calls the spec doesn't have
- `mock_server`: starts or stops a project's mock server, so front-end work doesn't wait for the back end
- `find_unused`: API routes, pages and mocks nothing used in the activity history
- `project_tour`: a map of a project (how to run it, its pages and the calls each makes, the files behind them, its data and settings), to read before changing one it doesn't know
- `pr_proof`: how the current branch was tested, as the Markdown for its pull request
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
