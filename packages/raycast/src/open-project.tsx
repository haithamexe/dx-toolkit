import { Action, ActionPanel, closeMainWindow, Color, Icon, Keyboard, List, showToast, Toast } from "@raycast/api";
import {
  commandExists,
  configPath,
  loadConfig,
  openInEditor,
  openTerminal,
  recordRun,
  scanProjects,
  type DxConfig,
  type Project,
  type ProjectKind,
} from "@dx/core";
import path from "node:path";
import { useCallback, useEffect, useState } from "react";

interface State {
  loading: boolean;
  projects: Project[];
  config?: DxConfig;
  /** The dx command is on PATH, so "Start Dev Server" can use `dx go .` (port checks, opens the browser). */
  hasDx: boolean;
  error?: string;
}

const KIND_COLOR: Record<ProjectKind, Color> = {
  node: Color.Green,
  go: Color.Blue,
  rust: Color.Orange,
  python: Color.Yellow,
  dotnet: Color.Purple,
  other: Color.SecondaryText,
};

export default function OpenProject() {
  const [state, setState] = useState<State>({ loading: true, projects: [], hasDx: false });

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const config = loadConfig();
      const projects = scanProjects(config);
      const hasDx = Boolean(await commandExists("dx"));
      setState({ loading: false, projects, config, hasDx });
    } catch (err) {
      setState({ loading: false, projects: [], hasDx: false, error: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const { config } = state;

  return (
    <List isLoading={state.loading} searchBarPlaceholder="Search projects">
      {!state.loading && state.projects.length === 0 ? (
        <List.EmptyView
          icon={Icon.Folder}
          title={state.error ? "dx couldn't read its settings" : "No projects found"}
          description={
            state.error ??
            `dx looks in ${config?.projectsRoots.join(", ") ?? "your projects folder"}. Change "projectsRoots" in the settings file.`
          }
          actions={
            <ActionPanel>
              <Action.Open title="Open dx Settings" target={configPath()} icon={Icon.Gear} />
              <Action title="Reload" icon={Icon.ArrowClockwise} onAction={load} />
            </ActionPanel>
          }
        />
      ) : (
        state.projects.map((project) => (
          <List.Item
            key={project.dir}
            title={project.name}
            subtitle={project.devCommand}
            icon={{ source: Icon.Folder, tintColor: KIND_COLOR[project.kind] }}
            keywords={[path.basename(project.dir), project.kind, project.packageManager ?? ""].filter(Boolean)}
            accessories={[
              { tag: project.packageManager ? `${project.kind}/${project.packageManager}` : project.kind },
              ...(project.lastActive ? [{ date: new Date(project.lastActive), tooltip: "Last active" }] : []),
            ]}
            actions={<ProjectActions project={project} config={config} hasDx={state.hasDx} onReload={load} />}
          />
        ))
      )}
    </List>
  );
}

function ProjectActions(props: { project: Project; config?: DxConfig; hasDx: boolean; onReload: () => void }) {
  const { project, config, hasDx, onReload } = props;
  const editor = project.editor ?? config?.editor ?? "code";
  const devInTerminal = hasDx ? "dx go . --no-editor" : project.devCommand;

  return (
    <ActionPanel>
      <ActionPanel.Section>
        <Action
          title={`Open in ${editor}`}
          icon={Icon.Code}
          onAction={() =>
            run(`Opened ${project.name}`, project.name, async () => {
              await openInEditor(project.dir, editor);
            })
          }
        />
        {devInTerminal && (
          <Action
            title="Open and Start Dev Server"
            icon={Icon.Play}
            shortcut={{ macOS: { modifiers: ["cmd"], key: "d" }, Windows: { modifiers: ["ctrl"], key: "d" } }}
            onAction={() =>
              run(`Started ${project.name}`, project.name, async () => {
                await openInEditor(project.dir, editor);
                await openTerminal(project.dir, devInTerminal, project.name);
              })
            }
          />
        )}
        {devInTerminal && (
          <Action
            title="Start Dev Server Only"
            icon={Icon.Terminal}
            shortcut={{
              macOS: { modifiers: ["cmd", "shift"], key: "d" },
              Windows: { modifiers: ["ctrl", "shift"], key: "d" },
            }}
            onAction={() =>
              run(`Started ${project.name}`, project.name, async () => {
                await openTerminal(project.dir, devInTerminal, project.name);
              })
            }
          />
        )}
      </ActionPanel.Section>
      <ActionPanel.Section>
        {project.url && (
          <Action.OpenInBrowser
            url={project.url}
            title={project.urlGuessed ? `Open ${project.url} (guessed)` : `Open ${project.url}`}
          />
        )}
        <Action
          title="Open Terminal Here"
          icon={Icon.Terminal}
          shortcut={{ macOS: { modifiers: ["cmd"], key: "t" }, Windows: { modifiers: ["ctrl"], key: "t" } }}
          onAction={() =>
            run("Terminal opened", project.name, async () => {
              await openTerminal(project.dir, undefined, project.name);
            })
          }
        />
        <Action.ShowInFinder path={project.dir} />
        <Action.CopyToClipboard title="Copy Path" content={project.dir} shortcut={Keyboard.Shortcut.Common.CopyPath} />
      </ActionPanel.Section>
      <ActionPanel.Section>
        <Action
          title="Reload Projects"
          icon={Icon.ArrowClockwise}
          shortcut={Keyboard.Shortcut.Common.Refresh}
          onAction={onReload}
        />
        <Action.Open title="Open dx Settings" target={configPath()} icon={Icon.Gear} />
      </ActionPanel.Section>
    </ActionPanel>
  );
}

async function run(success: string, projectName: string, task: () => Promise<void>): Promise<void> {
  try {
    await task();
    recordRun("go", true, projectName, "raycast");
    await showToast({ style: Toast.Style.Success, title: success });
    await closeMainWindow({ clearRootSearch: true });
  } catch (err) {
    const message = (err as Error).message;
    recordRun("go", false, `${projectName}: ${message}`, "raycast");
    await showToast({ style: Toast.Style.Failure, title: "Couldn't do that", message });
  }
}
