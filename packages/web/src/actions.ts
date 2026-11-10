/**
 * Every dashboard action an AI agent can take through dx's MCP server (`dx_actions`, `dx_do`,
 * `dx_do_risky`), named and described for it: the same API the page uses, with the same checks.
 * `risky` ones (they delete, can't be undone, leave this computer, change the project or its
 * database, stop something, or hand over secrets) only go through `dx_do_risky`, so the agent's
 * client asks the user before each one. Left out: what only the page needs (polling, images) and
 * the buttons that ask an AI themselves.
 */

export interface DxAction {
  /** group.name, e.g. "git.commit". */
  id: string;
  group: string;
  title: string;
  method: "GET" | "POST";
  path: string;
  /** Input name → what it is; a trailing "?" in the name marks it optional. */
  params: Record<string, string>;
  /** Sent with every call (the named git operations go through one route). */
  fixed?: Record<string, unknown>;
  risky?: boolean;
}

const DIR = "the project's folder, as list_projects or projects.list gives it";
const GROUPS: Record<string, string> = {
  projects: "Projects: find, open, create, clone, notes",
  run: "Run: dev servers, their output and errors, page checks, tests",
  git: "Code: git status, diffs, staging, commits, branches, tags, releases, history, undo",
  api: "API: the spec, mocks, rules, intercept, the Repeater",
  activity: "Activity: the recorded history of requests, clicks, routes, console and errors",
  tools: "Tools: the project's own tools from its Tools page",
  data: "Data: realistic data scenes for the development database, queries per request",
  chaos: "Break it: chaos mode, gremlins, clock, languages, missing values, behaviour diff, unused routes, security",
  env: "Env & secrets: .env files, gitignore rules, alerts",
  machine: "This computer: tools, processes, Docker, ports, cleanup, dependencies",
  lookback: "Look back: summary, year, journal",
  settings: "Settings: dx's settings, AI tools, recorded sites, the dx browser, moving dx to another computer",
  team: "Team: tour, proof for the pull request, trying an upgrade, phone, snapshots",
  agents: "Agents: the AI agents and subagents running on this computer, what each is doing and how",
  dev: "Develop dx itself: where its source is, build and test it, restart the dashboard onto the new build, read and write files in its repository",
};
export const ACTION_GROUPS = GROUPS;

const A = (id: string, title: string, method: "GET" | "POST", path: string, params: Record<string, string> = {}, extra: { risky?: boolean; fixed?: Record<string, unknown> } = {}): DxAction => ({
  id,
  group: id.split(".")[0],
  title,
  method,
  path,
  params,
  ...extra,
});
const RISKY = { risky: true };
const git = (name: string, title: string, params: Record<string, string> = {}, risky = false): DxAction =>
  A(`git.${name}`, title, "POST", "/api/git/action", { dir: DIR, ...params }, { fixed: { action: name }, ...(risky ? RISKY : {}) });

export const DX_ACTIONS: DxAction[] = [
  // Projects
  A("projects.list", "Every project dx found, with its folder, kind, dev command and git state", "GET", "/api/projects"),
  A("projects.open", "Open a project in the editor, a terminal, the file manager or the browser", "POST", "/api/projects/open", { dir: DIR, action: "editor, terminal, folder or browser", "url?": "for browser: the address", "terminal?": "a terminal id from projects.terminals" }),
  A("projects.terminals", "The terminals dx can open", "GET", "/api/terminals"),
  A("projects.note", "Leave a note on where things stand in a project (empty removes it)", "POST", "/api/note", { dir: DIR, note: "the note" }),
  A("projects.unsaved", "Work that isn't backed up: uncommitted changes and unpushed commits, in every project", "GET", "/api/unsaved"),
  A("projects.templates", "The templates dx new can start from", "GET", "/api/templates"),
  A("projects.new", "Create a project from a template, a folder or another project", "POST", "/api/new", { name: "the new project's folder name", source: "a template, folder or project", "in?": "the projects folder to put it in", "git?": "true to start a git repository", "install?": "true to install packages", "open?": "true to open it after" }, RISKY),
  A("projects.save-template", "Save a project as a template", "POST", "/api/templates/save", { dir: DIR, name: "the template's name" }),
  A("projects.clone", "Clone a git repository and get it ready to run (its install scripts run)", "POST", "/api/clone", { url: "a git address or owner/repo", "name?": "the folder name", "install?": "false to skip installing" }, RISKY),
  A("projects.open-file", "Open a file of a project in the editor, at a line", "POST", "/api/open-file", { dir: DIR, file: "a path inside the project", "line?": "line number", "column?": "column number" }),

  // Run
  A("run.list", "The dev servers dx runs, with status, address and error count", "GET", "/api/dev"),
  A("run.start", "Start a project's dev server (or whole stack), or another way to run it (projects.list gives runModes and envFiles)", "POST", "/api/dev/start", { dir: DIR, "mode?": "a run mode's id: production, script:start:staging, devrc:<name>", "env?": "a .env.<name> file to lay over .env, or empty for none" }, { fixed: { by: "ai" } }),
  A("run.restart", "Restart a project's dev server", "POST", "/api/dev/restart", { dir: DIR }, { fixed: { by: "ai" }, risky: true }),
  A("run.stop", "Stop a project's dev server", "POST", "/api/dev/stop", { dir: DIR }, RISKY),
  A("run.logs", "A dev server's output, after a line number", "GET", "/api/dev/logs", { dir: DIR, "after?": "the last line number already seen" }),
  A("run.errors", "Errors in dev servers' output, with file and line", "GET", "/api/dev/errors", { "dir?": DIR, "all?": "true to include resolved ones", "after?": "line number" }),
  A("run.wait", "Wait for a dev server to rebuild or settle", "POST", "/api/dev/wait", { dir: DIR, "after?": "line number", "until?": "ready, quiet or rebuild", "quietMs?": "ms", "settleMs?": "ms", "timeoutMs?": "ms" }),
  A("run.clear", "Clear a dev server's output", "POST", "/api/dev/clear", { dir: DIR }),
  A("run.takeover", "Make a dev server an AI started the user's", "POST", "/api/dev/takeover", { dir: DIR }),
  A("run.check", "Load a page of a running app (loopback only) and report errors, failed requests and console; steps for a flow", "POST", "/api/check", { "url?": "an address on this computer", "dir?": DIR, "path?": "a path on the project's server", "browser?": "true for a headless browser", "steps?": "a list of steps (click, type, goto…)", "method?": "HTTP method", "headers?": "headers", "body?": "request body", "timeoutMs?": "ms", "screenshot?": "true for a screenshot" }),
  A("run.tests", "Run a project's tests and get each failure with file, line, expected and actual (and, with coverage, how much of the code they run)", "POST", "/api/tests", { dir: DIR, "coverage?": "true to measure coverage too", "match?": "a test name pattern", "changed?": "true for tests of changed files" }),
  A("run.traffic", "Requests the apps made through their .localhost addresses", "GET", "/api/traffic"),
  A("run.traffic-clear", "Clear the network log of a project", "POST", "/api/traffic/clear", { "dir?": DIR }),
  A("run.ai", "What AI agents did through dx lately", "GET", "/api/ai", { "dir?": DIR, "limit?": "how many" }),
  A("run.ai-interrupt", "Stop the dev servers AI agents started", "POST", "/api/ai/interrupt", { "dirs?": "a list of project folders" }, RISKY),

  // Code (git)
  A("git.status", "Branch, staged and changed files, ahead/behind", "GET", "/api/git/status", { dir: DIR }),
  A("git.diff", "A file's diff, as blocks with ids (to stage one block)", "GET", "/api/git/diff", { dir: DIR, path: "the file", "staged?": "true for the staged side" }),
  A("git.stage", "Stage files", "POST", "/api/git/stage", { dir: DIR, paths: "a list of files from git.status" }),
  A("git.unstage", "Unstage files", "POST", "/api/git/unstage", { dir: DIR, paths: "a list of files" }),
  A("git.stage-block", "Stage or unstage one block of a file's diff", "POST", "/api/git/hunk", { dir: DIR, path: "the file", hunk: "the block's id from git.diff", "staged?": "true to unstage it" }),
  A("git.commit", "Commit what's staged (stays on this computer until pushed)", "POST", "/api/git/commit", { dir: DIR, message: "the commit message", "amend?": "true to amend the last commit" }, RISKY),
  A("git.graph", "The history as a graph: commits, branches, tags", "GET", "/api/git/graph", { dir: DIR, "limit?": "how many commits" }),
  A("git.show", "One commit: message, author, files and diff", "GET", "/api/git/commit", { dir: DIR, hash: "the commit's hash" }),
  A("git.search", "Search commits by message, hash, author or file", "GET", "/api/git/search", { dir: DIR, q: "the words", "limit?": "how many" }),
  A("git.at", "The commit checked out at a moment", "GET", "/api/git/at", { dir: DIR, at: "an ISO date" }),
  A("git.refs", "Branches, remotes, tags and stashes", "GET", "/api/git/refs", { dir: DIR }),
  A("git.releases", "GitHub releases and whether one can be made here", "GET", "/api/git/releases", { dir: DIR }),
  A("git.undo-list", "The undo journal: what each dx git action can go back to", "GET", "/api/git/undo", { dir: DIR }),
  A("git.merge-preview", "Commits and conflicting files a merge would bring", "GET", "/api/git/preview", { dir: DIR, branch: "the branch" }),
  A("git.conflict", "A conflicted file's blocks", "GET", "/api/git/conflict", { dir: DIR, path: "the file" }),
  A("git.rebase-plan", "The commits an interactive rebase from a commit would replay", "GET", "/api/git/rebase-plan", { dir: DIR, from: "the commit" }),
  git("undo", "Undo the newest dx git action", { id: "the entry's id from git.undo-list" }, true),
  git("reset-to", "Move the branch back to a commit (keeping changes)", { hash: "the commit" }, true),
  git("revert", "Revert a commit with a new commit", { hash: "the commit" }, true),
  git("cherry-pick", "Copy a commit onto the current branch", { hash: "the commit" }, true),
  git("branch-create", "Create a branch", { name: "the branch name", "at?": "a commit", "switchTo?": "true to switch to it" }),
  git("switch", "Switch branch", { name: "the branch", "shelve?": "true to shelve uncommitted work first" }, true),
  git("branch-rename", "Rename a branch", { name: "the branch", to: "the new name" }),
  git("branch-delete", "Delete a branch", { name: "the branch" }, true),
  git("tag-create", "Create a tag", { name: "the tag", "at?": "a commit", "message?": "an annotation" }),
  git("tag-delete", "Delete a tag", { name: "the tag" }, true),
  git("release-create", "Create a GitHub release (tags, pushes the tag, publishes)", { tag: "the tag", "title?": "the title", "notes?": "the notes", "draft?": "true for a draft", "prerelease?": "true for a pre-release" }, true),
  git("merge", "Merge a branch into the current one", { branch: "the branch", "mode?": "merge, squash or ff" }, true),
  git("rebase", "Rebase the current branch onto another", { onto: "the branch" }, true),
  git("continue", "Continue a merge or rebase after resolving", {}, true),
  git("abort", "Abort a merge or rebase", {}, true),
  git("resolve", "Resolve a conflicted file by side or per block", { path: "the file", hash: "the file's hash from git.conflict", "side?": "ours or theirs", "choices?": "a choice per block" }),
  git("stash-push", "Shelve changes", { "paths?": "files", "message?": "a note" }),
  git("stash-apply", "Take shelved changes back", { oid: "the stash", "pop?": "true to drop it after" }),
  git("stash-drop", "Drop shelved changes", { oid: "the stash" }, true),
  git("discard", "Discard changes to files (backed up for undo)", { paths: "files" }, true),
  git("fetch", "Fetch from the remote"),
  git("pull", "Pull (fast-forward only)"),
  git("push", "Push the current branch (force only with lease)", { "force?": "true for --force-with-lease" }, true),
  git("push-tags", "Push tags", { "name?": "one tag", "all?": "true for all" }, true),
  git("rebase-run", "Edit history: reorder, reword, squash, fold or drop commits", { from: "the commit to start after", steps: "the plan from git.rebase-plan with an action each" }, true),
  A("git.visual", "Screenshots per commit and which commits changed how the app looks", "GET", "/api/visual", { dir: DIR }),
  A("git.visual-capture", "Capture the app's pages for the current commit", "POST", "/api/visual/capture", { dir: DIR }),
  A("git.fix-apply", "Apply a fix Claude proposed on the dashboard (by its id)", "POST", "/api/fix/apply", { dir: DIR, id: "the fix's id" }, RISKY),
  A("git.snapshots", "Older commits running as snapshots", "GET", "/api/snapshots", { "dir?": DIR }),
  A("git.snapshot-run", "Run an older commit next to the project's own dev server", "POST", "/api/snapshots/run", { dir: DIR, hash: "the commit" }, { fixed: { by: "ai" } }),
  A("git.snapshot-remove", "Remove a snapshot", "POST", "/api/snapshots/remove", { id: "the snapshot's id" }, RISKY),

  // API
  A("api.spec", "The project's API specs (it can have several, each named): their endpoints, which API each is in, what was called, and endpoints two APIs share", "GET", "/api/lab/spec", { dir: DIR }),
  A("api.spec-set", "Add an API spec to the project (or replace the one from the same file): a file in it, an address on the running app, or pasted text", "POST", "/api/lab/spec", { dir: DIR, "file?": "a file in the project", "url?": "a path on the running app", "text?": "the spec as text", "name?": "the API's name", "service?": "for a stack: which service it is", "mount?": "where it's served, e.g. /payments, when that isn't the spec's own base path", "id?": "an API's id, to replace it" }),
  A("api.spec-update", "Rename an API, or say which service it is or where it's served (its mocks keep their ids)", "POST", "/api/lab/spec/update", { dir: DIR, id: "the API's id from api.spec", "name?": "a new name", "service?": "a service ('' for none)", "mount?": "where it's served ('' for the spec's own)" }),
  A("api.spec-forget", "Remove one API of the project (by id), or all of them", "POST", "/api/lab/spec/forget", { dir: DIR, "id?": "an API's id from api.spec (all when left out)" }, RISKY),
  A("api.mocks", "The project's mocks (or one by id)", "GET", "/api/mocks", { dir: DIR, "id?": "a mock's id" }),
  A("api.mocks-make", "Make mocks from recorded calls", "POST", "/api/mocks/make", { dir: DIR, "since?": "how far back (1h, 3h…)", "visit?": "one visit's id" }, RISKY),
  A("api.mocks-from-spec", "Make mocks from the API specs, each API's mocks kept to it", "POST", "/api/lab/spec/mocks", { dir: DIR, "api?": "one API's id from api.spec (all when left out)" }, RISKY),
  A("api.mock-mode", "Turn mock mode on or off, strict, or the cache", "POST", "/api/mocks/mode", { dir: DIR, "on?": "true or false", "strict?": "true or false", "cache?": "true or false" }, RISKY),
  A("api.mock-update", "Change one mock: status, delay, body, on/off, offline or a preset", "POST", "/api/mocks/update", { dir: DIR, id: "the mock's id", "status?": "100-599", "delayMs?": "ms", "contentType?": "type", "body?": "the body", "enabled?": "true or false", "offline?": "true or false", "preset?": "fail, empty, slow, offline or reset" }, RISKY),
  A("api.mock-remove", "Remove one mock, or all", "POST", "/api/mocks/remove", { dir: DIR, "id?": "a mock's id", "all?": "true for all" }, RISKY),
  A("api.mock-purge", "Delete mocks of one source (cache, spec, generated, ai, recorded), or of one API", "POST", "/api/mocks/purge", { dir: DIR, "source?": "the source", "api?": "an API's id: only its mocks" }, RISKY),
  A("api.mock-server", "Start or stop the project's mock server", "POST", "/api/mocks/server", { dir: DIR, on: "true or false" }),
  A("api.rules", "The project's request rules", "GET", "/api/lab/rules", { dir: DIR }),
  A("api.rule-save", "Add or change a rule (change requests or answers, delay, fail, intercept)", "POST", "/api/lab/rules", { dir: DIR, rule: "the rule" }, RISKY),
  A("api.rule-remove", "Remove a rule", "POST", "/api/lab/rules/remove", { dir: DIR, id: "the rule's id" }, RISKY),
  A("api.intercept", "Requests held by intercept", "GET", "/api/lab/intercept", { dir: DIR }),
  A("api.intercept-act", "Send on, edit or drop a held request", "POST", "/api/lab/intercept", { id: "the held item's id", action: "send, edit or drop", "method?": "", "url?": "", "headers?": "", "body?": "", "status?": "" }),
  A("api.intercept-release", "Let every held request go", "POST", "/api/lab/intercept/release", { dir: DIR }),
  A("api.send", "Send a request to the project's dev server (the Repeater)", "POST", "/api/lab/send", { dir: DIR, method: "HTTP method", path: "a path starting with /", "headers?": "headers", "body?": "body", "service?": "a stack's service" }),
  A("api.history", "The Repeater's history", "GET", "/api/lab/history", { dir: DIR }),

  // Activity
  A("activity.overview", "Projects and sites with recorded activity, and counts", "GET", "/api/activity/overview", { "since?": "an ISO date" }),
  A("activity.list", "Recorded events: requests, clicks, routes, console, errors", "GET", "/api/activity", { "dir?": DIR, "site?": "a recorded site", "since?": "an ISO date", "problems?": "true for problems only", "q?": "search words", "limit?": "how many" }),
  A("activity.report", "A bug report for an event: its steps, requests and errors", "GET", "/api/activity/report", { dir: DIR, id: "the event's id", "site?": "a site" }),
  A("activity.replay", "Replay a recorded visit in a headless browser", "POST", "/api/activity/replay", { dir: DIR, visit: "the visit's id" }),
  A("activity.bundle", "A bug bundle for an event (to send to a teammate)", "GET", "/api/activity/bundle", { dir: DIR, id: "the event's id" }),
  A("activity.usage", "Space the activity history takes", "GET", "/api/activity/usage"),
  A("activity.clear", "Clear a project's or site's history", "POST", "/api/activity/clear", { "dir?": DIR, "site?": "a site" }, RISKY),

  // Tools
  A("tools.list", "The project's own tools, and whether its dev server runs", "GET", "/api/tools", { dir: DIR }),
  A("tools.check", "Check a tool definition and preview it", "POST", "/api/tools/check", { dir: DIR, tool: "the tool (dx's building blocks; see tools.list for examples)" }),
  A("tools.save", "Save a tool (new or changed)", "POST", "/api/tools/save", { dir: DIR, tool: "the tool" }, RISKY),
  A("tools.run", "Run a saved tool by id, or a draft", "POST", "/api/tools/run", { dir: DIR, "id?": "a saved tool's id", "tool?": "a draft", "inputs?": "an operation's inputs", "since?": "for a watch" }),
  A("tools.delete", "Delete a tool", "POST", "/api/tools/delete", { dir: DIR, id: "the tool's id" }, RISKY),
  A("tools.export", "All of a project's tools as one file", "GET", "/api/tools/export", { dir: DIR }),
  A("tools.import", "Add tools from a tools file", "POST", "/api/tools/import", { dir: DIR, file: "the file's text", "replace?": "true to replace same-named tools" }, RISKY),

  // Data
  A("data.info", "The project's schema, where data would go, and its scenes", "GET", "/api/data", { dir: DIR }),
  A("data.scene", "One scene's rows", "GET", "/api/data/scene", { dir: DIR, scene: "the scene's slug" }),
  A("data.make", "Make a scene from a recipe", "POST", "/api/data/make", { dir: DIR, "recipe?": "typical, big-customer, first-time or empty", "seed?": "a number", "name?": "a name" }),
  A("data.load", "Replace the development database's data with a scene (what's there is backed up first)", "POST", "/api/data/load", { dir: DIR, scene: "the scene's slug" }, RISKY),
  A("data.save", "Save the database's data as a scene", "POST", "/api/data/save", { dir: DIR, "name?": "a name" }),
  A("data.remove", "Delete a scene", "POST", "/api/data/remove", { dir: DIR, scene: "the scene's slug" }, RISKY),
  A("data.queries", "Queries per request: N+1, slow and busy requests", "GET", "/api/queries", { dir: DIR }),
  A("data.queries-switch", "Turn the database's query log on or off", "POST", "/api/queries", { dir: DIR, on: "true or false", "service?": "the compose service" }),

  // Break it
  A("chaos.settings", "Chaos settings and state", "GET", "/api/chaos", { dir: DIR }),
  A("chaos.set", "Chaos mode on or off, level, faults, seed, paths, clock, phone, languages", "POST", "/api/chaos", { dir: DIR, "on?": "true or false", "level?": "wifi, deploy or blackfriday", "faults?": "a list", "seed?": "a number", "paths?": "a pattern", "clock?": "{ at, frozen, timeZone }", "phone?": "true or false", "locale?": "{ pseudo, rtl }", "restart?": "true to start the run again" }, RISKY),
  A("chaos.report", "What broke in the current chaos run", "GET", "/api/chaos/report", { dir: DIR }),
  A("chaos.job", "A running check's progress and result", "GET", "/api/chaos/job", { id: "the job's id" }),
  A("chaos.job-stop", "Stop a running check", "POST", "/api/chaos/job/stop", { id: "the job's id" }),
  A("chaos.gremlins", "Random clicks and typing through the app, with the steps to each crash", "POST", "/api/chaos/gremlins", { dir: DIR, "actions?": "how many", "seed?": "a number", "bold?": "true to also click destructive-looking things", "phone?": "true", "path?": "where to start" }),
  A("chaos.env", "Which .env values matter: runs the app with each one blank", "POST", "/api/chaos/env", { dir: DIR, "path?": "page to check" }),
  A("chaos.behaviour", "Compare the app's behaviour with an earlier commit", "POST", "/api/chaos/behaviour", { dir: DIR, commit: "the commit", "paths?": "pages", "visit?": "a visit's id" }),
  A("chaos.attack", "A friendly security pass on the app (sends test records and wrong passwords)", "POST", "/api/chaos/attack", { dir: DIR, "readOnly?": "true to send nothing that writes" }, RISKY),
  A("chaos.languages", "Pseudo text and right to left: text cut off or never translated", "POST", "/api/chaos/locale", { dir: DIR, "paths?": "pages", "rtl?": "true" }),
  A("chaos.graveyard", "Routes and pages nobody used", "GET", "/api/chaos/graveyard", { dir: DIR, "days?": "how many days" }),

  // Env & secrets
  A("env.project", "The project's .env files (names, never values) and what git could leak", "GET", "/api/env/project", { dir: DIR }),
  A("env.check", "Committed keys and missing .env values", "GET", "/api/env", { dir: DIR }),
  A("env.read", "Read a .env file's values (secrets go to the AI)", "GET", "/api/env/file", { dir: DIR, name: "the file name, e.g. .env" }, RISKY),
  A("env.write", "Save a .env file whole", "POST", "/api/env/file", { dir: DIR, name: "the file name", content: "the whole text" }, RISKY),
  A("projects.claude-status", "Whether a project's Claude Code sessions are pointed at dx (note, allowed tools, hint hook)", "GET", "/api/claude", { dir: DIR }),
  A("projects.claude-setup", "Point a project's Claude Code sessions at dx (CLAUDE.local.md, allowed dx tools, a hint hook; local files excluded from git), or undo it", "POST", "/api/claude", { dir: DIR, "undo?": "true to take it back out" }, RISKY),
  A("env.create", "Create .env from the example file", "POST", "/api/env/create", { dir: DIR }),
  A("env.gitignore", "Add the missing secret rules to .gitignore", "POST", "/api/env/gitignore", { dir: DIR, "patterns?": "which rules" }),
  A("env.alerts", "The project's alert settings", "GET", "/api/alerts/project", { dir: DIR }),
  A("env.alerts-set", "Turn the project's alerts, or only the system notifications, on or off", "POST", "/api/alerts/project", { dir: DIR, "on?": "true or false", "os?": "true or false" }),

  // This computer
  A("machine.tools", "Installed developer tools, newest versions and support status", "GET", "/api/machine/tools", { "refresh?": "true" }),
  A("machine.export", "What this computer has for development (tools and versions, global npm packages, git settings, editor extensions, SSH key names), as a file for a new computer", "GET", "/api/machine/export"),
  A("machine.restore-plan", "What this computer still needs to match a machine file from another: steps and a script to read and run yourself (nothing is run)", "POST", "/api/machine/restore-plan", { file: "the machine file's JSON text" }),
  A("machine.projects", "What each project needs next to what's installed", "GET", "/api/machine/projects"),
  A("machine.processes", "Developer processes running, with memory, CPU and ports", "GET", "/api/machine/processes"),
  A("machine.stop", "Stop a process (by PID from machine.processes)", "POST", "/api/machine/stop", { pid: "the PID" }, RISKY),
  A("machine.docker", "Docker containers and reclaimable space", "GET", "/api/machine/docker"),
  A("machine.docker-stop", "Stop a container", "POST", "/api/machine/docker/stop", { id: "the container id" }, RISKY),
  A("machine.docker-clean", "Clean up Docker: stopped containers, unused images or build cache (never volumes)", "POST", "/api/machine/docker/prune", { what: "containers, images or build" }, RISKY),
  A("machine.services", "Databases and services that start with the computer", "GET", "/api/machine/services"),
  A("machine.update", "Open the update command for a tool in a terminal", "POST", "/api/machine/run", { tool: "the tool id", "dir?": DIR }),
  A("machine.ports", "What's listening on which port", "GET", "/api/ports", { "all?": "true for every port" }),
  A("machine.port-kill", "Stop what listens on a port", "POST", "/api/ports/kill", { port: "the port" }, RISKY),
  A("machine.cleanup", "node_modules and build folders that can go", "GET", "/api/cleanup", { "days?": "idle for at least" }),
  A("machine.cleanup-delete", "Delete those folders", "POST", "/api/cleanup/delete", { dirs: "folders from machine.cleanup", "days?": "the same days" }, RISKY),
  A("machine.deps", "The dependency audit's last result", "GET", "/api/deps"),
  A("machine.deps-run", "Audit dependencies across projects", "POST", "/api/deps/run", { "activeDays?": "only projects active in this many days" }),
  A("machine.deps-fix", "Update a project's packages within their ranges and fix advisories", "POST", "/api/deps/fix", { dir: DIR }, RISKY),

  // Look back
  A("lookback.summary", "The week's summary: commits, pull requests, journal, time per project", "GET", "/api/summary", { "days?": "how many days", "allAuthors?": "true", "github?": "false to skip pull requests" }),
  A("lookback.summary-save", "Save the summary as markdown", "POST", "/api/summary/save", { "days?": "how many days" }),
  A("lookback.year", "The year in review", "GET", "/api/summary/story", { "year?": "the year" }),
  A("lookback.journal", "Journal entries", "GET", "/api/journal", { "days?": "how many days" }),
  A("lookback.journal-add", "Add a journal entry", "POST", "/api/journal", { text: "what was done" }),

  // Settings
  A("settings.health", "dx's checks, settings and recent runs", "GET", "/api/health"),
  A("settings.set", "Change dx's settings (editor, projects folders, activity history, alerts…)", "POST", "/api/config", { "editor?": "", "githubUser?": "", "addRoot?": "a folder", "removeRoot?": "a folder", "scanDepth?": "1-3", "terminal?": "", "activity?": "", "envAlerts?": "", "localhostRecording?": "", "visualDiff?": "", "activityDays?": "", "activityMaxMB?": "" }, RISKY),
  A("settings.ai-tools", "AI tools on this computer and whether dx is connected", "GET", "/api/ai-tools"),
  A("settings.sites", "Sites the dx browser records", "GET", "/api/sites"),
  A("settings.site-add", "Record a deployed site", "POST", "/api/sites/add", { host: "the host", "dir?": DIR, "env?": "staging, production…", "label?": "a name" }),
  A("settings.site-remove", "Stop recording a site", "POST", "/api/sites/remove", { host: "the host" }),
  A("settings.browser", "The dx browser's state", "GET", "/api/browser"),
  A("settings.browser-open", "Open the dx browser at an address", "POST", "/api/browser/open", { "url?": "http(s) address" }),
  A("settings.browser-close", "Close the dx browser", "POST", "/api/browser/close"),
  A("settings.state-export", "Everything dx keeps, as one file for another computer", "POST", "/api/state/export", {}, RISKY),
  A("settings.state-last", "The last state import that can be undone", "GET", "/api/state/last"),
  A("settings.state-undo", "Undo the last state import", "POST", "/api/state/undo", {}, RISKY),

  // Agents
  A("agents.list", "The agents on this computer (Claude Code sessions and the subagents each started, as a tree): status, model, effort, the tool each runs now, its project, and how many calls went through dx. Metadata only, never messages", "GET", "/api/agents", { "hours?": "how far back, 1 to 336 (default 24)" }),

  // Develop dx itself (only when dx's own repository is one of the projects)
  A("dev.info", "dx's version, whether its own source is one of your projects (where, which branch, how many files changed), what the dashboard runs, and whether the build on disk is newer than it", "GET", "/api/dev-tools"),
  A("dev.build", "Build dx (npm run build in its repository) as a job; read it with dev.job", "POST", "/api/dev-tools/run", {}, { fixed: { task: "build" } }),
  A("dev.test", "Run dx's tests (npm test in its repository, a few minutes) as a job; read it with dev.job", "POST", "/api/dev-tools/run", {}, { fixed: { task: "test" } }),
  A("dev.job", "A build or test job's status and the end of its output", "GET", "/api/dev-tools/job", { id: "the job's id from dev.build or dev.test", "tail?": "how many output lines (default 80)" }),
  A("dev.restart", "Stop the dashboard (and the dev servers it runs) so the next dx call starts it from the current build", "POST", "/api/dev-tools/restart", {}, RISKY),
  A("dev.files", "List dx's repository files (by part of a name), or find the lines that mention some text", "GET", "/api/dev-tools/files", { "search?": "part of a file's path", "text?": "text to find in packages, docs, README and CLAUDE.md" }),
  A("dev.read", "Read a text file of dx's repository, from a line", "GET", "/api/dev-tools/file", { file: "a path in the repository, e.g. packages/core/src/tools/state.ts", "from?": "first line", "lines?": "how many lines (default 400)" }),
  A("dev.write", "Write a whole text file in dx's repository (creates or replaces; never git's folder, node_modules, builds or .env files). Note: package.json and scripts are writable, so a written file can run on the next dev.build or dev.test: read what you write", "POST", "/api/dev-tools/file", { file: "a path in the repository", content: "the whole text of the file" }, RISKY),

  // Team
  A("team.tour", "A map of the project: how to run it, pages, calls, files, data, settings", "GET", "/api/tour", { dir: DIR }),
  A("team.proof", "How this branch was tested, for its pull request", "GET", "/api/proof", { dir: DIR }),
  A("team.proof-pr", "Put the proof into the branch's open pull request", "POST", "/api/proof/pr", { dir: DIR }, RISKY),
  A("team.upgrade", "The last upgrade try", "GET", "/api/upgrade", { dir: DIR }),
  A("team.upgrade-try", "Try a package upgrade in a throwaway copy: checks, tests, pages before and after", "POST", "/api/upgrade", { dir: DIR, name: "the package", version: "a version or tag", "paths?": "pages" }),
  A("team.phone", "The project's phone session", "GET", "/api/phone", { dir: DIR }),
  A("team.phone-start", "Open the project on a phone over Wi-Fi (listens on the local network)", "POST", "/api/phone", { dir: DIR, "on?": "false to stop", "minutes?": "how long" }, RISKY),
];

const byId = new Map(DX_ACTIONS.map((a) => [a.id, a]));
export function dxAction(id: string): DxAction | undefined {
  return byId.get(id);
}

/** The request for an action: a GET's inputs in the address, a POST's in the body (with its fixed values). */
export function actionRequest(a: DxAction, input: Record<string, unknown>): { method: "GET" | "POST"; path: string; body?: Record<string, unknown> } {
  const known = new Map(Object.keys(a.params).map((k) => [k.replace(/\?$/, ""), !k.endsWith("?")]));
  for (const [name, required] of known) if (required && (input[name] === undefined || input[name] === null || input[name] === "")) throw new Error(`${a.id} needs ${name}: ${a.params[name]}.`);
  const unknown = Object.keys(input).filter((k) => !known.has(k));
  if (unknown.length) throw new Error(`${a.id} doesn't take ${unknown.join(", ")}. It takes: ${[...known.keys()].join(", ") || "nothing"}.`);
  if (a.method === "POST") return { method: "POST", path: a.path, body: { ...input, ...a.fixed } };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...input, ...a.fixed })) if (v !== undefined && v !== null) q.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  const qs = q.toString();
  return { method: "GET", path: qs ? `${a.path}?${qs}` : a.path };
}
