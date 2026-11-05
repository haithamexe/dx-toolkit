import { dataTarget, listScenes, loadData, loadScene, makeScene, readDataSchema, RECIPES, recordRun, removeScene, saveCurrentData, saveScene, sceneSlug, type Recipe } from "@dx/core";
import { HttpError, knownProject, type ApiRequest } from "./api.js";

/**
 * The Data page: a project's schema, scenes of realistic data made for it, and loading one into
 * the development database (only one on this computer; what was there is saved first as a
 * backup scene). Every route takes a known project's dir; a scene is named by its slug, and its
 * file is found under ~/.dx/data, never from a path in the request.
 */

const busy = new Set<string>();

function schemaOf(dir: string) {
  const schema = readDataSchema(dir);
  if (!schema) throw new HttpError(404, "No database schema found: a Prisma schema, or CREATE TABLE in SQL migration files.");
  return schema;
}

function slug(v: unknown): string {
  try {
    return sceneSlug(String(v ?? ""));
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
}

async function once<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  if (busy.has(dir)) throw new HttpError(409, "The database is busy with another load or save for this project.");
  busy.add(dir);
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, (err as Error).message.split("\n")[0]);
  } finally {
    busy.delete(dir);
  }
}

export const dataRoutes: Record<string, (req: ApiRequest) => unknown> = {
  "GET /api/data": (req) => {
    const project = knownProject(req.query.get("dir"));
    const schema = readDataSchema(project.dir);
    return {
      schema: schema && {
        source: schema.source,
        file: schema.file,
        provider: schema.provider,
        tables: schema.tables.map((t) => ({ name: t.name, columns: t.columns.length, refs: t.columns.filter((c) => c.ref).map((c) => c.ref!.table) })),
      },
      target: schema ? dataTarget(project, schema) : { ok: false, why: "No database schema found: a Prisma schema, or CREATE TABLE in SQL migration files." },
      recipes: RECIPES,
      scenes: listScenes(project.dir),
    };
  },

  "GET /api/data/scene": (req) => {
    const project = knownProject(req.query.get("dir"));
    let scene;
    try {
      scene = loadScene(project.dir, slug(req.query.get("scene")));
    } catch (err) {
      throw new HttpError(404, (err as Error).message);
    }
    // A preview: the first rows of each table.
    return { name: scene.name, kind: scene.kind, recipe: scene.recipe, seed: scene.seed, order: scene.order, rows: Object.fromEntries(Object.entries(scene.rows).map(([t, r]) => [t, { count: r.length, first: r.slice(0, 20) }])) };
  },

  "POST /api/data/make": (req) => {
    const project = knownProject(req.body.dir);
    const recipe = String(req.body.recipe ?? "typical") as Recipe;
    if (!RECIPES.some((r) => r.id === recipe)) throw new HttpError(400, `recipe is one of ${RECIPES.map((r) => r.id).join(", ")}.`);
    const seed = Number.isInteger(req.body.seed) ? (req.body.seed as number) : Math.floor(Math.random() * 9000) + 1000;
    const name = req.body.name ? String(req.body.name).slice(0, 60) : `${RECIPES.find((r) => r.id === recipe)!.name} #${seed}`;
    slug(name);
    const scene = makeScene(schemaOf(project.dir), recipe, seed, name);
    saveScene(project.dir, scene);
    recordRun("data", true, `${project.name}: made "${name}"`, "web", { project: project.name });
    return { slug: sceneSlug(name), name, rows: Object.values(scene.rows).reduce((n, r) => n + r.length, 0) };
  },

  "POST /api/data/load": async (req) => {
    const project = knownProject(req.body.dir);
    const schema = schemaOf(project.dir);
    let scene;
    try {
      scene = loadScene(project.dir, slug(req.body.scene));
    } catch (err) {
      throw new HttpError(404, (err as Error).message);
    }
    return once(project.dir, () => loadData(project, schema, scene, { source: "web" }));
  },

  "POST /api/data/save": async (req) => {
    const project = knownProject(req.body.dir);
    const schema = schemaOf(project.dir);
    const name = String(req.body.name ?? "").slice(0, 60) || `Saved ${new Date().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}`;
    slug(name);
    const scene = await once(project.dir, () => saveCurrentData(project, schema, name));
    recordRun("data", true, `${project.name}: saved the data as "${name}"`, "web", { project: project.name });
    return { slug: sceneSlug(name), name, rows: Object.values(scene.rows).reduce((n, r) => n + r.length, 0) };
  },

  "POST /api/data/remove": (req) => {
    const project = knownProject(req.body.dir);
    removeScene(project.dir, slug(req.body.scene));
    return { ok: true };
  },
};
