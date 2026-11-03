import { parseArgs } from "node:util";
import { addJournalEntry, journalPath, loadConfig, openInEditor, readJournal, recordRun } from "@dx/core";
import type { Command } from "../command.js";
import { c, ok, tildify } from "../ui.js";

export const logCommand: Command = {
  name: "log",
  summary: "Write one line in your work journal, or read it back",
  usage: [
    'dx log "fixed seat map overflow"   add an entry',
    "dx log                             show the last 7 days",
    "dx log --days 30                   show the last 30 days",
    "dx log --edit                      open the journal file in your editor",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        days: { type: "string", short: "d" },
        edit: { type: "boolean", short: "e" },
      },
    });
    if (values.edit) {
      await openInEditor(journalPath(), loadConfig().editor);
      ok(`Opened ${tildify(journalPath())}`);
      return;
    }
    const text = positionals.join(" ").trim();
    if (text) {
      const entry = addJournalEntry(text);
      recordRun("log", true);
      ok(`Logged ${c.dim(`${entry.date} ${entry.time}`)} ${entry.text}`);
      return;
    }
    const days = values.days ? Math.max(1, Number(values.days) || 7) : 7;
    const entries = readJournal({ sinceDays: days });
    if (entries.length === 0) {
      console.log(`Nothing logged in the last ${days} day(s). Add an entry with: dx log "what you did"`);
      return;
    }
    let lastDate = "";
    for (const e of entries) {
      if (e.date !== lastDate) {
        console.log(`${lastDate ? "\n" : ""}${c.bold(e.date)}`);
        lastDate = e.date;
      }
      console.log(`  ${c.dim(e.time || "     ")}  ${e.text}`);
    }
    console.log(c.dim(`\n${entries.length} entr${entries.length === 1 ? "y" : "ies"} · ${tildify(journalPath())}`));
  },
};
