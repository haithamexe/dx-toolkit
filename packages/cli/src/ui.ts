import os from "node:os";
import { createInterface } from "node:readline/promises";

const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (open: number, close: number) => (s: string) => (color ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
};

export class UsageError extends Error {}

const ANSI = /\x1b\[[0-9;]*m/g;
const visible = (s: string) => s.replace(ANSI, "").length;

/** Left-aligned columns. The last column is cut to fit the terminal width. */
export function table(header: string[], rows: string[][]): string {
  const all = [header.map((h) => c.dim(h)), ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => visible(r[i] ?? ""))));
  const termWidth = process.stdout.columns ?? 120;
  const fixed = widths.slice(0, -1).reduce((a, w) => a + w + 2, 0);
  const lastMax = Math.max(20, termWidth - fixed - 1);
  return all
    .map((r) =>
      r
        .map((cell, i) => {
          const isLast = i === r.length - 1;
          if (isLast) return truncate(cell ?? "", lastMax);
          return (cell ?? "") + " ".repeat(widths[i] - visible(cell ?? "") + 2);
        })
        .join(""),
    )
    .join("\n");
}

export function truncate(s: string, max: number): string {
  if (visible(s) <= max) return s;
  const plain = s.replace(ANSI, "");
  return plain.slice(0, Math.max(0, max - 1)) + "…";
}

/** "C:\Users\you\projects\todo-app" → "~\projects\todo-app" */
export function tildify(p: string): string {
  const home = os.homedir();
  return p.toLowerCase().startsWith(home.toLowerCase()) ? "~" + p.slice(home.length) : p;
}

export function relativeTime(ms: number, now = Date.now()): string {
  if (!ms) return "—";
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Yes/no question. Without a terminal to ask in, the answer is no. */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const answer = await ask(`${question} ${c.dim("[y/N]")} `);
  return /^y(es)?$/i.test(answer);
}

/** Numbered pick list. Returns undefined if the user enters nothing or there is no terminal. */
export async function pick<T>(items: T[], label: (item: T) => string, prompt = "Pick one"): Promise<T | undefined> {
  if (items.length === 0) return undefined;
  items.forEach((item, i) => console.log(`  ${c.cyan(String(i + 1).padStart(2))}  ${label(item)}`));
  if (!process.stdin.isTTY) return undefined;
  const answer = await ask(`${prompt} ${c.dim(`(1-${items.length}, Enter to cancel)`)}: `);
  const n = Number(answer);
  return Number.isInteger(n) && n >= 1 && n <= items.length ? items[n - 1] : undefined;
}

export function ok(msg: string): void {
  console.log(`${c.green("✓")} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`${c.yellow("!")} ${msg}`);
}

export function info(msg: string): void {
  console.log(`${c.dim("·")} ${msg}`);
}
