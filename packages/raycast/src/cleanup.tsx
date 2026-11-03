import { Action, ActionPanel, Alert, confirmAlert, Icon, List, showToast, Toast } from "@raycast/api";
import { deleteCleanup, findCleanup, formatBytes, recordRun, type CleanupItem, type CleanupScan } from "@dx/core";
import { useCallback, useEffect, useState } from "react";

const RANGES = [
  { title: "Idle 30+ days", value: "30" },
  { title: "Idle 90+ days", value: "90" },
  { title: "Idle 7+ days", value: "7" },
];

export default function Cleanup() {
  const [days, setDays] = useState("30");
  const [scan, setScan] = useState<CleanupScan>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setScan(await findCleanup({ days: Number(days) }));
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  // Deleting goes through a confirmation that names what goes, and only folders a fresh scan returns.
  async function remove(items: CleanupItem[]) {
    const bytes = items.reduce((n, i) => n + i.bytes, 0);
    const ok = await confirmAlert({
      title: items.length === 1 ? `Delete ${items[0].relative} in ${items[0].project}?` : `Delete ${items.length} folders?`,
      message: `This frees ${formatBytes(bytes)}. They're rebuilt by an install or a build (npm install brings node_modules back).`,
      primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive },
    });
    if (!ok) return;
    const fresh = await findCleanup({ days: Number(days) });
    const allowed = new Set(fresh.items.map((i) => i.dir));
    const results = await deleteCleanup(items.filter((i) => allowed.has(i.dir)));
    const freed = results.filter((r) => r.ok).reduce((n, r) => n + r.bytes, 0);
    const failed = results.filter((r) => !r.ok).length;
    recordRun("clean", failed === 0, `freed ${formatBytes(freed)}`, "raycast");
    await showToast({
      style: failed ? Toast.Style.Failure : Toast.Style.Success,
      title: `Freed ${formatBytes(freed)}`,
      message: failed ? `${failed} folder(s) couldn't be deleted` : undefined,
    });
    await load();
  }

  const items = scan?.items ?? [];
  return (
    <List
      isLoading={loading}
      searchBarPlaceholder="Search folders"
      navigationTitle={scan ? `Cleanup: ${formatBytes(scan.totalBytes)} to free` : "Cleanup"}
      searchBarAccessory={
        <List.Dropdown tooltip="Projects idle for" value={days} onChange={setDays}>
          {RANGES.map((r) => (
            <List.Dropdown.Item key={r.value} title={r.title} value={r.value} />
          ))}
        </List.Dropdown>
      }
    >
      {items.length === 0 && !loading ? (
        <List.EmptyView
          icon={error ? Icon.Warning : Icon.CheckCircle}
          title={error ? "Couldn't scan your projects" : "Nothing to clean"}
          description={error ?? `No node_modules or build folders in projects idle for ${days}+ days.`}
        />
      ) : (
        items.map((item) => (
          <List.Item
            key={item.dir}
            title={item.project}
            subtitle={item.relative}
            accessories={[{ text: formatBytes(item.bytes) }]}
            actions={
              <ActionPanel>
                <Action title="Delete Folder" icon={Icon.Trash} style={Action.Style.Destructive} onAction={() => remove([item])} />
                <Action title={`Delete All ${items.length}`} icon={Icon.Trash} style={Action.Style.Destructive} onAction={() => remove(items)} />
                <Action.ShowInFinder path={item.dir} />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
