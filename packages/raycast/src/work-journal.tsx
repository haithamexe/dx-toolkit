import { Action, ActionPanel, Icon, List } from "@raycast/api";
import { journalPath, readJournal, type JournalEntry } from "@dx/core";
import { useMemo, useState } from "react";

const RANGES = [
  { title: "Last 7 days", value: "7" },
  { title: "Last 30 days", value: "30" },
  { title: "Last 90 days", value: "90" },
];

export default function WorkJournal() {
  const [days, setDays] = useState("7");

  const { byDate, error } = useMemo(() => {
    let entries: JournalEntry[] = [];
    let error: string | undefined;
    try {
      entries = readJournal({ sinceDays: Number(days) });
    } catch (err) {
      error = (err as Error).message;
    }
    // newest day first, entries within a day in the order they were written
    const groups = new Map<string, JournalEntry[]>();
    for (const e of entries) groups.set(e.date, [...(groups.get(e.date) ?? []), e]);
    return { byDate: [...groups.entries()].reverse(), error };
  }, [days]);

  return (
    <List
      searchBarPlaceholder="Search your journal"
      searchBarAccessory={
        <List.Dropdown tooltip="Range" value={days} onChange={setDays}>
          {RANGES.map((r) => (
            <List.Dropdown.Item key={r.value} title={r.title} value={r.value} />
          ))}
        </List.Dropdown>
      }
    >
      {byDate.length === 0 ? (
        <List.EmptyView
          icon={Icon.Book}
          title={error ? "Couldn't read the journal" : "Nothing logged yet"}
          description={error ?? 'Use "Log Work" in Raycast, or dx log "what you did" in a terminal.'}
          actions={
            <ActionPanel>
              <Action.Open title="Open Journal File" target={journalPath()} />
            </ActionPanel>
          }
        />
      ) : (
        byDate.map(([date, entries]) => (
          <List.Section key={date} title={formatDate(date)} subtitle={`${entries.length}`}>
            {entries.map((e, i) => (
              <List.Item
                key={`${date}-${i}`}
                title={e.text}
                accessories={e.time ? [{ text: e.time }] : []}
                actions={
                  <ActionPanel>
                    <Action.CopyToClipboard title="Copy Entry" content={e.text} />
                    <Action.CopyToClipboard
                      title="Copy This Day"
                      content={entries.map((x) => `- ${x.text}`).join("\n")}
                    />
                    <Action.Open title="Open Journal File" target={journalPath()} />
                  </ActionPanel>
                }
              />
            ))}
          </List.Section>
        ))
      )}
    </List>
  );
}

function formatDate(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
}
