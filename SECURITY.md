# Security

dx runs on your own computer, and some of what it does is powerful: the dashboard (`dx ui`) can start and stop processes, kill whatever holds a port, and delete `node_modules` and build folders. A hole that lets anything other than you drive those actions is a serious bug.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately instead: on this repository's GitHub page, go to **Security → Report a vulnerability**. Include what an attacker can do, how to reproduce it, and the version or commit you tested.

You'll get a reply within a week. Once it's fixed, the fix is released and the report credited to you, unless you'd rather stay anonymous.

## What counts

Anything that gets around the dashboard's protections, for example:

- a web page, another site or another user on the network driving the dashboard's API;
- reading the per-run token from outside the dashboard's own page;
- making dx act on a folder it didn't find as a project, or delete one that isn't in the cleanup list;
- running a command that didn't come from the project's own `package.json` or `.devrc.json`.

The MCP server and the CLI act as you, with your permissions, by design: an AI tool you connected asking to kill a port is not a vulnerability. Tricking one of them into doing more than the tool says is.

## Supported versions

Only the latest release on `main` gets security fixes.
