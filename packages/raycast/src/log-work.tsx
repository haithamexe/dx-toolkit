import { showHUD, showToast, Toast, type LaunchProps } from "@raycast/api";
import { addJournalEntry, recordRun } from "@dx/core";

export default async function LogWork(props: LaunchProps<{ arguments: { text: string } }>) {
  try {
    const entry = addJournalEntry(props.arguments.text);
    recordRun("log", true, undefined, "raycast");
    await showHUD(`Logged: ${entry.text}`);
  } catch (err) {
    await showToast({ style: Toast.Style.Failure, title: "Couldn't log that", message: (err as Error).message });
  }
}
