import fs from "node:fs";
import { writeFileAtomic } from "../atomic.js";
import { detectEditor, detectProjectRoots, dxPath, loadConfig, saveConfig, type DxConfig } from "../config.js";
import { recordRun } from "../runs.js";
import { applyClaudeSetup } from "./agentsetup.js";
import { commandExists } from "./doctor.js";
import { addGitignoreRules, auditEnvAsync } from "./envaudit.js";
import { scanProjects } from "./projects.js";

/**
 * What dx does by itself the first time it sees a project, so nobody has to press a button for it:
 * a project with a real .env that git would pick up gets the missing secret rules in its
 * .gitignore (only rules from GITIGNORE_RULES, appended, never rewritten). Said afterwards, in the
 * dashboard and in `dx runs`.
 *
 * Projects dx already knew when this first ran are only remembered, never touched: an update must
 * not change files in every project on the computer. A project is handled once.
 */

export interface AutoNotice {
  id: number;
  at: string;
  project: string;
  text: string;
}

interface Seen {
  version: 1;
  /** project folder (lower case) -> when it was first seen */
  dirs: Record<string, string>;
}

const seenFile = () => dxPath("autosetup.json");

function readSeen(): Seen | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(seenFile(), "utf8")) as Seen;
    return data?.version === 1 && data.dirs && typeof data.dirs === "object" ? data : undefined;
  } catch {
    return undefined;
  }
}

function writeSeen(seen: Seen): void {
  fs.mkdirSync(dxPath(), { recursive: true });
  writeFileAtomic(seenFile(), JSON.stringify(seen, null, 2), { mode: 0o600 });
}

/** The rules a project's .gitignore lacks while a real .env file would be picked up by git. */
export async function autoSetupProject(dir: string): Promise<string[]> {
  const audit = await auditEnvAsync(dir);
  if (!audit.git) return [];
  if (!audit.files.some((f) => !f.example && f.notIgnored)) return [];
  const missing = audit.rules.filter((r) => !r.covered).map((r) => r.pattern);
  if (!missing.length) return [];
  return addGitignoreRules(dir, missing);
}

let nextId = 1;

/**
 * One look at the projects: handles the ones not seen before and says what it did. The first look
 * ever (no memory yet) only remembers them all.
 */
export async function autoSetupTick(projects: { dir: string; name: string }[], now = new Date()): Promise<AutoNotice[]> {
  const existing = readSeen();
  const seen: Seen = existing ?? { version: 1, dirs: {} };
  const baseline = !existing;
  const fresh = projects.filter((p) => !(p.dir.toLowerCase() in seen.dirs));
  if (!fresh.length) return [];
  const notices: AutoNotice[] = [];
  for (const p of fresh) {
    seen.dirs[p.dir.toLowerCase()] = now.toISOString();
    if (baseline) continue;
    try {
      const added = await autoSetupProject(p.dir);
      if (added.length) {
        const text = `${p.name}: added ${added.filter((a) => !a.startsWith("!")).join(", ")} to .gitignore, so its .env files stay out of git`;
        recordRun("autosetup", true, text, "web", { project: p.name });
        notices.push({ id: nextId++, at: now.toISOString(), project: p.name, text });
      }
      // Its Claude Code sessions are pointed at dx too (local files, excluded from git; `dx claude --undo` removes them).
      try {
        if (applyClaudeSetup({ name: p.name, dir: p.dir }, "web").length) {
          notices.push({ id: nextId++, at: now.toISOString(), project: p.name, text: `${p.name}: Claude Code sessions here now run and test through dx (undo: dx claude --undo)` });
        }
      } catch {
        // a tracked or unreadable settings file: left alone, and not tried again every minute
      }
    } catch {
      // a project that can't be read now is looked at once more at the next start
      delete seen.dirs[p.dir.toLowerCase()];
    }
  }
  writeSeen(seen);
  return notices;
}

/**
 * Doctor findings dx can fix itself, without asking: an editor command that isn't on this computer
 * (another one that is gets picked), and no projects found while code folders exist that aren't in
 * the list (they're added). Everything else a check says needs a person or an installer.
 * `env` is for tests: the folder to look in for code folders, and the editor to try.
 */
export async function autoFixConfig(options: { home?: string; editor?: () => string } = {}): Promise<string[]> {
  const config: DxConfig = loadConfig();
  const did: string[] = [];
  if (!(await commandExists(config.editor))) {
    const found = (options.editor ?? detectEditor)();
    if (found && found !== config.editor && (await commandExists(found))) {
      did.push(`Editor: "${config.editor}" isn't on this computer, so dx now opens projects with ${found}`);
      config.editor = found;
    }
  }
  if (!scanProjects(config).length) {
    const add = detectProjectRoots(options.home).filter((r) => !config.projectsRoots.some((x) => x.toLowerCase() === r.toLowerCase()));
    if (add.length) {
      config.projectsRoots = [...config.projectsRoots, ...add];
      did.push(`Projects: no project was found, so dx added ${add.join(", ")} to your projects folders`);
    }
  }
  if (!did.length) return [];
  saveConfig(config);
  for (const d of did) recordRun("autofix", true, d, "web");
  return did;
}
