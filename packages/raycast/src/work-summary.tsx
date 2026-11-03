import { Action, ActionPanel, Detail, Icon, showToast, Toast } from "@raycast/api";
import { buildSummary, formatSummary, recordRun, saveSummary, type WorkSummary } from "@dx/core";
import { useEffect, useState } from "react";

const RANGES = [
  { title: "This week", days: 7 },
  { title: "Last 14 days", days: 14 },
  { title: "Last 30 days", days: 30 },
];

export default function WorkSummaryCommand() {
  const [days, setDays] = useState(7);
  const [state, setState] = useState<{ summary?: WorkSummary; markdown?: string; error?: string; loading: boolean }>({ loading: true });

  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    buildSummary({ days, github: true })
      .then((summary) => {
        if (!live) return;
        setState({ summary, markdown: formatSummary(summary), loading: false });
        recordRun("summary", true, `${summary.projects.length} projects`, "raycast");
      })
      .catch((err: Error) => live && setState({ error: err.message, loading: false }));
    return () => {
      live = false;
    };
  }, [days]);

  const markdown = state.error ? `# Couldn't build the summary\n\n${state.error}` : (state.markdown ?? "");

  return (
    <Detail
      isLoading={state.loading}
      markdown={markdown}
      navigationTitle="Work Summary"
      actions={
        state.markdown ? (
          <ActionPanel>
            <Action.CopyToClipboard title="Copy Summary" content={state.markdown} />
            <Action
              title="Save as Markdown File"
              icon={Icon.SaveDocument}
              onAction={async () => {
                const file = saveSummary(state.markdown!, state.summary!);
                await showToast({ style: Toast.Style.Success, title: "Saved", message: file });
              }}
            />
            <ActionPanel.Section title="Range">
              {RANGES.map((r) => (
                <Action key={r.days} title={r.title} icon={r.days === days ? Icon.CheckCircle : Icon.Circle} onAction={() => setDays(r.days)} />
              ))}
            </ActionPanel.Section>
          </ActionPanel>
        ) : undefined
      }
    />
  );
}
