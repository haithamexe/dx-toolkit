import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addJournalEntry,
  auditDependencies,
  buildSummary,
  checkEnv,
  cloneProject,
  commandExists,
  findUnsavedWork,
  fixDependencies,
  leaveNote,
  sessionLookup,
  runTests,
  buildYearReview,
  buildYearStory,
  formatYearReview,
  saveYearReview,
  type YearReview,
  type YearStory,
  connectAiTools,
  copyProject,
  deleteCleanup,
  detectStack,
  disconnectAiTools,
  expandHome,
  findCleanup,
  formatSummary,
  isValidProjectName,
  killPort,
  listAiTools,
  listListeningPorts,
  listTemplates,
  loadConfig,
  openFileInEditor,
  openInEditor,
  openTerminal,
  openUrl,
  readJournal,
  readProject,
  readRuns,
  recordRun,
  revealInFileManager,
  runDoctor,
  saveAsTemplate,
  saveConfig,
  saveSummary,
  scanProjects,
  ACTIVITY_TYPES,
  clearActivity,
  activityUsage,
  addGitignoreRules,
  auditEnv,
  ensureEnvFile,
  readEnvFile,
  writeEnvFile,
  bugReport,
  DAY_LIMIT_BYTES,
  isLoopbackUrl,
  readActivity,
  replayFromVisit,
  reportContext,
  type Replay,
  listTerminals,
  gitCommitChanges,
  gitSuggestMessage,
  claudeCli,
  applyFix,
  proposeFix,
  splitLocation,
  type FixTarget,
  gitRefs,
  gitUndoList,
  gitUndo,
  gitMergePreview,
  gitConflict,
  gitRebasePlan,
  gitRebaseRun,
  gitResetTo,
  gitRevert,
  gitCherryPick,
  gitCreateBranch,
  gitSwitch,
  gitRenameBranch,
  gitDeleteBranch,
  gitCreateTag,
  gitDeleteTag,
  gitMerge,
  gitRebase,
  gitContinue,
  gitAbort,
  gitResolve,
  gitStashPush,
  gitStashApply,
  gitStashDrop,
  gitDiscard,
  gitFetch,
  gitPull,
  gitPush,
  gitPushTags,
  type ConflictChoice,
  type ConflictResolution,
  type GitActionResult,
  type MergeMode,
  type RebaseAction,
  commitAt,
  searchCommits,
  snapshotByDir,
  snapshotProject,
  gitCommitDetail,
  gitFileDiff,
  gitGraph,
  gitStage,
  gitStageHunk,
  gitStatus,
  gitUnstage,
  GitError,
  GIT_GRAPH_MAX,
  parseSince,
  terminalIds,
  checkProjectNeeds,
  checkTools,
  dockerInfo,
  dockerPrune,
  dockerStop,
  installedTools,
  latestVersions,
  listDevProcesses,
  listServices,
  stopDevProcess,
  supportedNodeLines,
  TOOL_IDS,
  activityOverview,
  addSite,
  checkOpenUrl,
  listSites,
  normalizeSiteHost,
  removeSite,
  resolveCommit,
  siteDir,
  type DockerPrune,
  type ToolId,
  addMocks,
  bugBundleFileName,
  BugBundleError,
  clearMocks,
  exportBugBundle,
  loadMocks,
  MockError,
  mockSummary,
  readBugBundle,
  removeMock,
  setMockMode,
  updateMock,
  describeCapture,
  listVisual,
  visualImageFile,
  visualFolder,
  VisualError,
  type ActivityType,
  type AiToolId,
  type DepsReport,
  type PageStep,
  type Project,
  type Source,
} from "@dx/core";
import { activitySettings, flushActivity, forgetActivitySettings, forgetRecentActivity, listActivity } from "./activity.js";
import { checkUrl } from "./check.js";
import { clearTraffic, listTraffic } from "./traffic.js";
import { forgetFix, rememberFix, storedFix } from "./fixes.js";
import { removeSnapshotRun, runSnapshot, snapshotViews } from "./snapshots.js";
import { bugReplayJob, startBugReplay } from "./bugreplay.js";
import { forgetMocks, mockServerFor } from "./mocks.js";
import { labRoutes } from "./labapi.js";
import { chaosRoutes } from "./chaosapi.js";
import { dataRoutes } from "./dataapi.js";
import { phoneRoutes } from "./phone.js";
import { teamRoutes } from "./teamapi.js";
import { closeDxBrowser, dxBrowserStatus, forgetSites, openDxBrowser } from "./dxbrowser.js";
import {
  clearDevServer,
  devErrors,
  devLogs,
  listDevServers,
  restartDevServer,
  startDevServer,
  stopDevServer,
  takeOverDevServer,
  waitForDevServer,
  type StartedBy,
} from "./dev.js";
import { aiLane, interruptAi } from "./ai.js";
import { noticeHead, requestCapture, sawHead, visualState } from "./visual.js";

/** A request the page made, already parsed. */
export interface ApiRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Handler = (req: ApiRequest) => Promise<unknown> | unknown;

const routes: Record<string, Handler> = {
  "GET /api/ping": () => ({ ok: true, pid: process.pid }),

  // ------------------------------------------------------------ projects
  "GET /api/projects": () => {
    const running = new Map(listDevServers().map((d) => [d.dir.toLowerCase(), d]));
    const sessionOf = sessionLookup();
    return scanProjects(loadConfig()).map((p) => {
      const stack = detectStack(p);
      const s = sessionOf(p.dir);
      return {
      session: s && { at: s.at, branch: s.branch, note: s.note, noteBy: s.noteBy, noteAt: s.noteAt },
      name: p.name,
      dir: p.dir,
      kind: p.kind,
      packageManager: p.packageManager,
      devCommand: p.devCommand,
      url: p.url,
      hasGit: p.hasGit,
      lastActive: p.lastActive,
      dev: running.get(p.dir.toLowerCase()),
      mocks: mockSummary(p.dir),
      stack: stack && { source: stack.source, services: stack.services.map((s) => ({ name: s.name, role: s.role, kind: s.kind, command: s.command })) },
    };
    });
  },

  "POST /api/projects/open": async (req) => {
    const project = knownProject(req.body.dir, { snapshots: true });
    const config = loadConfig();
    const action = String(req.body.action);
    if (action === "editor") {
      const editor = project.editor ?? config.editor;
      await openInEditor(project.dir, editor);
      recordRun("go", true, project.name, "web", { project: project.name });
      return { message: `Opened ${project.name} in ${editor}` };
    }
    if (action === "browser") {
      const url = String(req.body.url || project.url || "");
      if (!url) throw new HttpError(400, `${project.name} has no URL. Start its dev server first, or set "url" in .devrc.json.`);
      await openUrl(url);
      return { message: `Opened ${url}` };
    }
    if (action === "folder") {
      await revealInFileManager(project.dir);
      return { message: `Showed ${project.name} in the file manager` };
    }
    if (action === "terminal") {
      if (snapshotByDir(project.dir)) throw new HttpError(400, "Run a snapshot from the dashboard, or with dx run.");
      if (!project.devCommand) throw new HttpError(400, `${project.name} has no dev command.`);
      const command = (await commandExists("dx")) ? "dx go . --no-editor" : project.devCommand;
      const used = await openTerminal(project.dir, command, project.name);
      recordRun("go", true, project.name, "web", { project: project.name });
      return { message: `Started ${project.devCommand} in a new ${used} window` };
    }
    if (action === "shell") {
      // Just a terminal in the project's folder, in the terminal picked in settings (or this one).
      const terminal = typeof req.body.terminal === "string" && terminalIds().includes(req.body.terminal) ? req.body.terminal : undefined;
      const used = await openTerminal(project.dir, undefined, project.name, terminal);
      recordRun("terminal", true, `${project.name} in ${used}`, "web", { project: project.name });
      return { message: `Opened ${project.name} in ${used}` };
    }
    throw new HttpError(400, `Unknown action: ${action}`);
  },
  "GET /api/terminals": () => listTerminals(),

  // ------------------------------------------------------------ dev servers
  "POST /api/note": (req) => {
    const project = knownProject(req.body.dir);
    const s = leaveNote(project.dir, project.name, String(req.body.note ?? ""), "you");
    recordRun("resume", true, `${project.name}: note ${s.note ? "left" : "removed"}`, "web", { project: project.name });
    return { note: s.note ?? null };
  },
  "GET /api/traffic": (req) => {
    const q = req.query;
    const dir = q.get("dir") ? knownProject(q.get("dir"), { snapshots: true }).dir : undefined;
    return listTraffic({
      dir,
      service: q.get("service") || undefined,
      after: q.get("after") ? Number(q.get("after")) : undefined,
      all: q.get("all") === "1",
      failed: q.get("failed") === "1",
      path: q.get("path") || undefined,
      limit: clampInt(q.get("limit"), 1, 1000, 200),
    });
  },
  "POST /api/traffic/clear": (req) => {
    clearTraffic(knownProject(req.body.dir).dir);
    return { ok: true };
  },
  "GET /api/activity": (req) => {
    const q = req.query;
    const since = q.get("since") ? parseSince(q.get("since")!) : undefined;
    if (q.get("since") && !since) throw new HttpError(400, "since takes 30m, 2h, 3d, today, yesterday or a date.");
    return listActivity({
      dir: activityDirOf(q.get("dir"), q.get("site")),
      // host: what the dx browser recorded on a site, whichever project it's linked to.
      site: q.get("host") || undefined,
      env: q.get("env") || undefined,
      types: (q.get("types") ?? "")
        .split(",")
        .filter((t): t is ActivityType => (ACTIVITY_TYPES as string[]).includes(t)),
      problems: q.get("problems") === "1",
      after: q.get("after") ? clampInt(q.get("after"), 0, Number.MAX_SAFE_INTEGER, 0) : undefined,
      since,
      search: q.get("q") || undefined,
      limit: clampInt(q.get("limit"), 1, 2000, 200),
    });
  },
  // The Activity page's list: every project and recorded site with its counts, the sites, and the dx browser.
  "GET /api/activity/overview": (req) => {
    const raw = req.query.get("since");
    const since = raw ? parseSince(raw) : undefined;
    if (raw && !since) throw new HttpError(400, "since takes 30m, 2h, 3d, today, yesterday or a date.");
    flushActivity();
    return { entries: activityOverview({ since }), sites: siteViews(), browser: dxBrowserStatus() };
  },
  "GET /api/activity/usage": () => {
    const s = activitySettings();
    return { ...activityUsage(), maxBytes: s.maxBytes, dayLimitBytes: DAY_LIMIT_BYTES, days: s.days, on: s.on };
  },
  "GET /api/activity/report": (req) => {
    const dir = activityDirOf(req.query.get("dir"), req.query.get("site"));
    if (!dir) throw new HttpError(400, "Which project or site?");
    const id = Number(req.query.get("id"));
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "Which event? Give its id.");
    flushActivity();
    const { target, events } = reportContext(dir, id);
    if (!target) throw new HttpError(404, "That event isn't in the history any more.");
    return { title: target.text.split("\n")[0], markdown: bugReport(target, events) };
  },
  "POST /api/activity/replay": async (req) => {
    const project = knownProject(req.body.dir, { snapshots: true });
    const visit = typeof req.body.visit === "string" ? req.body.visit.slice(0, 40) : "";
    if (!visit) throw new HttpError(400, "Which visit? Give its id.");
    const replay = replayOf(project.dir, visit);
    const result = await checkUrl({ url: replay.url, browser: true, steps: replay.steps, timeoutMs: 60_000 });
    // The replay worked when every step could be done; what it found on the page is the detail.
    const page = result.page;
    const done = !!page && !page.error && (page.steps ?? []).every((s) => s.ok);
    const found = page ? page.exceptions.length + page.consoleErrors.length + page.failedRequests.length : 0;
    recordRun("replay", done, `${project.name}: replayed ${replay.steps.length} step(s)${found ? `, ${found} problem(s) on the page` : ", no problems"}`, "web", { project: project.name });
    return { replay, result };
  },
  // A bug bundle: the error, the events around it and the visit's steps, masked again, with
  // paths made project-relative and no host; the page saves it as a file.
  "GET /api/activity/bundle": async (req) => {
    const project = knownProject(req.query.get("dir"), { snapshots: true });
    flushActivity();
    const bundle = await bundleCall(() => exportBugBundle(project, Number(req.query.get("id"))));
    recordRun("bug-bundle", true, `${project.name}: exported ${bundle.error.text.split(/\r?\n/)[0].slice(0, 80)}`, "web", { project: project.name });
    return { file: bugBundleFileName(bundle), bundle };
  },
  // Replaying someone's bundle: checked field by field (readBugBundle), the commit must be hex and
  // in this project's repository, and the steps run only on this project's own dev server.
  "POST /api/activity/bundle/replay": async (req) => {
    const bundle = await bundleCall(async () => readBugBundle(req.body.bundle));
    const use = req.body.use === "working" ? "working" : "commit";
    const project = use === "commit" ? gitProject(req.body.dir) : knownProject(req.body.dir);
    if (use === "commit" && !bundle.git) throw new HttpError(400, "The bundle doesn't say which commit it was recorded at. Replay it on your working copy instead.");
    return gitCall(() => startBugReplay(project, bundle, use));
  },
  "GET /api/activity/bundle/replay": (req) => {
    const job = bugReplayJob(String(req.query.get("id") ?? ""));
    if (!job) throw new HttpError(404, "That replay isn't known any more. Start it again.");
    return job;
  },

  // ------------------------------------------------------------ mock mode
  // Mocks apply only in dx's own proxy, for dev servers dx runs; files are 0600; bodies at most 1 MB.
  "GET /api/mocks": (req) => {
    const project = knownProject(req.query.get("dir"), { snapshots: true });
    const set = loadMocks(project.dir, project.name);
    // The list without whole bodies; one endpoint's whole body comes with ?id.
    const id = req.query.get("id");
    if (id) {
      const ep = set.endpoints.find((e) => e.id === id);
      if (!ep) throw new HttpError(404, "That mock isn't there any more. Refresh the list.");
      return ep;
    }
    return {
      ...set,
      server: mockServerFor(project.dir),
      endpoints: set.endpoints.map(({ body, recorded, ...e }) => ({ ...e, bytes: Buffer.byteLength(body), preview: body.slice(0, 2000), recordedAt: recorded.at, recordedStatus: recorded.status })),
    };
  },
  "POST /api/mocks/make": (req) => {
    const project = knownProject(req.body.dir, { snapshots: true });
    flushActivity();
    const visit = typeof req.body.visit === "string" ? req.body.visit.slice(0, 40) : "";
    const events = visit ? visitRequests(project.dir, visit) : sinceRequests(project.dir, req.body.since);
    const r = addMocks(project.dir, project.name, events);
    forgetMocks();
    if (!r.added && !r.replaced && !r.kept) throw new HttpError(404, "No API calls through dx in that time. Open the app at its .localhost address (or the address dx records) and use it first.");
    recordRun("mock", true, `${project.name}: ${r.added} added, ${r.replaced} updated${r.kept ? `, ${r.kept} you edited kept` : ""}`, "web", { project: project.name });
    return { added: r.added, replaced: r.replaced, kept: r.kept, endpoints: r.set.endpoints.length, on: r.set.on };
  },
  "POST /api/mocks/mode": (req) => {
    const project = knownProject(req.body.dir, { snapshots: true });
    const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
    const set = mockCall(() =>
      setMockMode(project.dir, project.name, { on: bool(req.body.on), strict: bool(req.body.strict), cache: bool(req.body.cache) }),
    );
    forgetMocks();
    recordRun(
      "mock",
      true,
      `${project.name}: mock mode ${set.on ? "on" : "off"}${set.strict ? " (strict)" : ""}${set.cache ? ", caching answers" : ""}`,
      "web",
      { project: project.name },
    );
    return { on: set.on, strict: set.strict, cache: !!set.cache, endpoints: set.endpoints.length };
  },
  "POST /api/mocks/update": (req) => {
    const project = knownProject(req.body.dir, { snapshots: true });
    const ep = mockCall(() =>
      updateMock(project.dir, String(req.body.id ?? ""), {
        status: req.body.status,
        delayMs: req.body.delayMs,
        contentType: req.body.contentType,
        body: req.body.body,
        enabled: req.body.enabled,
        offline: req.body.offline,
        preset: req.body.preset,
      }),
    );
    forgetMocks();
    return ep;
  },
  "POST /api/mocks/remove": (req) => {
    const project = knownProject(req.body.dir, { snapshots: true });
    if (req.body.all === true) clearMocks(project.dir);
    else mockCall(() => removeMock(project.dir, String(req.body.id ?? "")));
    forgetMocks();
    recordRun("mock", true, `${project.name}: ${req.body.all === true ? "every mock removed" : "a mock removed"}`, "web", { project: project.name });
    return { ok: true };
  },

  "POST /api/activity/clear": (req) => {
    const dir = req.body.site !== undefined ? activityDirOf(undefined, req.body.site) : req.body.dir === undefined ? undefined : knownProject(req.body.dir).dir;
    forgetRecentActivity(dir);
    clearActivity(dir);
    recordRun("activity", true, dir ? `${dir.startsWith("site:") ? dir.slice(5) : path.basename(dir)}: history cleared` : "all history cleared", "web");
    return { ok: true };
  },

  // ------------------------------------------------------------ the dx browser and recorded sites
  // The browser is driven over a pipe, never a port; it records only recorded sites and addresses
  // on this computer, masked before storing; an address to open must be http(s). dx fetches
  // nothing from those sites itself.
  "GET /api/browser": () => dxBrowserStatus(),
  "POST /api/browser/open": async (req) => {
    let url: string | undefined;
    if (req.body.url !== undefined && req.body.url !== "") {
      try {
        url = checkOpenUrl(String(req.body.url));
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    }
    // Which host, never the whole address: it can carry a token.
    const where = url ? ` at ${new URL(url).host}` : "";
    try {
      const status = await openDxBrowser(url);
      recordRun("browser", true, `opened${where}`, "web");
      return status;
    } catch (err) {
      recordRun("browser", false, `couldn't open${where}: ${(err as Error).message.split("\n")[0]}`, "web");
      throw new HttpError(500, (err as Error).message);
    }
  },
  "POST /api/browser/close": async () => {
    const closed = await closeDxBrowser();
    if (closed) recordRun("browser", true, "closed", "web");
    return dxBrowserStatus();
  },
  "GET /api/sites": () => siteViews(),
  "POST /api/sites/add": (req) => {
    const project = req.body.dir ? knownProject(req.body.dir) : undefined;
    try {
      const site = addSite({
        host: String(req.body.host ?? ""),
        project: project?.dir,
        env: typeof req.body.env === "string" ? req.body.env : undefined,
        label: typeof req.body.label === "string" ? req.body.label : undefined,
      });
      forgetSites();
      recordRun("sites", true, `recording ${site.host} (${site.env})${project ? ` for ${project.name}` : ""}`, "web", project ? { project: project.name } : {});
      return siteViews().find((s) => s.host === site.host) ?? site;
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  },
  "POST /api/sites/remove": (req) => {
    let removed;
    try {
      removed = removeSite(String(req.body.host ?? ""));
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    if (!removed) throw new HttpError(404, "That site isn't recorded. Refresh the list.");
    forgetSites();
    recordRun("sites", true, `stopped recording ${removed.host}`, "web");
    return { ok: true, host: removed.host };
  },
  // A commit a site said it runs: shown with Run this commit only when the linked project has it.
  "GET /api/sites/commit": async (req) => {
    const project = gitProject(req.query.get("dir"));
    const c = await gitCall(() => resolveCommit(project.dir, String(req.query.get("hash") ?? "")));
    return { hash: c.hash, short: c.short, subject: c.subject };
  },
  "POST /api/tests": (req) =>
    runTests(knownProject(req.body.dir), {
      match: typeof req.body.match === "string" && req.body.match ? req.body.match : undefined,
      changed: req.body.changed === true,
      source: "web",
    }),
  "GET /api/env": (req) => checkEnv(knownProject(req.query.get("dir")).dir),
  // The Env page: every project's .env files and .gitignore, then one project in full.
  "GET /api/env/all": () =>
    scanProjects(loadConfig()).map((p) => {
      const a = auditEnv(p.dir);
      return { name: p.name, ...a };
    }),
  "GET /api/env/project": (req) => {
    const project = knownProject(req.query.get("dir"));
    return { name: project.name, ...auditEnv(project.dir, { secrets: true }) };
  },
  "GET /api/env/file": (req) => {
    const project = knownProject(req.query.get("dir"));
    const name = String(req.query.get("name") ?? "");
    try {
      return { name, content: readEnvFile(project.dir, name) };
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  },
  "POST /api/env/file": (req) => {
    const project = knownProject(req.body.dir);
    const name = String(req.body.name ?? "");
    if (typeof req.body.content !== "string") throw new HttpError(400, "Send the file's content as text.");
    try {
      writeEnvFile(project.dir, name, req.body.content);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    // Which file, never what's in it.
    recordRun("env", true, `${project.name}: saved ${name}`, "web", { project: project.name });
    return { ok: true, name };
  },
  "POST /api/env/create": (req) => {
    const project = knownProject(req.body.dir);
    const created = ensureEnvFile(project.dir);
    if (!created) throw new HttpError(400, `${project.name} already has a .env, or no .env.example to make one from.`);
    recordRun("env", true, `${project.name}: created .env from the example`, "web", { project: project.name });
    return { ok: true, name: path.relative(project.dir, created).split(path.sep).join("/") };
  },
  "POST /api/env/gitignore": (req) => {
    const project = knownProject(req.body.dir);
    const patterns = Array.isArray(req.body.patterns) ? req.body.patterns.filter((p: unknown): p is string => typeof p === "string") : [];
    const added = addGitignoreRules(project.dir, patterns);
    recordRun("env", true, `${project.name}: .gitignore ${added.length ? `now ignores ${added.join(", ")}` : "already had them"}`, "web", { project: project.name });
    return { added };
  },
  // ------------------------------------------------------------ git: the graph and the staging board
  // Every path must be one `git status` lists right now, and a block is named by its id: the
  // patch is built from git's own diff (gitStageHunk), never taken from the request.
  // Run any commit: the search runs git with the words as one fixed-string argument; a commit must
  // be 4 to 40 hex characters and resolve; snapshots live only under ~/.dx/snapshots.
  "GET /api/git/search": (req) =>
    gitCall(() => searchCommits(gitProject(req.query.get("dir")).dir, String(req.query.get("q") ?? ""), { limit: clampInt(req.query.get("limit"), 1, 200, 50) })),
  "GET /api/git/at": async (req) => {
    const project = gitProject(req.query.get("dir"));
    const at = Number(req.query.get("at"));
    if (!req.query.get("at") || !Number.isFinite(at) || at <= 0) throw new HttpError(400, "Which moment? Give a time in ms.");
    return (await gitCall(() => commitAt(project.dir, at))) ?? null;
  },
  "GET /api/snapshots": (req) => snapshotViews(req.query.get("dir") ? knownProject(req.query.get("dir")).dir : undefined),
  "POST /api/snapshots/run": async (req) => {
    const project = gitProject(req.body.dir);
    return gitCall(() => runSnapshot(project, String(req.body.hash ?? ""), startedBy(req.body.by)));
  },
  "POST /api/snapshots/remove": async (req) => {
    if (typeof req.body.id !== "string" || !req.body.id) throw new HttpError(400, "Which snapshot? Give its id.");
    try {
      const s = await removeSnapshotRun(req.body.id);
      return { ok: true, message: `Removed ${s.name}. Your working copy wasn't touched.` };
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status) throw new HttpError(status, (err as Error).message);
      recordRun("snapshot", false, `${req.body.id}: ${(err as Error).message.split("\n")[0]}`, "web");
      throw err;
    }
  },

  "GET /api/git/graph": (req) => gitCall(() => gitGraph(gitProject(req.query.get("dir")).dir, { limit: clampInt(req.query.get("limit"), 1, GIT_GRAPH_MAX, 200) })),
  "GET /api/git/commit": (req) => gitCall(() => gitCommitDetail(gitProject(req.query.get("dir")).dir, String(req.query.get("hash") ?? ""))),
  "GET /api/git/status": async (req) => {
    const project = gitProject(req.query.get("dir"));
    const status = await gitCall(() => gitStatus(project.dir));
    // HEAD moved under a dev server dx runs (a commit in a terminal, a checkout): capture the new look.
    noticeHead(project, status.head?.toLowerCase());
    return status;
  },
  "GET /api/git/diff": (req) =>
    gitCall(() => gitFileDiff(gitProject(req.query.get("dir")).dir, String(req.query.get("path") ?? ""), req.query.get("staged") === "true")),
  "POST /api/git/stage": async (req) => {
    const project = gitProject(req.body.dir);
    const paths = pathsOf(req.body.paths);
    const status = await gitCall(() => gitStage(project.dir, paths));
    recordRun("git", true, `${project.name}: staged ${plural(paths.length, "file")}`, "web", { project: project.name });
    return status;
  },
  "POST /api/git/unstage": async (req) => {
    const project = gitProject(req.body.dir);
    const paths = pathsOf(req.body.paths);
    const status = await gitCall(() => gitUnstage(project.dir, paths));
    recordRun("git", true, `${project.name}: unstaged ${plural(paths.length, "file")}`, "web", { project: project.name });
    return status;
  },
  "POST /api/git/hunk": async (req) => {
    const project = gitProject(req.body.dir);
    const file = String(req.body.path ?? "");
    const staged = req.body.staged === true;
    const status = await gitCall(() => gitStageHunk(project.dir, file, String(req.body.hunk ?? ""), staged));
    recordRun("git", true, `${project.name}: ${staged ? "unstaged" : "staged"} a block of ${file}`, "web", { project: project.name });
    return status;
  },
  "POST /api/git/commit": async (req) => {
    const project = gitProject(req.body.dir);
    const amend = req.body.amend === true;
    try {
      const c = await gitCall(() => gitCommitChanges(project.dir, String(req.body.message ?? ""), { amend }));
      recordRun("git", true, `${project.name}: ${amend ? "amended" : "committed"} ${c.short} ${c.subject}`, "web", { project: project.name });
      // The visual diff, in the background: the commit is answered first, whatever the capture does.
      sawHead(project.dir, c.hash.toLowerCase());
      const visual = requestCapture(project, "commit");
      return { ...c, visual: visual.started || visual.queued ? "capturing" : undefined };
    } catch (err) {
      recordRun("git", false, `${project.name}: ${amend ? "amend" : "commit"} failed`, "web", { project: project.name });
      throw err;
    }
  },
  // Visual diffs: screenshots of a project's pages per commit, under ~/.dx/visual. An image is named
  // by a known project, a hex commit the index has and a capture name that commit has: the file's
  // path is built in core (visualImageFile), never taken from the request. Captures load only the
  // dev server dx runs for that project, on this computer.
  "GET /api/visual": (req) => {
    const project = gitProject(req.query.get("dir"));
    const commits = listVisual(project.dir).map((c) => ({ ...c, captures: c.captures.map((x) => ({ ...x, text: describeCapture(x) })) }));
    return { ...visualState(project.dir), folder: visualFolder(project.dir), commits };
  },
  "POST /api/visual/capture": (req) => {
    const project = gitProject(req.body.dir);
    const r = requestCapture(project, "manual", "web", { force: true });
    if (!r.started && !r.queued) throw new HttpError(409, r.reason ?? "Couldn't start a capture.");
    return { ...r, ...visualState(project.dir) };
  },
  "GET /api/visual/image": (req) => {
    const project = gitProject(req.query.get("dir"));
    try {
      const file = visualImageFile(project.dir, req.query.get("commit"), req.query.get("name"), req.query.get("kind") ?? "shot");
      const data = fs.readFileSync(file);
      if (data.length > 16 * 1024 * 1024) throw new HttpError(413, "That image is too large to show.");
      return { image: `data:image/png;base64,${data.toString("base64")}` };
    } catch (err) {
      if (err instanceof VisualError) throw new HttpError(err.status, err.message);
      throw err;
    }
  },
  // A commit message from Claude Code: only on the page's button, from the server's own prompt and
  // staged diff (nothing from the request but the project), and it only fills the message box.
  "GET /api/git/ai": async () => ({ claude: !!(await claudeCli()) }),
  "POST /api/git/suggest": async (req) => {
    const project = gitProject(req.body.dir);
    const r = await gitCall(() => gitSuggestMessage(project.dir));
    recordRun("git", true, `${project.name}: Claude Code wrote a commit message`, "web", { project: project.name });
    return r;
  },
  // Ask Claude to fix: only on the page's button. The error is looked up here from dx's own
  // records (never sent by the page), the prompt is built in core, the patch is kept here and
  // applied by its id, and every file is backed up in the undo journal first.
  "GET /api/fix/available": async () => ({ claude: !!(await claudeCli()) }),
  "POST /api/fix/propose": async (req) => {
    const project = knownProject(req.body.dir);
    const source = req.body.source;
    if (source !== "dev" && source !== "activity") throw new HttpError(400, "Which error? Say where it's from (dev or activity) and give its id.");
    const error = source === "dev" ? devErrorFor(project, req.body.id) : activityErrorFor(project, req.body.id);
    const what = error.message.split("\n")[0].slice(0, 100);
    try {
      const r = await gitCall(() => proposeFix(project.dir, error));
      recordRun("fix", r.ok, `${project.name}: ${r.ok ? `Claude proposed a fix to ${plural(r.files.length, "file")}` : "Claude proposed nothing to apply"} for ${what}`, "web", { project: project.name });
      if (!r.ok) return { ok: false, reason: r.reason, explanation: r.explanation, answer: r.answer };
      return { ok: true, id: rememberFix(project.dir, r), patch: r.patch, files: r.files, explanation: r.explanation, answer: r.answer };
    } catch (err) {
      recordRun("fix", false, `${project.name}: asking Claude failed for ${what}`, "web", { project: project.name });
      throw err;
    }
  },
  "POST /api/fix/apply": async (req) => {
    const project = knownProject(req.body.dir);
    const fix = storedFix(req.body.id, project.dir);
    if (!fix) throw new HttpError(404, "That proposal isn't here any more (they're kept for 30 minutes, and not after a restart). Ask again.");
    try {
      const r = await gitCall(() => applyFix(project.dir, fix));
      forgetFix(req.body.id);
      recordRun("fix", true, `${project.name}: applied Claude's fix to ${plural(r.files.length, "file")}`, "web", { project: project.name });
      return r;
    } catch (err) {
      recordRun("fix", false, `${project.name}: Claude's fix wasn't applied`, "web", { project: project.name });
      throw err;
    }
  },
  "POST /api/fix/dismiss": (req) => ({ ok: forgetFix(req.body.id) }),
  // Branches, tags, the shelf, and what can be undone.
  "GET /api/git/refs": (req) => gitCall(() => gitRefs(gitProject(req.query.get("dir")).dir)),
  "GET /api/git/undo": (req) => gitCall(() => gitUndoList(gitProject(req.query.get("dir")).dir)),
  "GET /api/git/preview": (req) => gitCall(() => gitMergePreview(gitProject(req.query.get("dir")).dir, String(req.query.get("branch") ?? ""))),
  "GET /api/git/conflict": (req) => gitCall(() => gitConflict(gitProject(req.query.get("dir")).dir, String(req.query.get("path") ?? ""))),
  "GET /api/git/rebase-plan": (req) => gitCall(() => gitRebasePlan(gitProject(req.query.get("dir")).dir, String(req.query.get("from") ?? ""))),
  /**
   * Every other git operation, by name. Each one checks its own arguments against a fresh listing
   * (gitops.ts); nothing here builds a git command from the request.
   */
  "POST /api/git/action": async (req) => {
    const project = gitProject(req.body.dir);
    const action = String(req.body.action ?? "");
    const run = GIT_ACTIONS[action];
    if (!run) throw new HttpError(400, `Unknown git action: ${action}`);
    const b = req.body;
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    try {
      const r = await gitCall(() => run(project.dir, b, str));
      recordRun("git", r.ok, `${project.name}: ${action}${r.ok ? "" : " stopped on conflicts"} — ${r.message}`, "web", { project: project.name });
      return r;
    } catch (err) {
      recordRun("git", false, `${project.name}: ${action} failed`, "web", { project: project.name });
      throw err;
    }
  },

  "GET /api/unsaved": () => findUnsavedWork(),
  "POST /api/clone": async (req) => {
    const url = String(req.body.url ?? "");
    const name = typeof req.body.name === "string" && req.body.name.trim() ? req.body.name.trim() : undefined;
    // Only a git address gets through (normalizeGitUrl), and git gets it as one argument after "--".
    try {
      return await cloneProject({ url, name, install: req.body.install !== false, source: "web" });
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  },

  "GET /api/dev": () => listDevServers(),
  "POST /api/dev/start": (req) => {
    const project = knownProject(req.body.dir, { snapshots: true });
    return startDevServer(project, startedBy(req.body.by), { snapshot: !!snapshotByDir(project.dir) });
  },
  "POST /api/dev/restart": (req) => restartDevServer(knownProject(req.body.dir, { snapshots: true }), startedBy(req.body.by)),
  "GET /api/dev/errors": (req) =>
    devErrors(req.query.get("dir") || undefined, {
      all: req.query.get("all") === "1",
      after: req.query.get("after") ? Number(req.query.get("after")) : undefined,
    }),
  "POST /api/dev/wait": (req) =>
    waitForDevServer(String(req.body.dir ?? ""), {
      after: req.body.after === undefined ? undefined : Number(req.body.after),
      until: req.body.until === "ready" ? "ready" : "quiet",
      quietMs: clampInt(req.body.quietMs, 200, 10_000, 1000),
      settleMs: clampInt(req.body.settleMs, 0, 30_000, 4000),
      timeoutMs: clampInt(req.body.timeoutMs, 1000, 120_000, 60_000),
    }),
  "POST /api/check": async (req) => {
    let url = typeof req.body.url === "string" ? req.body.url : "";
    if (!url) {
      const project = knownProject(req.body.dir, { snapshots: true });
      const dev = listDevServers().find((s) => s.dir.toLowerCase() === project.dir.toLowerCase());
      // A browser check goes through the local domain when there is one, so its requests are logged.
      const base = (req.body.browser === true || Array.isArray(req.body.steps) ? dev?.localUrl : undefined) ?? dev?.url ?? project.url;
      if (!base) throw new HttpError(400, `${project.name} has no URL yet. Start its dev server first.`);
      url = new URL(String(req.body.path ?? "/"), base).href;
    }
    try {
      return await checkUrl({
        url,
        method: typeof req.body.method === "string" ? req.body.method : undefined,
        headers: req.body.headers && typeof req.body.headers === "object" ? (req.body.headers as Record<string, string>) : undefined,
        body: typeof req.body.body === "string" ? req.body.body : req.body.body === undefined ? undefined : JSON.stringify(req.body.body),
        timeoutMs: clampInt(req.body.timeoutMs, 500, 120_000, req.body.browser === true ? 30_000 : 15_000),
        browser: req.body.browser === true || Array.isArray(req.body.steps),
        steps: stepsOf(req.body.steps),
        screenshot: req.body.screenshot === true,
      });
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  },
  "POST /api/open-file": async (req) => {
    const project = knownProject(req.body.dir, { snapshots: true });
    const raw = String(req.body.file ?? "");
    const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
    // The project's folder, and for a stack the folders its services run in (another repository, say).
    const roots = [project.dir, ...(detectStack(project)?.services.map((s) => s.dir) ?? [])];
    const inside = (p: string) => roots.some((r) => norm(p).startsWith(norm(r) + path.sep));
    // Dev servers print paths absolute, relative to their folder, or from its root ("/src/App.tsx").
    const candidates = roots.flatMap((r) => [path.resolve(r, raw), path.resolve(r, raw.replace(/^[\\/]+/, ""))]);
    const file = candidates.find((p) => inside(p) && fs.existsSync(p));
    if (!file) {
      if (!candidates.some(inside)) throw new HttpError(400, "Only files inside the project can be opened.");
      throw new HttpError(404, `${raw} doesn't exist in ${project.name}.`);
    }
    const line = req.body.line ? clampInt(req.body.line, 1, 10_000_000, 1) : undefined;
    const column = req.body.column ? clampInt(req.body.column, 1, 100_000, 1) : undefined;
    await openFileInEditor(file, line, column, project.editor ?? loadConfig().editor);
    return { message: `Opened ${path.basename(file)}${line ? `:${line}` : ""}` };
  },
  "POST /api/dev/stop": async (req) => (await stopDevServer(String(req.body.dir))) ?? null,
  // Take over: a server the AI agent started becomes the user's. Only its label changes.
  "POST /api/dev/takeover": (req) => {
    const project = knownProject(req.body.dir, { snapshots: true });
    const taken = takeOverDevServer(project.dir);
    if (!taken) throw new HttpError(409, `${project.name} isn't running as the AI agent's server.`);
    recordRun("ai.takeover", true, `${project.name}: taken over from the AI agent`, "web", { project: project.name });
    return taken;
  },

  // ------------------------------------------------------------ the AI lane
  "GET /api/ai": (req) => {
    const limit = clampInt(req.query.get("limit"), 1, 500, 40);
    const raw = req.query.get("dir");
    if (!raw) return aiLane({ limit });
    // One project's calls, for the Activity page's "By AI" filter.
    const project = knownProject(raw, { snapshots: true });
    const norm = (d: string) => (process.platform === "win32" ? d.toLowerCase() : d);
    const lane = aiLane({ limit: 500 });
    return { ...lane, calls: lane.calls.filter((c) => c.dir && norm(c.dir) === norm(project.dir)).slice(0, limit), servers: lane.servers.filter((s) => norm(s.dir) === norm(project.dir)) };
  },
  // Interrupt: stops only dev servers dx runs that the AI agent started (of those named, when dirs is sent).
  "POST /api/ai/interrupt": (req) => {
    const raw = req.body.dirs;
    if (raw !== undefined && (!Array.isArray(raw) || !raw.every((d) => typeof d === "string"))) throw new HttpError(400, "dirs is a list of project folders.");
    return interruptAi(raw as string[] | undefined);
  },
  "POST /api/dev/clear": (req) => {
    clearDevServer(String(req.body.dir));
    return { ok: true };
  },
  "GET /api/dev/logs": (req) => devLogs(String(req.query.get("dir") ?? ""), Number(req.query.get("after") ?? 0)),

  // ------------------------------------------------------------ ports
  // The Machine page: the tools on this computer, what each project needs, and what runs in the background.
  "GET /api/machine/tools": (req) => checkTools({ refresh: req.query.get("refresh") === "1" }),
  "GET /api/machine/projects": async () => projectNeeds(),
  "GET /api/machine/processes": () => listDevProcesses({ projects: scanProjects(loadConfig()), ownerPids: dxOwnedPids() }),
  "POST /api/machine/stop": async (req) => {
    const pid = Number(req.body.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new HttpError(400, "Which process? Give its PID.");
    // Found again in a fresh list: only a developer process dx lists, never dx or a server dx runs.
    const r = await stopDevProcess(pid, { projects: scanProjects(loadConfig()), ownerPids: dxOwnedPids() });
    recordRun("machine", r.ok, `stop ${r.label ?? "process"} (PID ${pid}): ${r.message}`, "web");
    if (!r.ok) throw new HttpError(400, r.message);
    return r;
  },
  "GET /api/machine/docker": () => dockerInfo(),
  "POST /api/machine/docker/stop": async (req) => {
    const id = String(req.body.id ?? "");
    if (!/^[0-9a-f]{12,64}$/.test(id)) throw new HttpError(400, "Which container? Give its id.");
    const r = await dockerStop(id);
    recordRun("machine", r.ok, `docker: ${r.message}`, "web");
    if (!r.ok) throw new HttpError(400, r.message);
    return r;
  },
  "POST /api/machine/docker/prune": async (req) => {
    const what = String(req.body.what ?? "");
    if (!["containers", "images", "build-cache"].includes(what)) throw new HttpError(400, "Pick stopped containers, unused images or the build cache.");
    const r = await dockerPrune(what as DockerPrune);
    recordRun("machine", r.ok, `docker ${what}: ${r.message}`, "web");
    if (!r.ok) throw new HttpError(500, r.message);
    return r;
  },
  "GET /api/machine/services": () => listServices(),
  "POST /api/machine/run": async (req) => {
    // Opens the fix in a terminal the user can see. The command is worked out here again, from
    // the tool (and project) named: never taken from the request.
    const tool = String(req.body.tool ?? "") as ToolId;
    if (!TOOL_IDS.includes(tool)) throw new HttpError(400, "Which tool?");
    let command: string | undefined;
    let dir: string;
    let title: string;
    if (req.body.dir !== undefined) {
      const project = knownProject(req.body.dir);
      const need = (await projectNeeds([project]))[0]?.needs.find((n) => n.tool === tool && !n.ok);
      if (!need) throw new HttpError(400, `${project.name} already has what it needs from ${tool}. Check again.`);
      command = need.runnable ? need.fix : undefined;
      dir = project.dir;
      title = project.name;
    } else {
      const t = (await checkTools()).find((x) => x.id === tool);
      if (!t || t.status === "ok") throw new HttpError(400, `${t?.name ?? tool} is up to date. Check again.`);
      command = t.runnable ? t.fix : undefined;
      dir = os.homedir();
      title = `Update ${t.name}`;
    }
    if (!command) throw new HttpError(400, "There's no command for this one: follow the advice on the page.");
    const used = await openTerminal(dir, command, title);
    recordRun("machine", true, `${title}: ${command} in ${used}`, "web");
    return { ok: true, command, terminal: used };
  },
  "GET /api/ports": async (req) => {
    const all = req.query.get("all") === "1";
    const entries = await listListeningPorts();
    return all ? entries : entries.filter((e) => e.port >= 1024 && !e.system);
  },
  "POST /api/ports/kill": async (req) => {
    const port = Number(req.body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, "Not a valid port.");
    const { entries, results } = await killPort(port);
    if (entries.length === 0) return { ok: true, message: `Nothing was listening on port ${port}.` };
    const ok = results.every((r) => r.ok);
    recordRun("port.kill", ok, `port ${port}: ${results.map((r) => r.message).join("; ")}`, "web");
    if (!ok) throw new HttpError(500, results.map((r) => r.message).join(" "));
    return { ok, message: results.map((r) => r.message).join(" ") };
  },

  // ------------------------------------------------------------ journal
  "GET /api/journal": (req) => readJournal({ sinceDays: clampInt(req.query.get("days"), 1, 3660, 7) }),
  "POST /api/journal": (req) => {
    const text = String(req.body.text ?? "");
    if (!text.trim()) throw new HttpError(400, "Nothing to log: the entry is empty.");
    const entry = addJournalEntry(text);
    recordRun("log", true, undefined, "web");
    return entry;
  },

  // ------------------------------------------------------------ summary
  "GET /api/summary": async (req) => {
    const summary = await buildSummary({
      days: clampInt(req.query.get("days"), 1, 366, 7),
      allAuthors: req.query.get("allAuthors") === "1",
      github: req.query.get("github") !== "0",
    });
    return { summary, markdown: formatSummary(summary) };
  },
  "GET /api/summary/year": async (req) => {
    const year = clampInt(req.query.get("year"), 1990, new Date().getFullYear(), new Date().getFullYear());
    const review = await buildYearReview(year, { allAuthors: req.query.get("allAuthors") === "1", github: req.query.get("github") !== "0" });
    const markdown = formatYearReview(review);
    if (req.query.get("save") === "1") saveYearReview(markdown, year);
    return { year, commits: review.commits, activeDays: review.activeDays, projects: review.projects.length, markdown };
  },
  // Your year as a story: built on this computer from git, the journal, runs.jsonl and sessions.json.
  "GET /api/summary/story": async (req) => {
    const year = clampInt(req.query.get("year"), 1990, new Date().getFullYear(), new Date().getFullYear());
    return storyView(await yearStory(year, req.query.get("allAuthors") === "1", req.query.get("github") !== "0"));
  },
  "POST /api/summary/story/save": async (req) => {
    const year = clampInt(req.body.year, 1990, new Date().getFullYear(), new Date().getFullYear());
    const built = await yearStory(year, req.body.allAuthors === true, req.body.github !== false);
    const file = saveYearReview(formatYearReview(built.review, built.story), year);
    recordRun("summary", true, `${year} in review saved from the dashboard`, "web");
    return { file, year };
  },
  "POST /api/summary/save": async (req) => {
    const summary = await buildSummary({
      days: clampInt(req.body.days, 1, 366, 7),
      allAuthors: req.body.allAuthors === true,
      github: req.body.github !== false,
    });
    const file = saveSummary(formatSummary(summary), summary);
    recordRun("summary", true, `saved from the dashboard: ${file}`, "web");
    return { file };
  },

  // ------------------------------------------------------------ cleanup
  "GET /api/cleanup": (req) => findCleanup({ days: clampInt(req.query.get("days"), 0, 3650, 30) }),
  "POST /api/cleanup/delete": async (req) => {
    // Never trust paths from the page: scan again and delete only what the scan still offers.
    const wanted = new Set((Array.isArray(req.body.dirs) ? req.body.dirs : []).map((d) => String(d).toLowerCase()));
    const scan = await findCleanup({ days: clampInt(req.body.days, 0, 3650, 30) });
    const items = scan.items.filter((i) => wanted.has(i.dir.toLowerCase()));
    if (items.length === 0) throw new HttpError(400, "Nothing to delete: those folders aren't in the cleanup list any more.");
    const results = await deleteCleanup(items);
    const freed = results.reduce((n, r) => n + r.bytes, 0);
    const failed = results.filter((r) => !r.ok);
    recordRun("clean", failed.length === 0, `${freed} bytes freed from the dashboard, ${failed.length} failed`, "web");
    return { freed, deleted: results.length - failed.length, failed };
  },

  // ------------------------------------------------------------ dependencies
  "GET /api/deps": () => depsJob,
  "POST /api/deps/run": (req) => {
    if (depsJob.running) return depsJob;
    const activeDays = req.body.activeDays === undefined || req.body.activeDays === "" ? undefined : clampInt(req.body.activeDays, 1, 3650, 30);
    depsJob = { running: true, done: 0, total: 0, current: "", startedAt: new Date().toISOString(), activeDays };
    auditDependencies({
      activeDays,
      onProgress: (done, total, current) => Object.assign(depsJob, { done, total, current }),
    }).then(
      (reports) => {
        depsJob = { ...depsJob, running: false, reports, finishedAt: new Date().toISOString(), current: "" };
        const vulnerable = reports.filter((r) => (r.vulnerabilities?.total ?? 0) > 0).length;
        recordRun("deps", true, `${reports.length} checked, ${vulnerable} vulnerable (dashboard)`, "web");
      },
      (err: Error) => {
        depsJob = { ...depsJob, running: false, error: err.message, finishedAt: new Date().toISOString() };
        recordRun("deps", false, err.message, "web");
      },
    );
    return depsJob;
  },
  "POST /api/deps/fix": async (req) => {
    const project = knownProject(req.body.dir);
    const r = await fixDependencies(project);
    recordRun("deps", r.ok, `${project.name} fixed (dashboard)`, "web", { project: project.name });
    // Swap the fresh report into the last run, so the page shows the new numbers.
    if (r.after && depsJob.reports) depsJob.reports = depsJob.reports.map((x) => (x.dir === project.dir ? r.after! : x));
    return r;
  },

  // ------------------------------------------------------------ new project
  "GET /api/templates": () => ({
    templates: listTemplates(loadConfig()).map((t) => t.name),
    projects: scanProjects(loadConfig()).map((p) => ({ name: p.name, dir: p.dir })),
    roots: loadConfig().projectsRoots,
  }),
  "POST /api/new": async (req) => {
    const config = loadConfig();
    const name = String(req.body.name ?? "").trim();
    if (!isValidProjectName(name)) throw new HttpError(400, "Use lowercase letters, digits, - _ or . for the name, e.g. my-app.");
    const source = sourceFrom(req.body.source);
    const parent = req.body.in ? path.resolve(expandHome(String(req.body.in))) : config.projectsRoots[0];
    if (!parent) throw new HttpError(400, "No projects folder is set. Add one on the Health page.");
    const dest = path.join(parent, name);
    if (fs.existsSync(dest)) throw new HttpError(400, `${dest} already exists. Pick another name.`);

    const steps: string[] = [];
    const result = copyProject(source, dest, name);
    steps.push(`Copied ${result.files} files from ${source.kind} ${source.name}`);
    if (req.body.git !== false) {
      steps.push((await run("git", ["init", "-q"], dest)) ? "Created a git repository" : "Couldn't create a git repository");
    }
    const project = readProject(dest);
    if (req.body.install !== false && project?.kind === "node") {
      const pm = project.packageManager ?? "npm";
      const code = await shell(`${pm} install`, dest);
      steps.push(code === 0 ? `Installed packages with ${pm}` : `${pm} install exited with ${code}; run it again in the project`);
    }
    if (req.body.open !== false) {
      await openInEditor(dest, project?.editor ?? config.editor).then(
        () => steps.push(`Opened in ${config.editor}`),
        (err: Error) => steps.push(`Couldn't open the editor: ${err.message}`),
      );
    }
    recordRun("new", true, `${name} from ${source.kind} ${source.name} (dashboard)`, "web", { project: name });
    return { dir: dest, name, steps };
  },
  "POST /api/templates/save": (req) => {
    const project = knownProject(req.body.dir);
    const name = String(req.body.name ?? "").trim();
    if (!isValidProjectName(name)) throw new HttpError(400, "Use lowercase letters, digits, - _ or . for the template name.");
    const result = saveAsTemplate({ kind: "project", name: project.name, dir: project.dir }, name);
    recordRun("new.template", true, `${project.name} → ${name} (dashboard)`, "web");
    return { name, files: result.files, dir: result.dir };
  },

  // ------------------------------------------------------------ AI tools
  "GET /api/ai-tools": () => listAiTools(),
  "POST /api/ai-tools/connect": (req) => connectAiTools(aiIds(req.body.ids)),
  "POST /api/ai-tools/disconnect": (req) => disconnectAiTools(aiIds(req.body.ids)),

  // ------------------------------------------------------------ health and settings
  "GET /api/health": async () => ({
    checks: await runDoctor(),
    runs: readRuns(50).reverse(),
    config: loadConfig(),
  }),
  "POST /api/config": (req) => {
    const config = loadConfig();
    if (typeof req.body.editor === "string") {
      const editor = req.body.editor.trim();
      if (!editor) throw new HttpError(400, "The editor command can't be empty, e.g. code or cursor.");
      config.editor = editor;
    }
    if (typeof req.body.githubUser === "string") {
      const user = req.body.githubUser.trim().replace(/^@/, "");
      if (user && !/^[A-Za-z0-9-]{1,39}$/.test(user)) throw new HttpError(400, "That isn't a valid GitHub username.");
      config.githubUser = user || undefined;
    }
    if (typeof req.body.addRoot === "string" && req.body.addRoot.trim()) {
      const abs = path.resolve(expandHome(req.body.addRoot.trim()));
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new HttpError(400, `Folder not found: ${abs}`);
      if (!config.projectsRoots.some((r) => r.toLowerCase() === abs.toLowerCase())) config.projectsRoots.push(abs);
    }
    if (typeof req.body.removeRoot === "string") {
      config.projectsRoots = config.projectsRoots.filter((r) => r !== req.body.removeRoot);
    }
    if (req.body.scanDepth !== undefined) config.scanDepth = clampInt(req.body.scanDepth, 1, 5, config.scanDepth);
    if (typeof req.body.terminal === "string") {
      if (req.body.terminal && !terminalIds().includes(req.body.terminal)) throw new HttpError(400, `Unknown terminal: ${req.body.terminal}.`);
      config.terminal = req.body.terminal || undefined;
    }
    if (typeof req.body.activity === "boolean") config.activity = req.body.activity;
    if (typeof req.body.localhostRecording === "boolean") config.localhostRecording = req.body.localhostRecording;
    if (typeof req.body.visualDiff === "boolean") config.visualDiff = req.body.visualDiff;
    if (req.body.activityDays !== undefined) config.activityDays = clampInt(req.body.activityDays, 1, 365, config.activityDays ?? 7);
    if (req.body.activityMaxMB !== undefined) config.activityMaxMB = clampInt(req.body.activityMaxMB, 50, 100_000, config.activityMaxMB ?? 500);
    saveConfig(config);
    forgetActivitySettings();
    return config;
  },
};

interface DepsJob {
  running: boolean;
  done: number;
  total: number;
  current: string;
  startedAt?: string;
  finishedAt?: string;
  activeDays?: number;
  reports?: DepsReport[];
  error?: string;
}
let depsJob: DepsJob = { running: false, done: 0, total: 0, current: "" };

export async function handleApi(req: ApiRequest): Promise<unknown> {
  const handler = routes[`${req.method} ${req.path}`] ?? labRoutes[`${req.method} ${req.path}`] ?? chaosRoutes[`${req.method} ${req.path}`] ?? dataRoutes[`${req.method} ${req.path}`] ?? phoneRoutes[`${req.method} ${req.path}`] ?? teamRoutes[`${req.method} ${req.path}`];
  if (!handler) throw new HttpError(404, `No such API: ${req.method} ${req.path}`);
  return handler(req);
}

/**
 * The project at `dir`, only if it's one dx found: the page can't point actions at any other
 * folder. With `snapshots`, also a snapshot registered in ~/.dx/snapshots.json (only folders under
 * ~/.dx/snapshots, and only while registered), for running it, reading its output and history,
 * and opening it; nothing that changes files or git takes one.
 */
export function knownProject(dir: unknown, { snapshots = false } = {}): Project {
  const wanted = String(dir ?? "").toLowerCase();
  const project = scanProjects(loadConfig()).find((p) => p.dir.toLowerCase() === wanted);
  if (project) return project;
  const snap = snapshots && typeof dir === "string" ? snapshotByDir(dir) : undefined;
  const asProject = snap && snapshotProject(snap);
  if (asProject) return asProject;
  throw new HttpError(404, "That project isn't in your projects folders any more. Refresh the list.");
}

/** Each project's needs next to the installed tools; the Node lines come from the release list when it's at hand. */
async function projectNeeds(projects: Project[] = scanProjects(loadConfig())) {
  const [installed, latest] = await Promise.all([installedTools(), latestVersions().catch(() => undefined)]);
  return checkProjectNeeds(projects, installed, { nodeLines: supportedNodeLines(latest) });
}

/** The dashboard and the dev servers it runs: the Machine page doesn't offer to stop those. */
function dxOwnedPids(): number[] {
  const pids = [process.pid];
  for (const s of listDevServers()) {
    for (const x of [s, ...(s.services ?? [])]) if (x.pid) pids.push(x.pid);
  }
  return pids;
}

type GitActionFn = (dir: string, body: Record<string, unknown>, str: (v: unknown) => string) => Promise<GitActionResult>;
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const resolutionsOf = (v: unknown[]): ConflictResolution[] =>
  v.slice(0, 1000).flatMap((x): ConflictResolution[] =>
    typeof x === "string" ? [x as ConflictChoice] : x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string" ? [{ text: (x as { text: string }).text }] : [],
  );
const MERGE_MODES: MergeMode[] = ["merge", "squash", "fast-forward"];

/** The git operations the page can ask for, each with its arguments taken one by one. */
const GIT_ACTIONS: Record<string, GitActionFn> = {
  undo: (d, b, s) => gitUndo(d, s(b.id)),
  "reset-to": (d, b, s) => gitResetTo(d, s(b.hash)),
  revert: (d, b, s) => gitRevert(d, s(b.hash)),
  "cherry-pick": (d, b, s) => gitCherryPick(d, s(b.hash)),
  "branch-create": (d, b, s) => gitCreateBranch(d, s(b.name), { at: s(b.at) || undefined, switchTo: b.switchTo === true }),
  switch: (d, b, s) => gitSwitch(d, s(b.name), { shelve: b.shelve === true }),
  "branch-rename": (d, b, s) => gitRenameBranch(d, s(b.name), s(b.to)),
  "branch-delete": (d, b, s) => gitDeleteBranch(d, s(b.name)),
  "tag-create": (d, b, s) => gitCreateTag(d, s(b.name), { at: s(b.at) || undefined, message: s(b.message) }),
  "tag-delete": (d, b, s) => gitDeleteTag(d, s(b.name)),
  merge: (d, b, s) => gitMerge(d, s(b.branch), MERGE_MODES.includes(s(b.mode) as MergeMode) ? (s(b.mode) as MergeMode) : "merge"),
  rebase: (d, b, s) => gitRebase(d, s(b.onto)),
  continue: (d) => gitContinue(d),
  abort: (d) => gitAbort(d),
  // Each choice is a side's name or { text } from the merge editor; anything else is dropped, so the count check refuses it.
  resolve: (d, b, s) =>
    gitResolve(d, s(b.path), { hash: s(b.hash), choices: Array.isArray(b.choices) ? resolutionsOf(b.choices) : undefined, side: b.side === "ours" || b.side === "theirs" ? b.side : undefined }),
  "stash-push": (d, b, s) => gitStashPush(d, { paths: Array.isArray(b.paths) ? strings(b.paths) : undefined, message: s(b.message) }),
  "stash-apply": (d, b, s) => gitStashApply(d, s(b.oid), { pop: b.pop === true }),
  "stash-drop": (d, b, s) => gitStashDrop(d, s(b.oid)),
  discard: (d, b) => gitDiscard(d, strings(b.paths)),
  fetch: (d) => gitFetch(d),
  pull: (d) => gitPull(d),
  push: (d, b) => gitPush(d, { force: b.force === true }),
  "push-tags": (d, b, s) => gitPushTags(d, { name: s(b.name) || undefined, all: b.all === true }),
  "rebase-run": (d, b, s) =>
    gitRebaseRun(
      d,
      s(b.from),
      Array.isArray(b.steps)
        ? b.steps.slice(0, 200).map((x: unknown) => {
            const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
            return { hash: s(o.hash), action: s(o.action) as RebaseAction, message: s(o.message) };
          })
        : [],
    ),
};

/** An error of the project's dev server (running, or the last run), by the id the error tracker gave it. */
function devErrorFor(project: Project, id: unknown): FixTarget {
  const e = typeof id === "string" ? devErrors(project.dir, { all: true })[0]?.errors.find((x) => x.id === id) : undefined;
  if (!e) throw new HttpError(404, "That error isn't in the dev server's output any more. Refresh the page.");
  return { kind: e.kind, message: e.message, file: e.file, line: e.line, column: e.column, stack: e.lines.join("\n") };
}

/** An error in the project's activity history, by its event id: exceptions, server errors and console errors only. */
function activityErrorFor(project: Project, id: unknown): FixTarget {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, "Which error? Give its id.");
  flushActivity();
  const e = reportContext(project.dir, n).target;
  if (!e) throw new HttpError(404, "That error isn't in the history any more.");
  if (!(e.type === "error" || e.type === "server-error" || (e.type === "console" && e.level === "error"))) throw new HttpError(400, "Only errors can be sent to Claude: an exception, a server error or a console error.");
  const at = e.source ? splitLocation(e.source) : undefined;
  return { kind: e.type === "error" ? "browser" : e.type, message: e.text, file: at?.file, line: at?.line, column: at?.column, stack: e.stack, page: e.page };
}

/**
 * The folder of history asked for: a known project, or a recorded site that isn't linked to one
 * (site:<host>, by its host). Undefined when neither is given: every project.
 */
function activityDirOf(dir: unknown, site: unknown): string | undefined {
  if (site !== undefined && site !== null && site !== "") {
    try {
      return siteDir(normalizeSiteHost(String(site)));
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }
  if (dir === undefined || dir === null || dir === "") return undefined;
  return knownProject(dir, { snapshots: true }).dir;
}

/** The recorded sites, with the name of the project each belongs to. */
function siteViews() {
  const config = loadConfig();
  const projects = scanProjects(config);
  return listSites(config).map((s) => {
    const p = s.project ? projects.find((x) => x.dir.toLowerCase() === s.project!.toLowerCase()) : undefined;
    return { ...s, projectName: p?.name ?? (s.project ? path.basename(s.project) : undefined), hasGit: p?.hasGit ?? false, missing: !!s.project && !p };
  });
}

function gitProject(dir: unknown): Project {
  const project = knownProject(dir);
  if (!project.hasGit) throw new HttpError(400, `${project.name} isn't a git repository.`);
  return project;
}

/** A bundle that can't be read, or an event that isn't there, reaches the page with its own status. */
async function bundleCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BugBundleError || err instanceof GitError) throw new HttpError(err.status, err.message);
    throw err;
  }
}

/** The last year story built, for a minute, so Save right after viewing doesn't read git again. */
let lastStory: { key: string; at: number; built: Promise<{ review: YearReview; story: YearStory }> } | undefined;
function yearStory(year: number, allAuthors: boolean, github: boolean): Promise<{ review: YearReview; story: YearStory }> {
  const key = `${year}|${allAuthors}|${github}`;
  if (lastStory && lastStory.key === key && Date.now() - lastStory.at < 60_000) return lastStory.built;
  const built = buildYearStory(year, { allAuthors, github });
  lastStory = { key, at: Date.now(), built };
  built.catch(() => {
    if (lastStory?.built === built) lastStory = undefined;
  });
  return built;
}

/** What the page draws: the story and the review's own numbers, not every commit of the year. */
function storyView({ review, story }: { review: YearReview; story: YearStory }) {
  const gh = review.summary.github;
  return {
    year: review.year,
    story,
    projects: review.projects.slice(0, 12),
    months: review.months,
    busiestDay: review.busiestDay,
    github: gh && "user" in gh ? { merged: gh.merged.length, reviewed: gh.reviewed.length } : gh && "error" in gh ? { error: gh.error } : undefined,
    markdown: formatYearReview(review, story),
  };
}

function mockCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof MockError) throw new HttpError(err.status, err.message);
    throw err;
  }
}

/** The API calls during one visit: the proxy's requests carry no visit id, so the visit's own time span picks them. */
function visitRequests(dir: string, visit: string) {
  const started = parseInt(visit.slice(8), 36);
  const since = Number.isFinite(started) && started > 1e12 ? new Date(started - 60_000) : new Date(Date.now() - 7 * 86_400_000);
  const all = readActivity({ dir, since, limit: 5000 });
  const own = all.filter((e) => e.visit === visit);
  if (!own.length) throw new HttpError(404, "That visit isn't in the history any more.");
  const from = Math.min(...own.map((e) => Date.parse(e.at))) - 2000;
  const to = Math.max(...own.map((e) => Date.parse(e.at))) + 5000;
  return all.filter((e) => e.type === "request" && Date.parse(e.at) >= from && Date.parse(e.at) <= to);
}

function sinceRequests(dir: string, raw: unknown) {
  const since = parseSince(typeof raw === "string" && raw ? raw : "1h");
  if (!since) throw new HttpError(400, "since takes 30m, 2h, 3d, today, yesterday or a date.");
  return readActivity({ dir, since, types: ["request"], limit: 5000 });
}

/** git's own refusals ("nothing staged", a hook that failed) reach the page as they are. */
async function gitCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GitError) throw new HttpError(err.status, err.message);
    throw err;
  }
}

function pathsOf(raw: unknown): string[] {
  if (!Array.isArray(raw) || !raw.every((p) => typeof p === "string")) throw new HttpError(400, "Which files? Send their paths.");
  return raw;
}

function plural(n: number, one: string): string {
  return `${n} ${n === 1 ? one : `${one}s`}`;
}

function startedBy(raw: unknown): StartedBy {
  return raw === "ai" || raw === "terminal" ? raw : "dashboard";
}

const AI_IDS: AiToolId[] = ["claude-code", "claude-desktop", "cursor", "windsurf", "vscode"];
function aiIds(raw: unknown): AiToolId[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map(String).filter((id): id is AiToolId => (AI_IDS as string[]).includes(id));
}

function sourceFrom(raw: unknown): Source {
  const value = String(raw ?? "");
  const [kind, ...rest] = value.split(":");
  const ref = rest.join(":");
  if (kind === "template") {
    const t = listTemplates(loadConfig()).find((x) => x.name === ref);
    if (!t) throw new HttpError(400, `No template called "${ref}".`);
    return { kind: "template", name: t.name, dir: t.dir };
  }
  if (kind === "project") {
    const p = knownProject(ref);
    return { kind: "project", name: p.name, dir: p.dir };
  }
  throw new HttpError(400, "Pick a template or a project to start from.");
}

/** The steps to do one visit again, from the history; only addresses on this computer. */
export function replayOf(dir: string, visit: string): Replay {
  flushActivity();
  // A visit id ends with the time it started, in base 36.
  const started = parseInt(visit.slice(8), 36);
  const since = Number.isFinite(started) && started > 1e12 ? new Date(started - 60_000) : new Date(Date.now() - 7 * 86_400_000);
  const events = readActivity({ dir, since, limit: 5000 }).filter((e) => e.visit === visit);
  const replay = replayFromVisit(events);
  if (!replay) throw new HttpError(404, "That visit isn't in the history any more.");
  if (!isLoopbackUrl(replay.url)) throw new HttpError(400, "Only pages on this computer can be replayed.");
  return replay;
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  // A missing query value is null, and Number(null) is 0: that's "not given", not zero.
  if (raw === null || raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function run(command: string, args: string[], cwd: string): Promise<boolean> {
  return new Promise((resolve) => execFile(command, args, { cwd, windowsHide: true }, (err) => resolve(!err)));
}

function shell(command: string, cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: "ignore" });
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

/** Browser steps from a request: plain objects with the known fields only, at most 50. */
function stepsOf(raw: unknown): PageStep[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return raw.slice(0, 50).map((x) => {
    const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    return {
      goto: str(o.goto),
      click: str(o.click),
      double: o.double === true || undefined,
      back: o.back === true || undefined,
      type: str(o.type),
      into: str(o.into),
      press: str(o.press),
      waitFor: str(o.waitFor ?? o.wait_for),
      screenshot: o.screenshot === true,
      timeoutMs: typeof o.timeoutMs === "number" ? Math.min(60_000, Math.max(500, o.timeoutMs)) : undefined,
    };
  });
}
