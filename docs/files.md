# What dx stores

Everything dx keeps is in one folder. Back to the [README](../README.md).

Everything dx stores is in one folder: `~/.dx` (`C:\Users\<you>\.dx`).

| File | What it is |
|---|---|
| `config.json` | Settings: where your projects are, which editor and terminal to open |
| `journal.md` | Your work journal, plain markdown, edit it by hand any time |
| `runs.jsonl` | One line per tool run, so a failure is never silent (`dx runs`) |
| `summaries/` | Saved work summaries, one markdown file per day you ran `dx summary --save` |
| `templates/` | Your project templates for `dx new`, one folder each |
| `activity/` | The activity history: one folder per project, one file per day, kept 7 days |
| `tools/` | Each project's own tools from its Tools page, one file per project, readable by you only |
| `state-backups/` | What the last imports of [your dx from another computer](features.md#your-dx-on-another-computer) changed, file by file, so each can be undone (the last 5) |
| `dashboard.json` | While the dashboard runs: its address and access token, readable by you only, so the `dx` command and AI tools can reach it |
| `app/` | The dx app: the Electron it runs in (`runtime/<version>`, installed the first time you open dx, and `current`, a link to the one in use), its window's place and its browser data. `dx ui --remove-app` deletes it |
