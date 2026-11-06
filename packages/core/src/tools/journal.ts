import fs from "node:fs";
import { dxPath, ensureDxHome, stripBom } from "../config.js";

/**
 * A plain markdown work journal at ~/.dx/journal.md:
 *
 *   ## 2026-11-03
 *   - 09:14 fixed seat map overflow
 *
 * Plain text on purpose: you can open and edit it by hand, and the weekly summary reads it.
 */
export interface JournalEntry {
  date: string; // YYYY-MM-DD, local time
  time: string; // HH:MM, local time
  text: string;
}

const JOURNAL_FILE = "journal.md";
const HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/;
const ENTRY = /^-\s+(?:(\d{2}:\d{2})\s+)?(.*)$/;

export function journalPath(): string {
  return dxPath(JOURNAL_FILE);
}

export function addJournalEntry(text: string, when = new Date()): JournalEntry {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("Nothing to log: the entry is empty.");
  ensureDxHome();
  const file = journalPath();
  const date = localDate(when);
  const time = localTime(when);
  const existing = fs.existsSync(file) ? stripBom(fs.readFileSync(file, "utf8")) : "";

  let chunk = "";
  if (lastHeading(existing) !== date) {
    const needsGap = existing.length > 0;
    const endsWithNewline = existing.endsWith("\n");
    chunk += `${needsGap && !endsWithNewline ? "\n" : ""}${needsGap ? "\n" : ""}## ${date}\n`;
  } else if (existing.length > 0 && !existing.endsWith("\n")) {
    chunk += "\n";
  }
  chunk += `- ${time} ${clean}\n`;
  if (!existing) chunk = `# Work journal\n\n${chunk}`;
  fs.appendFileSync(file, chunk, "utf8");
  return { date, time, text: clean };
}

export function readJournal(options: { sinceDays?: number; now?: Date } = {}): JournalEntry[] {
  const file = journalPath();
  if (!fs.existsSync(file)) return [];
  const entries = parseJournal(stripBom(fs.readFileSync(file, "utf8")));
  if (options.sinceDays === undefined) return entries;
  const now = options.now ?? new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (options.sinceDays - 1));
  const startKey = localDate(start);
  // A window that ends before today (a past year) leaves out what came after it.
  const endKey = localDate(now);
  return entries.filter((e) => e.date >= startKey && e.date <= endKey);
}

export function parseJournal(text: string): JournalEntry[] {
  const entries: JournalEntry[] = [];
  let current: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) {
      current = heading[1];
      continue;
    }
    if (!current) continue;
    const entry = ENTRY.exec(line);
    if (entry && entry[2].trim()) entries.push({ date: current, time: entry[1] ?? "", text: entry[2].trim() });
  }
  return entries;
}

/**
 * Adds entries the journal doesn't have yet (from another computer's dx state), each under its
 * day's heading in time order, a new day's heading in date order. Everything else in the text,
 * written by hand or not, stays as it is.
 */
export function mergeJournalText(text: string, entries: JournalEntry[]): { text: string; added: number } {
  const id = (e: JournalEntry) => `${e.date} ${e.time} ${e.text}`;
  const have = new Set(parseJournal(text).map(id));
  const missing: JournalEntry[] = [];
  for (const e of [...entries].sort((a, b) => id(a).localeCompare(id(b)))) {
    if (have.has(id(e))) continue;
    have.add(id(e));
    missing.push(e);
  }
  if (!missing.length) return { text, added: 0 };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text ? text.replace(/\r?\n$/, "").split(/\r?\n/) : ["# Work journal"];
  for (const e of missing) {
    const line = e.time ? `- ${e.time} ${e.text}` : `- ${e.text}`;
    const headings = lines.flatMap((l, i) => {
      const m = HEADING.exec(l);
      return m ? [{ i, date: m[1] }] : [];
    });
    const same = headings.find((h) => h.date === e.date);
    if (same) {
      const next = headings.find((h) => h.i > same.i)?.i ?? lines.length;
      // After the last earlier entry and the indented lines under it, which belong to it.
      let at = same.i + 1;
      let under = false;
      for (let i = same.i + 1; i < next; i++) {
        const m = ENTRY.exec(lines[i]);
        if (m) under = (m[1] ?? "") <= e.time;
        else if (!/^\s+\S/.test(lines[i])) under = false;
        if (under) at = i + 1;
      }
      lines.splice(at, 0, line);
      continue;
    }
    const later = headings.find((h) => h.date > e.date);
    if (later) lines.splice(later.i, 0, `## ${e.date}`, line, "");
    else {
      if (lines.length && lines[lines.length - 1].trim()) lines.push("");
      lines.push(`## ${e.date}`, line);
    }
  }
  return { text: lines.join(eol) + eol, added: missing.length };
}

function lastHeading(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = HEADING.exec(lines[i]);
    if (m) return m[1];
  }
  return undefined;
}

export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function localTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
