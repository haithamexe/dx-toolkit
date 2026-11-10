import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Writes a file so a reader (another dx process, an AI tool's MCP server, a crash half-way) sees
 * either all of the old text or all of the new, never part of it: the text goes to a temporary
 * file next to it, then the temporary file is renamed over it. On Windows a rename onto a file
 * another program has open can fail for a moment, so it's tried a few times; after that the text is
 * written in place (`direct`, the default) or the error is thrown (`direct: false`, for callers that
 * would rather skip than risk the in-place write).
 */
export function writeFileAtomic(file: string, data: string | Uint8Array, options: { mode?: number; direct?: boolean } = {}): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const mode = options.mode;
  try {
    fs.writeFileSync(tmp, data, mode === undefined ? {} : { mode });
    let last: unknown;
    for (let i = 0; i < 5; i++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (err) {
        last = err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") break;
        // Busy for a moment (Windows): wait a few milliseconds without yielding the event loop.
        const until = Date.now() + 15 * (i + 1);
        while (Date.now() < until) {
          /* a short wait */
        }
      }
    }
    if (options.direct === false) throw last;
    fs.writeFileSync(file, data, mode === undefined ? {} : { mode });
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // nothing left to clean
    }
  }
}
