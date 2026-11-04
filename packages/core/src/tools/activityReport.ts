import { byTime, isProblem, readActivity, type ActivityEvent } from "./activity.js";
import type { PageStep } from "./browser.js";

/**
 * What the activity history is turned into: a bug report for an error (the steps that led to
 * it, what went wrong, the requests with their bodies) and, for a visit, the steps to do it
 * again in a headless browser.
 */

/** The events around one: up to `before` minutes before it, and a few seconds after. */
export function reportContext(dir: string, id: number, before = 10): { target?: ActivityEvent; events: ActivityEvent[] } {
  const at = Math.floor(id / 1000);
  const events = readActivity({ dir, since: new Date(at - before * 60_000), until: new Date(at + 60_000), limit: 5000 });
  const target = events.find((e) => e.id === id);
  if (!target) return { events: [] };
  const t = Date.parse(target.at);
  // The visit the error happened in, when there is one, and what the server did meanwhile.
  const inVisit = (e: ActivityEvent) => !target.visit || !e.visit || e.visit === target.visit;
  const picked = events.filter((e) => {
    const et = Date.parse(e.at);
    if (e.id === target.id) return true;
    if (!inVisit(e)) return false;
    if (et <= t) return true;
    // Afterwards: only what the same moment set off (a failed request, the server's error).
    return et - t <= 5000 && (isProblem(e) || e.type === "request");
  });
  return { target, events: byTime(picked).slice(-60) };
}

/** A bug report in markdown, for an issue or an AI chat. Credentials are masked already. */
export function bugReport(target: ActivityEvent, events: ActivityEvent[], options: { maxBody?: number } = {}): string {
  const max = options.maxBody ?? 2000;
  const clip = (s: string) => (s.length > max ? `${s.slice(0, max)}\n… (cut short)` : s);
  const pretty = (s: string) => {
    try {
      return JSON.stringify(JSON.parse(s), null, 2);
    } catch {
      return s;
    }
  };
  const fence = (s: string, lang = "") => `\`\`\`${lang}\n${s.replace(/```/g, "``​`")}\n\`\`\``;
  const time = (e: ActivityEvent) => new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const title = target.text.split("\n")[0];
  const out: string[] = [`## ${title}`, ""];
  const where = target.page ?? events.find((e) => e.page)?.page;
  out.push(`- **Project**: ${target.project}${target.service ? ` (${target.service})` : ""}`);
  if (where) out.push(`- **Page**: ${where}`);
  out.push(`- **When**: ${new Date(target.at).toLocaleString()}`);
  if (target.source) out.push(`- **Where in the code**: \`${target.source}\``);
  out.push("");

  const steps = events.filter((e) => e.type === "page" || e.type === "route" || e.type === "action");
  if (steps.length) {
    out.push("### Steps", "");
    steps.forEach((e, i) => out.push(`${i + 1}. ${e.type === "page" ? `Opened ${e.url ?? e.text}` : e.type === "route" ? `Went ${e.text}` : e.text}`));
    out.push("");
  }

  const problems = events.filter(isProblem);
  if (problems.length) {
    out.push("### What went wrong", "");
    for (const e of problems) {
      const label = e.type === "server-error" ? "Server error" : e.type === "error" ? "Error in the browser" : e.type === "console" ? `Console ${e.level}` : "Request failed";
      out.push(`- **${label}** at ${time(e)}: ${e.text.split("\n")[0]}${e.source ? ` (\`${e.source}\`)` : ""}`);
    }
    out.push("");
  }

  const requests = events.filter((e) => e.type === "request" && (e.requestBody || e.responseBody || isProblem(e)));
  if (requests.length) {
    out.push("### Requests", "");
    for (const e of requests) {
      out.push(`**${e.text}**${e.ms !== undefined ? ` (${e.ms} ms)` : ""}`, "");
      if (e.requestBody) out.push("Sent:", "", fence(clip(pretty(e.requestBody)), "json"), "");
      if (e.responseBody) out.push("Returned:", "", fence(clip(pretty(e.responseBody)), "json"), "");
    }
  }

  const withStack = [target, ...problems.filter((e) => e.id !== target.id)].filter((e) => e.stack).slice(0, 3);
  for (const e of withStack) out.push(`### Stack: ${e.text.split("\n")[0].slice(0, 120)}`, "", fence(clip(e.stack!)), "");

  const log = events.filter((e) => e.type === "console" && !isProblem(e)).slice(-10);
  if (log.length) out.push("### Console", "", fence(log.map((e) => `${time(e)} ${e.text.split("\n")[0]}`).join("\n")), "");

  out.push("_Recorded by dx; passwords, tokens and cookies are masked._");
  return out.join("\n");
}

export interface Replay {
  /** The page the visit started on. */
  url: string;
  steps: PageStep[];
  /** What can't be done again, in words: typed values, back and forward. */
  notes: string[];
}

/**
 * The steps to do a visit again: the page it started on, then each click, waiting after one
 * that changed the address for the new address. Typed values aren't recorded, so fields stay
 * empty; back and forward aren't replayed.
 */
export function replayFromVisit(events: ActivityEvent[]): Replay | undefined {
  const visit = byTime(events.filter((e) => e.from === "browser" || e.from === "check" || (e.from === "dx-browser" && e.type !== "request")));
  const start = visit.find((e) => e.page)?.page;
  if (!start) return undefined;
  const steps: PageStep[] = [];
  const notes = new Set<string>();
  for (let i = 0; i < visit.length; i++) {
    const e = visit[i];
    if (e.type === "action" && e.text.startsWith("Clicked")) {
      const target = e.target ?? labelTarget(e.text);
      if (!target) {
        notes.add(`Skipped “${e.text}”: there's nothing to find it by.`);
        continue;
      }
      steps.push({ click: target });
      // A click that changed the address: wait for the new one before the next click.
      const next = visit[i + 1];
      if (next?.type === "route" && Date.parse(next.at) - Date.parse(e.at) < 3000) {
        const to = next.text.split(" → ")[1];
        if (to) steps.push({ waitFor: `url=${to.split("#")[0] || to}` });
      }
    } else if (e.type === "action" && e.text.startsWith("Submitted")) {
      notes.add("Fields are left as the page has them: dx doesn't record what you type.");
    } else if (e.type === "route" && e.text.endsWith("(back or forward)")) {
      notes.add("Back and forward aren't replayed.");
    }
  }
  return { url: start, steps: steps.slice(0, 50), notes: [...notes] };
}

/** "Clicked button “Add to cart” (…)" → text=Add to cart */
function labelTarget(text: string): string | undefined {
  const m = /“([^”]+)”/.exec(text);
  return m ? `text=${m[1]}` : undefined;
}
