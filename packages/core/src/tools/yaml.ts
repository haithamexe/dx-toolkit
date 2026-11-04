/**
 * A small YAML reader for API specs: block mappings and sequences, plain and quoted scalars,
 * | and > block text, flow [..] and {..}, comments. Not anchors, aliases or tags: an OpenAPI file
 * that uses them is better given as JSON. Core has no dependencies, so no YAML package.
 */

export class YamlError extends Error {}

interface Line {
  indent: number;
  text: string;
  no: number;
}

export function parseYaml(source: string): unknown {
  const lines: Line[] = [];
  source
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      if (/^\s*(---|\.\.\.)\s*$/.test(raw) && lines.length === 0) return;
      if (/^%/.test(raw)) return;
      const text = stripComment(raw);
      if (!text.trim()) return lines.push({ indent: -1, text: "", no: i + 1 }) && undefined;
      lines.push({ indent: raw.length - raw.trimStart().length, text: text.trim(), no: i + 1 });
    });
  // Blank lines matter only inside block text; elsewhere they're skipped.
  const p = new Parser(lines);
  p.skipBlank();
  if (p.done()) return null;
  return p.node(p.peek().indent);
}

/** Drops a # comment: at the start, or after a space, and not inside quotes. */
function stripComment(raw: string): string {
  let quote = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === quote && !(quote === '"' && raw[i - 1] === "\\")) quote = "";
    } else if (c === '"' || c === "'") {
      // A quote only starts a quoted scalar at the start of a value.
      const before = raw.slice(0, i).trimEnd();
      if (before === "" || /[:\-[{,]$/.test(before)) quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(raw[i - 1]))) {
      return raw.slice(0, i).trimEnd();
    }
  }
  return raw.trimEnd();
}

class Parser {
  i = 0;
  constructor(private lines: Line[]) {}

  done(): boolean {
    this.skipBlank();
    return this.i >= this.lines.length;
  }
  peek(): Line {
    return this.lines[this.i];
  }
  skipBlank(): void {
    while (this.i < this.lines.length && this.lines[this.i].indent < 0) this.i++;
  }

  node(indent: number): unknown {
    this.skipBlank();
    const line = this.peek();
    if (!line || line.indent < indent) return null;
    if (isSeqItem(line.text)) return this.sequence(line.indent);
    if (keyOf(line.text)) return this.mapping(line.indent);
    // A scalar on its own line (a value continued below its key).
    this.i++;
    return this.scalarWithContinuation(line.text, line.indent - 1);
  }

  sequence(indent: number): unknown[] {
    const out: unknown[] = [];
    while (!this.done()) {
      const line = this.peek();
      if (line.indent !== indent || !isSeqItem(line.text)) break;
      const rest = line.text.replace(/^-\s?/, "");
      if (!rest) {
        this.i++;
        this.skipBlank();
        out.push(!this.done() && this.peek().indent > indent ? this.node(this.peek().indent) : null);
      } else if (keyOf(rest) || isSeqItem(rest)) {
        // "- key: value" opens a mapping whose keys line up with "key".
        const offset = line.text.length - rest.length;
        this.lines[this.i] = { indent: indent + offset, text: rest, no: line.no };
        out.push(this.node(indent + offset));
      } else {
        this.i++;
        out.push(this.value(rest, indent));
      }
    }
    return out;
  }

  mapping(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    while (!this.done()) {
      const line = this.peek();
      if (line.indent !== indent) {
        if (line.indent > indent) throw new YamlError(`Line ${line.no}: unexpected indentation.`);
        break;
      }
      const k = keyOf(line.text);
      if (!k) break;
      this.i++;
      if (k.key === "<<") throw new YamlError(`Line ${line.no}: merge keys (<<) aren't supported; give the spec as JSON.`);
      const rest = k.rest;
      if (!rest) {
        this.skipBlank();
        const next = this.done() ? undefined : this.peek();
        if (next && next.indent > indent) out[k.key] = this.node(next.indent);
        else if (next && next.indent === indent && isSeqItem(next.text)) out[k.key] = this.sequence(indent);
        else out[k.key] = null;
      } else {
        out[k.key] = this.value(rest, indent);
      }
    }
    return out;
  }

  /** The value after "key:" or "- ": block text, flow collections, or a scalar (maybe continued below). */
  value(rest: string, indent: number): unknown {
    if (/^[|>][-+0-9]*$/.test(rest)) return this.blockText(rest, indent);
    if (/^[&*!]/.test(rest)) throw new YamlError(`Line ${this.lines[this.i - 1]?.no}: anchors, aliases and tags aren't supported; give the spec as JSON.`);
    if (rest.startsWith("[") || rest.startsWith("{")) {
      let text = rest;
      while (!balanced(text) && this.i < this.lines.length) {
        const l = this.lines[this.i++];
        if (l.indent >= 0) text += ` ${l.text}`;
      }
      return parseFlow(text);
    }
    return this.scalarWithContinuation(rest, indent);
  }

  scalarWithContinuation(first: string, indent: number): unknown {
    let text = first;
    // A plain scalar may go on over more-indented lines, joined with spaces.
    if (!/^["']/.test(first)) {
      while (this.i < this.lines.length) {
        const l = this.lines[this.i];
        if (l.indent < 0) {
          this.i++;
          continue;
        }
        if (l.indent <= indent || keyOf(l.text) || isSeqItem(l.text)) break;
        text += ` ${l.text}`;
        this.i++;
      }
    } else if (!closedQuote(first)) {
      while (this.i < this.lines.length && !closedQuote(text)) {
        const l = this.lines[this.i++];
        text += l.indent < 0 ? "\n" : ` ${l.text}`;
      }
    }
    return scalar(text);
  }

  blockText(header: string, indent: number): string {
    const folded = header.startsWith(">");
    const keep = header.includes("+");
    const strip = header.includes("-");
    const body: Array<string | null> = [];
    let base = -1;
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      if (l.indent >= 0 && l.indent <= indent) break;
      if (l.indent >= 0 && base < 0) base = l.indent;
      body.push(l.indent < 0 ? null : " ".repeat(Math.max(0, l.indent - base)) + l.text);
      this.i++;
    }
    while (body.length && body[body.length - 1] === null) body.pop();
    const lines = body.map((l) => l ?? "");
    let text = folded ? lines.reduce((acc, l, i) => (i === 0 ? l : l === "" || lines[i - 1] === "" || /^\s/.test(l) ? `${acc}\n${l}` : `${acc} ${l}`), "") : lines.join("\n");
    if (!strip) text += "\n";
    if (keep) text += "";
    return text;
  }
}

function isSeqItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

/** "key: value" (the key plain or quoted), or undefined when the line isn't a key. */
function keyOf(text: string): { key: string; rest: string } | undefined {
  const quoted = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(?:\s+(.*)|$)/.exec(text);
  if (quoted) return { key: String(scalar(quoted[1])), rest: (quoted[2] ?? "").trim() };
  if (/^[[{"'|>]/.test(text) || isSeqItem(text)) return undefined;
  const m = /^([^#][^:]*?|[^#]*?:[^\s][^:]*?)\s*:(?:\s+(.*)|$)/.exec(text);
  if (!m) return undefined;
  return { key: m[1], rest: (m[2] ?? "").trim() };
}

function closedQuote(text: string): boolean {
  const q = text[0];
  if (q === '"') return /^"(?:[^"\\]|\\.)*"\s*$/s.test(text);
  if (q === "'") return /^'(?:[^']|'')*'\s*$/s.test(text);
  return true;
}

function balanced(text: string): boolean {
  let depth = 0;
  let quote = "";
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
  }
  return depth <= 0;
}

/** A scalar's value: quoted text, a number, true/false, null, or plain text. Keys stay text. */
export function scalar(raw: string): unknown {
  const s = raw.trim();
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s.replace(/\n/g, "\\n").replace(/\\x([0-9a-fA-F]{2})/g, "\\u00$1").replace(/\\'/g, "'"));
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s === "" || s === "~" || /^null$/i.test(s)) return null;
  if (/^true$/i.test(s)) return true;
  if (/^false$/i.test(s)) return false;
  if (/^[-+]?(\d+|\d*\.\d+|\d+\.\d*)([eE][-+]?\d+)?$/.test(s) && !/^0\d/.test(s)) return Number(s);
  if (/^0x[0-9a-f]+$/i.test(s)) return Number.parseInt(s, 16);
  return s;
}

/** [a, b, {c: d}] and {a: 1, b: [x]}, on one (joined) line. */
function parseFlow(text: string): unknown {
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const value = (): unknown => {
    ws();
    if (text[i] === "[") {
      i++;
      const out: unknown[] = [];
      ws();
      if (text[i] === "]") return i++, out;
      while (i < text.length) {
        out.push(value());
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "]") return i++, out;
        else throw new YamlError(`Expected , or ] in ${text.slice(0, 60)}`);
      }
      throw new YamlError(`Unclosed [ in ${text.slice(0, 60)}`);
    }
    if (text[i] === "{") {
      i++;
      const out: Record<string, unknown> = {};
      ws();
      if (text[i] === "}") return i++, out;
      while (i < text.length) {
        const k = String(atom(":,}") ?? "");
        ws();
        let v: unknown = null;
        if (text[i] === ":") {
          i++;
          v = value();
        }
        out[k] = v;
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "}") return i++, out;
        else throw new YamlError(`Expected , or } in ${text.slice(0, 60)}`);
      }
      throw new YamlError(`Unclosed { in ${text.slice(0, 60)}`);
    }
    return atom(",]}");
  };
  const atom = (stops: string): unknown => {
    ws();
    const start = i;
    if (text[i] === '"' || text[i] === "'") {
      const q = text[i++];
      while (i < text.length && !(text[i] === q && text[i - 1] !== "\\")) i++;
      i++;
      return scalar(text.slice(start, i));
    }
    while (i < text.length && !stops.includes(text[i]) && !(text[i] === ":" && /\s/.test(text[i + 1] ?? " ") && stops.includes(","))) i++;
    return scalar(text.slice(start, i));
  };
  const out = value();
  return out;
}
