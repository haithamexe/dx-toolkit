import { spawn, type SpawnOptions } from "node:child_process";

/** Starts a program without tying it to this process: dx can exit and the program keeps running. */
export function detached(command: string, args: string[], options: SpawnOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const opts: SpawnOptions = { detached: true, stdio: "ignore", windowsHide: false, ...options };
    // With shell: true the whole command line is in `command`; passing an args array as well is deprecated.
    const child = opts.shell ? spawn(command, opts) : spawn(command, args, opts);
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** Quotes one argument for cmd.exe. */
export function winQuote(arg: string): string {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}
