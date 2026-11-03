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
  return entries.filter((e) => e.date >= startKey);
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
