import { addProofToPr, currentPr, findDatabases, prProof, projectTour, projectTourAsync, queryLogState, queryReport, readActivity, recordRun, setQueryLog, tourMarkdown } from "@dx/core";
import { flushActivity } from "./activity.js";
import { HttpError, knownProject, type ApiRequest } from "./api.js";

/**
 * The newcomer tour, proof for the pull request, and queries per request. Every route takes a
 * known project's dir. The tour and the proof only read. Adding the proof to a pull request
 * rebuilds it on the server (never text from the request) and goes through the GitHub CLI the
 * user is signed in to, only on the button. Query logging runs dx's own fixed SQL in the
 * project's compose database, and statements are kept with their values replaced by ?.
 */
export const teamRoutes: Record<string, (req: ApiRequest) => unknown> = {
  "GET /api/tour": async (req) => {
    const project = knownProject(req.query.get("dir"));
    flushActivity();
    const tour = await projectTourAsync(project);
    return { tour, markdown: tourMarkdown(tour) };
  },

  "GET /api/proof": async (req) => {
    const project = knownProject(req.query.get("dir"));
    if (!project.hasGit) throw new HttpError(400, `${project.name} isn't a git project.`);
    flushActivity();
    return prProof(project);
  },

  "GET /api/proof/pr": async (req) => {
    const project = knownProject(req.query.get("dir"));
    try {
      const pr = await currentPr(project.dir);
      return { pr: pr ? { number: pr.number, url: pr.url, title: pr.title, hasProof: pr.body.includes("<!-- dx:proof:start -->") } : null };
    } catch (err) {
      return { pr: null, why: (err as Error).message };
    }
  },

  "POST /api/proof/pr": async (req) => {
    const project = knownProject(req.body.dir);
    if (!project.hasGit) throw new HttpError(400, `${project.name} isn't a git project.`);
    flushActivity();
    const proof = await prProof(project);
    try {
      const pr = await addProofToPr(project.dir, proof.markdown);
      recordRun("proof", true, `${project.name}: added to pull request #${pr.number}`, "web", { project: project.name });
      return { number: pr.number, url: pr.url };
    } catch (err) {
      recordRun("proof", false, `${project.name}: ${(err as Error).message}`, "web", { project: project.name });
      throw new HttpError(409, (err as Error).message);
    }
  },

  "GET /api/queries": async (req) => {
    const project = knownProject(req.query.get("dir"));
    const dbs = findDatabases(project).filter((d) => d.kind !== "redis");
    const state = queryLogState(project.dir);
    if (!dbs.length) return { databases: [], report: null };
    flushActivity();
    const since = state?.since;
    const events = since ? readActivity({ dir: project.dir, since: new Date(Date.parse(since) - 60_000), limit: 50_000 }) : [];
    try {
      return { databases: dbs.map((d) => ({ service: d.service, kind: d.kind })), report: await queryReport(project, events) };
    } catch (err) {
      return { databases: dbs.map((d) => ({ service: d.service, kind: d.kind })), report: { project: project.name, on: !!state, service: state?.service, kind: state?.kind, since: state?.since, queries: 0, outside: 0, requests: [], findings: [], top: [], note: (err as Error).message } };
    }
  },

  "POST /api/queries": async (req) => {
    const project = knownProject(req.body.dir);
    const service = typeof req.body.service === "string" && /^[\w.-]{1,64}$/.test(req.body.service) ? req.body.service : undefined;
    const on = req.body.on === true;
    try {
      const state = await setQueryLog(project, on, { service });
      recordRun("queries", true, `${project.name}: query log ${on ? `on (${state?.service})` : "off"}`, "web", { project: project.name });
      return { on: !!state, ...state };
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
  },
};
