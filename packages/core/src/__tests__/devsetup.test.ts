import assert from "node:assert/strict";
import { test } from "node:test";

// Developer setup checks with stand-in commands and files: what a new Windows, macOS or Linux
// computer is missing, and the exact command that fixes each. Nothing real is read or run.
const { devSetupChecks } = await import("../index.js");

type Run = NonNullable<Parameters<typeof devSetupChecks>[0]>["run"];
const runner = (answers: Record<string, { code?: number; out?: string }>): Run => async (cmd, args) => {
  const a = answers[[cmd, ...args].join(" ")];
  return a ? { code: a.code ?? 0, out: a.out ?? "" } : { code: 127, out: "" };
};
const find = (checks: Awaited<ReturnType<typeof devSetupChecks>>, name: string) => checks.find((c) => c.name === name);

test("a new Windows computer: no git identity, line endings, long paths, GitHub CLI or sign-in", async () => {
  const run = runner({ "git --version": { out: "git version 2.49.0.windows.1" }, "gh --version": { out: "gh version 2.70.0" }, "gh auth status": { code: 1 } });
  const checks = await devSetupChecks({ run, platform: "win32", env: { Path: "C:\\a;C:\\nope1;C:\\nope2;C:\\nope3;C:\\nope4" }, exists: (f) => f === "C:\\a", projectDirs: [], roots: [] });
  assert.deepEqual([find(checks, "Git identity")?.status, find(checks, "Git identity")?.fix], ["warn", 'git config --global user.name "Your Name" && git config --global user.email "you@example.com"']);
  assert.equal(find(checks, "Git line endings")?.fix, "git config --global core.autocrlf true");
  const long = find(checks, "Long paths")!;
  assert.equal(long.status, "warn");
  assert.ok(long.fix?.includes("git config --global core.longpaths true") && long.fix.includes("LongPathsEnabled"), long.fix);
  assert.deepEqual([find(checks, "GitHub CLI")?.status, find(checks, "GitHub CLI")?.fix], ["warn", "gh auth login"]);
  assert.match(find(checks, "PATH")?.detail ?? "", /4 folders on it don't exist/);
});

test("a set up Windows computer is all ok; node in two places is one warning", async () => {
  const run = runner({
    "git --version": { out: "git version 2.49.0.windows.1" },
    "git config --get user.name": { out: "Octo Cat\n" },
    "git config --get user.email": { out: "octocat@example.com\n" },
    "git config --get core.autocrlf": { out: "true\n" },
    "git config --get core.longpaths": { out: "true\n" },
    "reg query HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem /v LongPathsEnabled": { out: "    LongPathsEnabled    REG_DWORD    0x1\n" },
    "gh --version": { out: "gh version 2.70.0" },
    "gh auth status": { out: "Logged in" },
    where: { code: 1 },
    "where node": { out: "C:\\Program Files\\nodejs\\node.exe\r\nC:\\Users\\x\\AppData\\fnm\\node.exe\r\n" },
  });
  const checks = await devSetupChecks({ run, platform: "win32", env: { Path: "C:\\a" }, exists: () => true });
  assert.deepEqual(checks.filter((c) => c.status !== "ok").map((c) => c.name), ["PATH"]);
  assert.match(find(checks, "PATH")?.detail ?? "", /node is installed in 2 places/);
  assert.equal(find(checks, "Git identity")?.detail, "Octo Cat <octocat@example.com>");
});

test("without git nothing else is checked; macOS and Linux warn about autocrlf true, an ssh clone with no key, watchers and WSL", async () => {
  const none = await devSetupChecks({ run: runner({}), platform: "darwin" });
  assert.deepEqual(none.map((c) => [c.name, c.status, c.fix]), [["Git", "fail", "brew install git"]]);

  const run = runner({ "git --version": { out: "git version 2.49.0" }, "git config --get core.autocrlf": { out: "true\n" } });
  const files: Record<string, string> = {
    "/p/api/.git/config": '[remote "origin"]\n\turl = git@github.com:octocat/api.git\n',
    "/proc/sys/fs/inotify/max_user_watches": "8192\n",
    "/proc/version": "Linux version 5.15.0-microsoft-standard-WSL2",
  };
  const checks = await devSetupChecks({ run, platform: "linux", env: { PATH: "/usr/bin" }, home: "/home/x", exists: () => true, list: () => ["config", "known_hosts"], readText: (f) => files[f.replace(/\\/g, "/")], projectDirs: ["/p/api"], roots: ["/mnt/c/code"] });
  assert.equal(find(checks, "Git line endings")?.fix, "git config --global core.autocrlf input");
  assert.equal(find(checks, "SSH key")?.status, "warn");
  assert.match(find(checks, "SSH key")?.fix ?? "", /ssh-keygen -t ed25519/);
  assert.match(find(checks, "File watchers")?.fix ?? "", /fs\.inotify\.max_user_watches=524288/);
  assert.match(find(checks, "WSL")?.detail ?? "", /on the Windows drive/);
  assert.equal(find(checks, "GitHub CLI")?.status, "warn", "a GitHub remote and no gh");
  // With a key (or an agent) the ssh check is fine, and a big watch limit is too.
  const fine = await devSetupChecks({ run, platform: "linux", env: { PATH: "/usr/bin", SSH_AUTH_SOCK: "/tmp/agent" }, home: "/home/x", exists: () => true, list: () => ["id_ed25519"], readText: (f) => ({ ...files, "/proc/sys/fs/inotify/max_user_watches": "524288\n" })[f.replace(/\\/g, "/")], projectDirs: ["/p/api"], roots: ["/home/x/code"] });
  assert.equal(find(fine, "SSH key")?.status, "ok");
  assert.equal(find(fine, "File watchers")?.status, "ok");
  assert.equal(find(fine, "WSL")?.status, "ok");
});
