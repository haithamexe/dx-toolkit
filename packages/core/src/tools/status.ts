import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig, type DxConfig } from "../config.js";
import { scanProjects, type Project } from "./projects.js";

const run = promisify(execFile);

/**
 * Work that exists only on this computer, across every project: changes not committed, commits
 * not pushed, branches with no remote, stashes, and repositories with no remote at all. What
 * would be lost if the laptop died tonight.
 */

export interface UnsavedWork {
  project: string;
  dir: string;
  branch?: string;
  /** Changed or staged files. */
  changed: number;
  /** New files git doesn't track yet (and doesn't ignore). */
  untracked: number;
  /** Commits on local branches that no remote has. */
  unpushed: number;
  /** Local branches with such commits. */
  unpushedBranches: string[];
  stashes: number;
  /** When the oldest stash was made. */
  oldestStash?: string;
  /** The repository has no remote, so nothing in it is backed up. */
  noRemote: boolean;
  /** Last commit time (ISO), for sorting and "how old is this". */
  lastCommit?: string;
}

export interface UnsavedOptions {
  config?: DxConfig;
  projects?: Project[];
  /** Include projects with nothing unsaved. */
  all?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export async function findUnsavedWork(options: UnsavedOptions = {}): Promise<UnsavedWork[]> {
  const projects = (options.projects ?? scanProjects(options.config ?? loadConfig())).filter((p) => p.hasGit);
  const out: UnsavedWork[] = [];
  let done = 0;
  let next = 0;
  // A few repositories at a time: git is quick, but there may be dozens.
  const worker = async () => {
    while (next < projects.length) {
      const p = projects[next++];
      const w = await inspect(p).catch(() => undefined);
      if (w && (options.all || hasUnsaved(w))) out.push(w);
      options.onProgress?.(++done, projects.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, projects.length) }, worker));
  return out.sort((a, b) => weight(b) - weight(a) || a.project.localeCompare(b.project));
}

export function hasUnsaved(w: UnsavedWork): boolean {
  return w.changed > 0 || w.untracked > 0 || w.unpushed > 0 || w.stashes > 0 || w.noRemote;
}

function norm(p: string): string {
  const t = p.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "linux" ? t : t.toLowerCase();
}

/** Most at risk first: unpushed commits and changes outweigh a stray untracked file. */
function weight(w: UnsavedWork): number {
  return w.unpushed * 5 + w.changed * 3 + w.stashes * 2 + w.untracked + (w.noRemote ? 10 : 0);
}

async function inspect(p: Project): Promise<UnsavedWork> {
  const git = async (args: string[]) => {
    try {
      return (await run("git", args, { cwd: p.dir, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout;
    } catch {
      return "";
    }
  };
  const [status, remotes, stashes, branches, last] = await Promise.all([
    git(["status", "--porcelain=v1", "--branch"]),
    git(["remote"]),
    git(["stash", "list", "--format=%cI"]),
    git(["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
    git(["log", "-1", "--format=%cI"]),
  ]);
  const lines = status.split(/\r?\n/).filter(Boolean);
  const head = lines[0]?.startsWith("## ") ? lines.shift()!.slice(3) : "";
  const branch = head.split("...")[0].replace(/^No commits yet on /, "") || undefined;
  const w: UnsavedWork = {
    project: p.name,
    dir: p.dir,
    branch,
    changed: lines.filter((l) => !l.startsWith("??")).length,
    untracked: lines.filter((l) => l.startsWith("??")).length,
    unpushed: 0,
    unpushedBranches: [],
    stashes: 0,
    noRemote: remotes.trim() === "",
    lastCommit: last.trim() || undefined,
  };
  const stashDates = stashes.split(/\r?\n/).filter(Boolean).sort();
  w.stashes = stashDates.length;
  w.oldestStash = stashDates[0];
  if (!w.noRemote) {
    // Worktrees of one repository share its branches: each reports its own branch, and the main
    // checkout also reports the branches no worktree has checked out.
    const [gitDir, commonDir, worktrees] = await Promise.all([
      git(["rev-parse", "--absolute-git-dir"]),
      git(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      git(["worktree", "list", "--porcelain"]),
    ]);
    const isWorktree = gitDir.trim() !== "" && commonDir.trim() !== "" && norm(gitDir) !== norm(commonDir);
    const elsewhere = new Set(
      worktrees
        .split(/\r?\n/)
        .filter((l) => l.startsWith("branch refs/heads/"))
        .map((l) => l.slice("branch refs/heads/".length).trim()),
    );
    const others = isWorktree ? [] : branches.split(/\r?\n/).filter((b) => b && b !== branch && !elsewhere.has(b)).slice(0, 30);
    const counted: string[] = [];
    if (branch && (Number((await git(["rev-list", "--count", "HEAD", "--not", "--remotes"])).trim()) || 0)) counted.push(branch);
    for (const b of others) {
      if (Number((await git(["rev-list", "--count", b, "--not", "--remotes"])).trim()) || 0) counted.push(b);
    }
    if (counted.length) {
      w.unpushed = Number((await git(["rev-list", "--count", ...counted.map((b) => (b === branch ? "HEAD" : b)), "--not", "--remotes"])).trim()) || 0;
      w.unpushedBranches = counted;
    }
  }
  return w;
}
