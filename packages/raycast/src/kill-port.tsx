import { Action, ActionPanel, Alert, confirmAlert, Icon, Keyboard, List, showToast, Toast } from "@raycast/api";
import { killProcess, listListeningPorts, recordRun, type PortEntry } from "@dx/core";
import { useCallback, useEffect, useState } from "react";

type Filter = "dev" | "all";

export default function KillPort() {
  const [entries, setEntries] = useState<PortEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<Filter>("dev");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await listListeningPorts());
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = filter === "dev" ? entries.filter((e) => e.port >= 1024 && !e.system) : entries;

  return (
    <List
      isLoading={loading}
      searchBarPlaceholder="Filter by port, process or PID"
      searchBarAccessory={
        <List.Dropdown tooltip="Which ports" value={filter} onChange={(v) => setFilter(v as Filter)}>
          <List.Dropdown.Item title="Dev ports (1024 and up)" value="dev" />
          <List.Dropdown.Item title="All ports" value="all" />
        </List.Dropdown>
      }
    >
      {!loading && visible.length === 0 ? (
        <List.EmptyView
          icon={Icon.Plug}
          title={error ? "Couldn't list ports" : "Nothing is listening"}
          description={error}
          actions={
            <ActionPanel>
              <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={load} />
            </ActionPanel>
          }
        />
      ) : (
        visible.map((entry) => (
          <List.Item
            key={`${entry.port}:${entry.pid}`}
            title={String(entry.port)}
            subtitle={entry.processName ?? "unknown process"}
            icon={entry.system ? Icon.Lock : Icon.Plug}
            keywords={[String(entry.pid), entry.processName ?? "", ...(entry.commandLine ? [entry.commandLine] : [])]}
            accessories={[
              ...(entry.commandLine ? [{ icon: Icon.Terminal, tooltip: entry.commandLine }] : []),
              { text: `PID ${entry.pid}` },
            ]}
            actions={
              <ActionPanel>
                {!entry.system && (
                  <Action
                    title="Kill Process"
                    icon={Icon.XMarkCircle}
                    style={Action.Style.Destructive}
                    onAction={() => kill(entry, load)}
                  />
                )}
                <Action.OpenInBrowser
                  title={`Open localhost:${entry.port}`}
                  url={`http://localhost:${entry.port}`}
                  shortcut={Keyboard.Shortcut.Common.Open}
                />
                <Action.CopyToClipboard
                  title="Copy PID"
                  content={String(entry.pid)}
                  shortcut={Keyboard.Shortcut.Common.Copy}
                />
                {entry.commandLine && <Action.CopyToClipboard title="Copy Command Line" content={entry.commandLine} />}
                <Action
                  title="Refresh"
                  icon={Icon.ArrowClockwise}
                  shortcut={Keyboard.Shortcut.Common.Refresh}
                  onAction={load}
                />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}

async function kill(entry: PortEntry, reload: () => Promise<void>): Promise<void> {
  const confirmed = await confirmAlert({
    title: `Kill ${entry.processName ?? "this process"} on port ${entry.port}?`,
    message: entry.commandLine ? `PID ${entry.pid}\n${entry.commandLine}` : `PID ${entry.pid}`,
    icon: Icon.XMarkCircle,
    primaryAction: { title: "Kill", style: Alert.ActionStyle.Destructive },
  });
  if (!confirmed) return;
  const toast = await showToast({ style: Toast.Style.Animated, title: `Killing PID ${entry.pid}…` });
  const result = await killProcess(entry.pid);
  recordRun("port.kill", result.ok, `port ${entry.port}: ${result.message}`, "raycast");
  toast.style = result.ok ? Toast.Style.Success : Toast.Style.Failure;
  toast.title = result.ok ? `Port ${entry.port} is free` : "Couldn't kill it";
  toast.message = result.message;
  await reload();
}
