# dx toolkit

Your projects, dev servers, ports, work journal and weekly summary in one place: a local dashboard, a `dx` command, and tools your AI assistant can call. Runs on Windows, macOS and Linux.

**Your AI coding agent can run your app and see what it does.** Claude Code, Cursor and the others start the dev server through dx, read its output, see compile errors and stack traces with their file and line, request pages, and check that a fix worked, while you watch the same server in the dashboard. dx connects itself to the AI tools on your computer: there's nothing to configure.

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/images/projects-light.png">
  <img alt="The dx dashboard's Projects page, a white sheet on a teal grid with Floppy the floppy disk as its logo: a running stack called shop, with its api and web services at api.shop.localhost and web.shop.localhost; a todo-app dev server marked Started by AI with 1 error and a Take over button; the project list below; and the AI agent's tab at the right edge." src="docs/images/projects.png">
</picture>

## Install

You need **Node 22 or newer** (`node -v`) and git. Then, in a terminal (PowerShell on Windows):

```bash
npm install -g dx-devkit
```

```bash
dx ui
```

That's all. The first time, dx sets itself up: it finds your projects folders and your editor, and adds itself to the AI tools you have (Claude Code, Claude Desktop, Cursor, Windsurf, VS Code). Projects somewhere else? `dx config add-root <folder>`. `dx doctor` checks everything and says how to fix what isn't right.

**Update** with `dx update`. **Remove** with `dx uninstall`, or **Remove dx** at the bottom of the dashboard's Settings: it takes off every kind and version of dx and never touches your projects.

## What you can do

- **Run projects and see what they do.** Start a project or a whole stack (front end, API, database) with one click, at `name.localhost`, with its output, errors and requests beside it. Details: [features](docs/features.md).
- **Save, share, release and go back** in git, with every step undoable, on the Git page.
- **Look at what your app sent and got**, mock the API, change or pause requests, and break the app on purpose (slow network, random clicks, another date, a slow phone) before your users do.
- **Keep your computer tidy**: tools and their updates, what's listening, idle `node_modules`, outdated and vulnerable packages, Docker.
- **See your week**: commits, pull requests and a journal, ready to send.
- **Let your AI assistant do it too**: every dashboard action is available to it, safely. See [AI tools](docs/ai-tools.md).

The dashboard shows only what a project has: pages with nothing in them (Tools, Data, Agents, Secrets) appear when there is something to show, and everything is reachable from **Jump to…** (Ctrl+K).

## More

| | |
|---|---|
| [Install, update, remove](docs/install.md) | Platform notes, from source, what removing takes |
| [Features](docs/features.md) | Every page and tool, with how it works |
| [The `dx` command](docs/cli.md) | Every command, `.devrc.json` and `config.json` |
| [AI tools and Raycast](docs/ai-tools.md) | The MCP server, resources, prompts, connecting by hand |
| [What dx stores](docs/files.md) | The `~/.dx` folder |
| [Working on dx](docs/development.md) | Adding a tool, tests, CLAUDE.md |
| [Releasing](docs/releasing.md) | For maintainers |
| [Changelog](CHANGELOG.md) · [Decisions and backlog](docs/MEMORY.md) · [Enhancements](docs/ENHANCEMENTS.md) | |

## Troubleshooting

- **"Access is denied" when killing a process**: it belongs to another user or needs admin rights. Run the terminal as administrator.
- **`npm install -g dx-devkit` fails with EEXIST (file already exists) or EPERM**: another dx install, or one that was half removed, still owns the `dx` command, or a dx process still runs from it. Run `npx -y dx-devkit@latest update` (or `dx update`) instead: it cleans that up first, with no `--force` needed. `dx doctor` says when this is the case.
- **`dx` not found after `npm run link`**: open a new terminal. If it still isn't found, check that the folder `npm prefix -g` prints is on your PATH.
- **Editor doesn't open**: run `dx doctor`, then set the editor with `dx config editor "C:\Path\To\Editor.exe"`.
- **Debug output**: set `DX_DEBUG=1` to print full error stacks.

## Contributing

Bug reports, ideas and pull requests are welcome: [CONTRIBUTING.md](CONTRIBUTING.md) has the setup and the conventions. Please follow the [code of conduct](CODE_OF_CONDUCT.md), and report security problems privately as [SECURITY.md](SECURITY.md) explains.

## License

[MIT](LICENSE)
