import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Pull requests you merged or reviewed on GitHub, for the weekly summary. */
export interface PullRequest {
  title: string;
  /** "owner/repo" */
  repo: string;
  number: number;
  url: string;
  /** YYYY-MM-DD the PR was merged (merged list) or last updated (reviewed list). */
  date: string;
}

export interface GithubActivity {
  user: string;
  merged: PullRequest[];
  reviewed: PullRequest[];
  /** True when a token was used, so private repos are included. */
  authenticated: boolean;
}

/**
 * A token for the GitHub API, if one is available: GITHUB_TOKEN or GH_TOKEN, or the GitHub CLI's
 * login when `gh` is installed. Without one, only public repos can be searched.
 */
export async function githubToken(): Promise<string | undefined> {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env.trim();
  try {
    const { stdout } = await run("gh", ["auth", "token"], { windowsHide: true, timeout: 5000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** "https://github.com/me/repo.git" or "git@github.com:me/repo.git" → "me"; anything else → undefined. */
export function githubOwner(remoteUrl: string): string | undefined {
  const m = /github\.com[:/]([^/\s]+)\/[^/\s]+?(?:\.git)?\/?$/i.exec(remoteUrl.trim());
  return m?.[1];
}

/** The owner that appears most often among the given remote URLs. */
export function mostCommonOwner(remoteUrls: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const url of remoteUrls) {
    const owner = githubOwner(url);
    if (owner) counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** Searches GitHub for PRs `user` merged, and PRs by others that `user` reviewed, since `since` (YYYY-MM-DD). */
export async function fetchGithubActivity(user: string, since: string, token?: string): Promise<GithubActivity> {
  const [merged, reviewed] = await Promise.all([
    searchPullRequests(`is:pr author:${user} is:merged merged:>=${since}`, token, "merged"),
    searchPullRequests(`is:pr reviewed-by:${user} -author:${user} updated:>=${since}`, token, "updated"),
  ]);
  return { user, merged, reviewed, authenticated: Boolean(token) };
}

async function searchPullRequests(query: string, token: string | undefined, dateField: "merged" | "updated"): Promise<PullRequest[]> {
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=50&sort=updated`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "dx-toolkit",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    const hint = res.status === 401 ? " (the GitHub token was rejected)" : res.status === 403 ? " (rate limited; set GITHUB_TOKEN)" : "";
    throw new Error(`GitHub search failed: ${res.status} ${body.message ?? res.statusText}${hint}`);
  }
  return parseSearchResults(await res.json(), dateField);
}

/** Reads a GitHub /search/issues response. Oldest first. */
export function parseSearchResults(json: unknown, dateField: "merged" | "updated"): PullRequest[] {
  const items = (json as { items?: unknown[] })?.items;
  if (!Array.isArray(items)) return [];
  const out: PullRequest[] = [];
  for (const raw of items) {
    const item = raw as {
      title?: string;
      number?: number;
      html_url?: string;
      repository_url?: string;
      updated_at?: string;
      closed_at?: string;
      pull_request?: { merged_at?: string | null };
    };
    if (!item.html_url || typeof item.number !== "number") continue;
    const when = dateField === "merged" ? item.pull_request?.merged_at ?? item.closed_at : item.updated_at;
    const repo = /repos\/([^/]+\/[^/]+)$/.exec(item.repository_url ?? "")?.[1] ?? "";
    out.push({ title: (item.title ?? "").trim(), repo, number: item.number, url: item.html_url, date: when ? localDay(when) : "" });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
