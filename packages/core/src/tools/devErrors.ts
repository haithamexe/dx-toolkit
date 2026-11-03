/**
 * Finds errors in a dev server's output as it streams: TypeScript, Vite and esbuild, webpack and
 * Next.js, Node stack traces, Python tracebacks, Go panics and plain "Error:" lines. Lines that
 * follow an error (stack frames, code frames) are grouped into it, its file:line is pulled out,
 * and when the server rebuilds cleanly afterwards the error is marked resolved.
 */

export interface OutputLine {
  /** Increasing line number, as the dev server manager numbers them. */
  n: number;
  stream: "out" | "err" | "dx";
  text: string;
}

export interface DevError {
  /** Stable for the same error in the same place, so repeats are counted instead of listed. */
  id: string;
  kind: "typescript" | "build" | "runtime" | "python" | "go" | "exit" | "error";
  message: string;
  file?: string;
  line?: number;
  column?: number;
  /** The error's own lines: the message, then stack or code frame (at most 30). */
  lines: string[];
  count: number;
  firstLine: number;
  lastLine: number;
  firstSeen: string;
  lastSeen: string;
  /** True once the server rebuilt or reloaded cleanly after the error was last seen. */
  resolved: boolean;
  /** The stack service whose output it came from. */
  service?: string;
}

interface Start {
  kind: DevError["kind"];
  message: string;
  file?: string;
  line?: number;
  column?: number;
  /** Python tracebacks run until the exception line, whatever the indentation. */
  untilException?: boolean;
  /** The message is on the next line. */
  needsMessage?: boolean;
}

const MAX_BLOCK = 30;
const MAX_ERRORS = 200;

/** A line that starts an error, or undefined. */
export function matchErrorStart(text: string): Start | undefined {
  let m: RegExpExecArray | null;
  // tsc: src/a.ts(12,5): error TS2322: Type …   and the pretty form: src/a.ts:12:5 - error TS2322: …
  if ((m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(text))) {
    return { kind: "typescript", file: m[1].trim(), line: +m[2], column: +m[3], message: `${m[4]}: ${m[5]}` };
  }
  if ((m = /^(.+?):(\d+):(\d+) - error (TS\d+): (.*)$/.exec(text))) {
    return { kind: "typescript", file: m[1].trim(), line: +m[2], column: +m[3], message: `${m[4]}: ${m[5]}` };
  }
  // Go compiler: ./main.go:12:5: undefined: foo
  if ((m = /^(\.{0,2}\/?[\w./\\-]+\.go):(\d+):(\d+): (.*)$/.exec(text))) {
    return { kind: "go", file: m[1], line: +m[2], column: +m[3], message: m[4] };
  }
  if ((m = /^panic: (.*)$/.exec(text))) return { kind: "go", message: `panic: ${m[1]}` };
  if (/^Traceback \(most recent call last\):/.test(text)) return { kind: "python", message: "Traceback", untilException: true };
  // esbuild / Vite: ✘ [ERROR] Could not resolve "x"
  if ((m = /^\s*(?:✘|X) \[ERROR\] (.*)$/.exec(text))) return { kind: "build", message: m[1] };
  // Vite: [vite] Internal server error: …  /  [plugin:vite:react-babel] …  /  Pre-transform error: …
  // Anchored (after an optional timestamp), so a line of echoed source code that mentions them isn't one.
  const stamp = String.raw`^\s*(?:\d{1,2}:\d{2}:\d{2}(?:\s*[AP]M)?\s+)?`;
  if ((m = new RegExp(`${stamp}\\[vite\\] (?:Internal server error|error|Pre-transform error): (.*)$`, "i").exec(text))) return { kind: "build", message: m[1] };
  if ((m = /^\s*\[plugin:([^\]]+)\] (.*)$/.exec(text))) return { kind: "build", message: `${m[2]} (${m[1]})` };
  if ((m = new RegExp(`${stamp}(?:\\[vite\\] )?Pre-transform error: (.*)$`).exec(text))) return { kind: "build", message: m[1] };
  // webpack / Next.js
  if (/^\s*(?:⨯ )?Failed to compile\.?/.test(text)) return { kind: "build", message: "Failed to compile" };
  if ((m = /^\s*Module not found: (.*)$/.exec(text))) return { kind: "build", message: `Module not found: ${m[1]}` };
  if ((m = /^\s*⨯ (.*)$/.exec(text))) {
    // Next.js prints "⨯ ./src/app/page.tsx:3:1" and the message on the next line.
    const loc = findLocation([m[1]]);
    if (loc && m[1].trim().replace(/^\.\//, "").length <= loc.file.replace(/^\.\//, "").length + 12) {
      return { kind: "build", message: "", needsMessage: true, ...loc };
    }
    return { kind: "build", message: m[1] };
  }
  if ((m = /^\s*ERROR in (.*)$/.exec(text))) return { kind: "build", message: m[1] };
  // Node: TypeError: x is not a function   /   Error [ERR_MODULE_NOT_FOUND]: …   /   Uncaught …
  if ((m = /^\s*(?:Uncaught\s+)?((?:[A-Z]\w*)?(?:Error|Exception))(?: \[\w+\])?: (.*)$/.exec(text))) {
    return { kind: "runtime", message: `${m[1]}: ${m[2]}` };
  }
  if ((m = /^\s*(?:\(node:\d+\) )?(Unhandled(?:Promise)?Rejection\w*):? ?(.*)$/.exec(text))) {
    return { kind: "runtime", message: `${m[1]}${m[2] ? `: ${m[2]}` : ""}` };
  }
  // Anything that says it's an error. Not "0 errors", "error-boundary.tsx" or "errorHandler".
  if ((m = /^\s*(?:\[[^\]]*\]\s*)?(?:ERROR|Error|error)(?:\s*\[[^\]]*\])?\s*[:!-]\s*(.+)$/.exec(text))) {
    return { kind: "error", message: m[1].trim() };
  }
  return undefined;
}

/** A line that belongs to the error above it: stack frames, code frames, indented detail. */
function isContinuation(text: string, untilException: boolean): boolean {
  if (untilException) return true;
  if (!text.trim()) return false;
  return (
    /^\s+/.test(text) ||
    /^\s*at /.test(text) ||
    /^\s*>?\s*\d+\s*\|/.test(text) ||
    /^\s*\|/.test(text) ||
    /^\s*\^+\s*$/.test(text) ||
    /^(?:File|file):/.test(text) ||
    /^goroutine \d+/.test(text) ||
    /\.go:\d+/.test(text) ||
    /^Import trace for requested module:/.test(text)
  );
}

/** A line that says the server rebuilt or reloaded cleanly. */
export function isSuccessLine(text: string): boolean {
  return (
    /\bhmr update\b/i.test(text) ||
    /\bpage reload\b/i.test(text) ||
    /compiled successfully/i.test(text) ||
    /✓ (?:Compiled|Ready)/.test(text) ||
    /\bFound 0 errors\b/.test(text) ||
    /\bready in \d/i.test(text) ||
    /\bbuilt in \d/i.test(text) ||
    /webpack compiled successfully/i.test(text) ||
    /^\s*Compiled\b(?!.*(?:error|warning))/i.test(text)
  );
}

const SOURCE_EXT = "(?:[cm]?[jt]sx?|vue|svelte|astro|mdx?|css|scss|sass|less|html|json|py|go|rs|rb|php|java|kt|cs)";
const LOCATION = new RegExp(`((?:[A-Za-z]:)?[^\\s()'"<>|:]*\\.${SOURCE_EXT}):(\\d+)(?::(\\d+))?`);

/** The first file:line in the error that isn't inside node_modules or Node's own code. */
export function findLocation(lines: string[]): { file: string; line: number; column?: number } | undefined {
  // Python lists the innermost frame last: take the last frame in the user's own code.
  const py = lines
    .map((l) => /File "([^"]+)", line (\d+)/.exec(l))
    .filter((m): m is RegExpExecArray => !!m && !/site-packages|[\\/]lib[\\/]python|^</.test(m[1]));
  if (py.length) return { file: py[py.length - 1][1], line: +py[py.length - 1][2] };
  for (const raw of lines) {
    const text = raw
      .replace(/^\s*at\s+/, "")
      .replace(/file:\/\/\/([A-Za-z]:)/g, "$1")
      .replace(/file:\/\//g, "");
    const m = LOCATION.exec(text);
    if (m && !/node_modules|node:internal|^node:/.test(m[1]) && !/[\\/]\.vite[\\/]deps/.test(m[1])) {
      return { file: m[1], line: +m[2], column: m[3] ? +m[3] : undefined };
    }
  }
  return undefined;
}

/** Feed it every output line; it keeps the errors it found. */
export class ErrorTracker {
  private list: DevError[] = [];
  private open?: { start: Start; lines: string[]; firstLine: number; lastLine: number; blankSeen?: boolean; before: string[] };
  /** The last few lines, because Node prints a SyntaxError's file:line above the error. */
  private recent: string[] = [];

  push(line: OutputLine, now = new Date()): void {
    this.handle(line, now);
    if (line.stream !== "dx") {
      this.recent.push(line.text);
      if (this.recent.length > 6) this.recent.shift();
    }
  }

  private handle(line: OutputLine, now: Date): void {
    const text = line.text;
    if (line.stream === "dx") {
      this.close(now);
      const exit = /^Exited with (.+)\.$/.exec(text);
      if (exit && exit[1] !== "0") this.record({ kind: "exit", message: `The dev server exited with ${exit[1]}` }, [text], line.n, line.n, now);
      return;
    }
    if (this.open) {
      const start = this.open.start;
      if (start.needsMessage && text.trim()) {
        start.message = text.trim();
        start.needsMessage = false;
        this.open.lines.push(text);
        this.open.lastLine = line.n;
        return;
      }
      if (start.untilException) {
        this.open.lines.push(text);
        this.open.lastLine = line.n;
        const exc = /^(\w+(?:\.\w+)*(?:Error|Exception|Exit|Interrupt)\w*)(?:: (.*))?$/.exec(text);
        if (exc) {
          start.message = exc[2] ? `${exc[1]}: ${exc[2]}` : exc[1];
          start.untilException = false;
          this.close(now);
        } else if (this.open.lines.length >= MAX_BLOCK * 2) this.close(now);
        return;
      }
      // esbuild puts a blank line between the message and its location: allow one.
      if (!text.trim() && start.kind === "build" && !start.file && !this.open.blankSeen) {
        this.open.blankSeen = true;
        return;
      }
      if (isContinuation(text, false) && this.open.lines.length < MAX_BLOCK && !matchErrorStart(text.trim())) {
        this.open.lines.push(text);
        this.open.lastLine = line.n;
        // esbuild prints the location on the line after the message.
        if (!start.file) {
          const loc = findLocation([text]);
          if (loc) Object.assign(start, loc);
        }
        return;
      }
      this.close(now);
    }
    if (isSuccessLine(text)) {
      for (const e of this.list) e.resolved = true;
      return;
    }
    const start = matchErrorStart(text);
    if (start) this.open = { start, lines: [text], firstLine: line.n, lastLine: line.n, before: [...this.recent] };
  }

  /** Ends the error being collected; call when the output goes quiet. */
  flush(now = new Date()): void {
    this.close(now);
  }

  /** Errors still current, newest first. `all` includes resolved ones. */
  errors(options: { all?: boolean; after?: number } = {}): DevError[] {
    return this.list
      .filter((e) => (options.all || !e.resolved) && (options.after === undefined || e.lastLine > options.after))
      .sort((a, b) => b.lastLine - a.lastLine);
  }

  clear(): void {
    this.list = [];
    this.open = undefined;
  }

  private close(now: Date): void {
    if (!this.open) return;
    const { start, lines, firstLine, lastLine, before } = this.open;
    this.open = undefined;
    this.record(start, lines, firstLine, lastLine, now, before);
  }

  private record(start: Start, lines: string[], firstLine: number, lastLine: number, now: Date, before: string[] = []): void {
    let loc = start.file ? { file: start.file, line: start.line, column: start.column } : findLocation(lines);
    if (!loc && start.kind === "runtime") {
      // Node's SyntaxError: "path/to/file.js:12" alone on a line, then the code, a caret, a blank line, the error.
      for (let i = before.length - 1; i >= 0; i--) {
        const m = /^((?:[A-Za-z]:)?[^\s()'"<>|:]+\.[A-Za-z0-9]+):(\d+)$/.exec(before[i].trim());
        if (m && !/node_modules|^node:/.test(m[1])) {
          loc = { file: m[1], line: +m[2], column: undefined };
          lines = [lines[0], ...before.slice(i), ...lines.slice(1)];
          break;
        }
      }
    }
    const full = start.message || "Build error";
    const message = full.length > 300 ? full.slice(0, 297) + "…" : full;
    const id = hash(`${start.kind}|${message.replace(/\d+/g, "#")}|${loc?.file ?? ""}:${loc?.line ?? ""}`);
    const at = now.toISOString();
    const existing = this.list.find((e) => e.id === id);
    if (existing) {
      existing.count++;
      existing.lastLine = lastLine;
      existing.lastSeen = at;
      existing.lines = lines.slice(0, MAX_BLOCK);
      existing.resolved = false;
      return;
    }
    this.list.push({
      id,
      kind: start.kind,
      message,
      file: loc?.file,
      line: loc?.line,
      column: loc?.column,
      lines: lines.slice(0, MAX_BLOCK),
      count: 1,
      firstLine,
      lastLine,
      firstSeen: at,
      lastSeen: at,
      resolved: false,
    });
    if (this.list.length > MAX_ERRORS) this.list.splice(0, this.list.length - MAX_ERRORS);
  }
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
