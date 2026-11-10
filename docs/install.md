# Install, update and remove

The full version of the README's install section. Back to the [README](../README.md).


dx runs on **Windows, macOS and Linux**. You need **Node 22 or newer** (`node -v`) and git. Then, in a terminal (PowerShell on Windows):

```bash
npm install -g dx-devkit
```

```bash
dx ui
```

That's all. The first time you use dx it sets itself up:
- **Your projects**: it looks in the usual code folders (`~/projects`, `~/code`, `~/dev`, `~/src`, `~/repos`, `~/Documents/GitHub`, `~/Desktop/projects` and similar) and uses the ones you have.
- **Your editor**: the first of VS Code, Cursor, Windsurf, Zed, Sublime Text or JetBrains it finds.
- **Your AI tools**: it adds itself to Claude Code, Claude Desktop, Cursor, Windsurf and VS Code, whichever are installed, and says so. A tool you install later is connected the next time the dashboard starts. `dx setup --undo` takes it all back.

Projects somewhere else? `dx config add-root <folder>`, or add the folder on the dashboard's Settings page. `dx doctor` checks everything, including your developer setup (git's name and email, line endings and long paths on Windows, the GitHub CLI signed in, an SSH key when a project is cloned over ssh, PATH folders that don't exist or two Nodes, the Linux file-watch limit, WSL), and says how to fix what isn't right; your AI tool can run the fixes for you (ask it to "check dx's setup").

- **macOS and Linux**: if `npm install -g` fails with a permissions error, your global npm folder belongs to root. Use a Node version manager (nvm, fnm, Volta) rather than `sudo`.
- **Linux**: `dx port` and `dx kill` need `lsof` (`sudo apt install lsof` or your distro's equivalent). Copying a summary needs `wl-copy` or `xclip`, and "open in a terminal window" uses `x-terminal-emulator`.
- **macOS**: "open in a terminal window" uses Terminal.app; the first time, macOS asks whether your terminal may control it.

> If you switch Node versions with nvm, install dx again on the new version; dx repoints your AI tools at it the next time the dashboard starts.

**Updating**: `dx update`. It stops the dashboard, removes the old install and anything it left behind, and asks before stopping dx processes that AI tools still run, so npm never stops with EEXIST or EPERM. If `dx` itself won't start, `npx -y dx-devkit@latest update` does the same. **Removing**: `dx uninstall`, or **Remove dx** at the bottom of the dashboard's Settings page. Either takes off every kind and version of dx: the npm package or a linked build's link (never the repository itself), the `dx` and `dx-mcp` commands, the dx app with every Electron it installed, Floppy, the Start menu and sign-in shortcuts, dx in your AI tools, and everything still running from dx (the dashboard with the dev servers it runs, AI tools' dx servers). Your settings, journal and history stay in `~/.dx` unless you tick the box (or add `--everything`); your projects are never touched.

**From source**, to change dx itself: clone this repository, then run `npm install` and `npm run link` in it. `npm run link` builds and makes `dx` run this folder's build (rebuilds go live); `npm run unlink` puts the npm package back. Both clean up whichever install was there before. [CONTRIBUTING.md](../CONTRIBUTING.md) has the rest.
