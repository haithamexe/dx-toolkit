import fs from "node:fs";
import path from "node:path";
import {
  addGitignoreRules,
  applyClaudeSetup,
  autonomyState,
  capability,
  commitMessageParts,
  findKnownProject,
  fixPromptParts,
  gitRoot,
  isLevel,
  listProposals,
  propose,
  readAiUses,
  recordChange,
  setLevel,
  takeProposal,
  type Proposal,
} from "@dx/core";
import { fixTargetFor, HttpError, knownProject, type ApiRequest } from "./api.js";
import { fetchProject } from "./gitfetch.js";
import { saveWeeklySummary } from "./autosetup.js";

/**
 * How much dx does on its own (core/autonomy.ts), what it is waiting to be told, what was sent to an
 * AI, and what will be sent before it is. Nothing here runs Claude: "what dx will send" is the
 * prompt's parts counted, never the text. A proposal is run only by its id, from what dx wrote when
 * it raised it, with the project and the values checked again.
 */

const view = (p: Proposal) => ({ id: p.id, capability: p.capability, level: p.level, at: p.at, project: p.project, what: p.what, why: p.why });
export const proposalViews = () => listProposals().map(view);

const projectOf = (dir: unknown) => {
  const project = typeof dir === "string" ? findKnownProject(dir) : undefined;
  if (!project) throw new HttpError(404, "That project isn't in your projects folders any more.");
  return project;
};

/** Does what a proposal says, as dx would have done on its own, and says so in the changes list. */
async function run(p: Proposal): Promise<string> {
  const data = p.action.data;
  switch (p.action.kind) {
    case "gitignore-rules": {
      const project = projectOf(data.dir);
      const patterns = Array.isArray(data.patterns) ? data.patterns.filter((x): x is string => typeof x === "string") : [];
      const created = !fs.existsSync(path.join(project.dir, ".gitignore"));
      const added = addGitignoreRules(project.dir, patterns);
      if (!added.length) return "The .gitignore already has them.";
      recordChange({
        by: "dx",
        kind: "gitignore",
        project: project.name,
        dir: project.dir,
        what: `Added ${added.length} ${added.length === 1 ? "rule" : "rules"} to ${project.name}'s .gitignore`,
        why: "You said yes when dx asked",
        undo: { kind: "gitignore-rules", data: { dir: project.dir, lines: added, created } },
      });
      return `Added ${added.length} ${added.length === 1 ? "rule" : "rules"} to .gitignore.`;
    }
    case "claude-setup": {
      const project = projectOf(data.dir);
      if (!applyClaudeSetup({ name: project.name, dir: project.dir }, "web").length) return "It was already set up.";
      recordChange({
        by: "dx",
        kind: "claude-setup",
        project: project.name,
        dir: project.dir,
        what: `Pointed ${project.name}'s Claude Code sessions at dx`,
        why: "You said yes when dx asked",
        undo: { kind: "claude-setup", data: { dir: project.dir } },
      });
      return "Its Claude Code sessions now run and test through dx.";
    }
    case "git-fetch": {
      const dirs = Array.isArray(data.dirs) ? data.dirs.filter((x): x is string => typeof x === "string") : [];
      let fetched = 0;
      for (const dir of dirs.slice(0, 50)) {
        const project = findKnownProject(dir);
        if (project && (await fetchProject(project.dir, project.name).catch(() => "failed")) !== "skipped") fetched++;
      }
      return `Fetched ${fetched} ${fetched === 1 ? "project" : "projects"}.`;
    }
    case "weekly-summary": {
      const notice = await saveWeeklySummary();
      return notice ? notice.text : "There's nothing to save right now.";
    }
  }
}

export const autonomyRoutes: Record<string, (req: ApiRequest) => unknown> = {
  "GET /api/autonomy": () => ({ capabilities: autonomyState().map(({ id, title, what, default: def, undoable, level }) => ({ id, title, what, default: def, undoable, level })) }),
  "POST /api/autonomy": (req) => {
    const id = String(req.body.id ?? "");
    const cap = capability(id);
    if (!cap) throw new HttpError(404, `dx doesn't do "${id}" on its own, so there is nothing to set.`);
    if (!isLevel(req.body.level)) throw new HttpError(400, "The level is suggest, ask or do.");
    const { previous } = setLevel(id, req.body.level);
    if (previous !== req.body.level) {
      const words = { suggest: "only suggests", ask: "asks first about", do: "does by itself" } as const;
      recordChange({ by: "you", kind: "autonomy", what: `dx ${words[req.body.level]}: ${cap.title.toLowerCase()}`, undo: { kind: "autonomy", data: { id, previous } } });
    }
    return { id, level: req.body.level, previous };
  },
  "GET /api/proposals": () => ({ proposals: proposalViews() }),
  "POST /api/proposals/resolve": async (req) => {
    const id = String(req.body.id ?? "");
    if (req.body.approve !== true) {
      if (!takeProposal(id, true)) throw new HttpError(404, "That isn't waiting any more.");
      return { ok: true, message: "Not now: dx won't raise it again for a day." };
    }
    const p = takeProposal(id);
    if (!p) throw new HttpError(404, "That isn't waiting any more.");
    try {
      return { ok: true, message: await run(p) };
    } catch (err) {
      // It didn't run: it stays, to be tried again or put off.
      propose({ capability: p.capability, level: p.level, project: p.project, dir: p.dir, what: p.what, why: p.why, action: p.action });
      throw err;
    }
  },
  "GET /api/ai/uses": (req) => ({ uses: readAiUses(Date.now() - Math.min(30, Math.max(1, Number(req.query.get("days")) || 1)) * 24 * 3_600_000) }),
  // What a button would send, counted: nothing is sent, and nothing is read that the button wouldn't read.
  "POST /api/fix/preview": async (req) => {
    const project = knownProject(req.body.dir);
    const target = fixTargetFor(project, req.body.source, req.body.id);
    await gitRoot(project.dir).catch(() => {
      throw new HttpError(400, "Ask Claude to fix works in git projects.");
    });
    const { sent } = await fixPromptParts(project.dir, target);
    return sentView(sent);
  },
  "POST /api/git/suggest/preview": async (req) => {
    const project = knownProject(req.body.dir);
    const root = await gitRoot(project.dir).catch(() => {
      throw new HttpError(400, "Write message works in git projects.");
    });
    try {
      return sentView((await commitMessageParts(root)).sent);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  },
};

function sentView(sent: { label: string; bytes: number }[]) {
  return {
    sent,
    bytes: sent.reduce((n, s) => n + s.bytes, 0),
    never: [".env files", "keys and certificates", "lock files"],
    goesTo: "Claude Code on this computer, with your own Claude account",
    only: "when you press Send",
  };
}
