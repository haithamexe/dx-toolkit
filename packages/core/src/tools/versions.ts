/**
 * Version numbers and the ranges projects write (`engines`, `.nvmrc`, `go.mod`), without a
 * semver package: core has no dependencies. Prerelease tags are ignored.
 */

export type Version = [number, number, number];

/** The first x.y.z in some text ("v24.1.0", "Python 3.13.5", "go1.22.1", `openjdk version "21"`). */
export function parseVersion(text: string): string | undefined {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text) ?? /\bversion "?(\d+)"?/.exec(text);
  if (!m) return undefined;
  let [major, minor, patch] = [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
  // Java 8 and older call themselves 1.8.0.
  if (major === 1 && /java|jdk/i.test(text) && minor >= 5) [major, minor, patch] = [minor, patch, Number(/_(\d+)/.exec(text)?.[1] ?? 0)];
  return `${major}.${minor}.${patch}`;
}

export function toVersion(v: string): Version {
  const parts = v.replace(/^v/i, "").split(/[.+-]/).map((p) => Number.parseInt(p, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

export function compareVersions(a: string, b: string): number {
  const x = toVersion(a);
  const y = toVersion(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

export function majorOf(v: string): number {
  return toVersion(v)[0];
}

/** Node's long-term-support lines by codename, for `.nvmrc` files like `lts/iron`. */
export const NODE_LTS_CODENAMES: Record<string, number> = {
  argon: 4,
  boron: 6,
  carbon: 8,
  dubnium: 10,
  erbium: 12,
  fermium: 14,
  gallium: 16,
  hydrogen: 18,
  iron: 20,
  jod: 22,
  krypton: 24,
};

/**
 * Whether `version` meets `range`. Understands `||`, `a - b`, `>= < <= > =`, `^`, `~`, `x`/`*`,
 * partial versions ("20" is any 20.x) and the `.nvmrc` words (`lts/*`, `lts/iron`, `node`).
 * Undefined when the range can't be read: that's not a mismatch.
 */
export function satisfies(version: string, range: string): boolean | undefined {
  const r = range.trim().toLowerCase();
  if (!r || r === "*" || r === "x" || r === "latest" || r === "node" || r === "current" || r === "stable" || r === "system") return true;
  const major = majorOf(version);
  if (r === "lts/*" || r === "lts" || r === "lts/-1") return major % 2 === 0 && major >= 4;
  if (r.startsWith("lts/")) {
    const m = NODE_LTS_CODENAMES[r.slice(4)];
    return m === undefined ? undefined : major === m;
  }
  const alternatives = r.split("||").map((s) => s.trim());
  let readable = false;
  for (const alt of alternatives) {
    const result = satisfiesAll(version, alt);
    if (result === undefined) continue;
    readable = true;
    if (result) return true;
  }
  return readable ? false : undefined;
}

function satisfiesAll(version: string, range: string): boolean | undefined {
  if (!range || range === "*" || range === "x") return true;
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(range);
  if (hyphen) {
    const lo = bounds(">=", hyphen[1]);
    const hi = bounds("<=", hyphen[2]);
    if (!lo || !hi) return undefined;
    return [...lo, ...hi].every((c) => test(version, c));
  }
  const comparators = range.replace(/([<>]=?|=|\^|~)\s+/g, "$1").split(/\s+/).filter(Boolean);
  const all: Comparator[] = [];
  for (const c of comparators) {
    const m = /^(>=|<=|>|<|=|\^|~>?|v)?v?(.*)$/.exec(c);
    if (!m) return undefined;
    const b = bounds(m[1] ?? "", m[2]);
    if (!b) return undefined;
    all.push(...b);
  }
  return all.every((c) => test(version, c));
}

type Comparator = { op: ">=" | "<" | "<=" | ">"; v: Version };

/** A comparator with a partial version turned into plain bounds. */
function bounds(op: string, raw: string): Comparator[] | undefined {
  const parts = raw.replace(/^v/, "").split(".");
  if (!parts[0] || parts.length > 3) return undefined;
  const nums: number[] = [];
  for (const p of parts) {
    if (p === "x" || p === "*" || p === "X") break;
    const n = Number.parseInt(p, 10);
    if (!Number.isFinite(n)) return undefined;
    nums.push(n);
  }
  if (nums.length === 0) return op === "<" || op === ">" ? [{ op: "<", v: [0, 0, 0] }] : [];
  const [a, b = 0, c = 0] = nums;
  const exact: Version = [a, b, c];
  // The first version past the partial: "20" → 21.0.0, "20.1" → 20.2.0, "20.1.2" → 20.1.3.
  const next: Version = nums.length === 1 ? [a + 1, 0, 0] : nums.length === 2 ? [a, b + 1, 0] : [a, b, c + 1];
  switch (op) {
    case "":
    case "=":
    case "v":
      return [{ op: ">=", v: exact }, { op: "<", v: next }];
    case ">=":
      return [{ op: ">=", v: exact }];
    case ">":
      return [{ op: ">=", v: next }];
    case "<":
      return [{ op: "<", v: exact }];
    case "<=":
      return [{ op: "<", v: next }];
    case "^": {
      const upper: Version = a > 0 || nums.length === 1 ? [a + 1, 0, 0] : b > 0 || nums.length === 2 ? [0, b + 1, 0] : [0, 0, c + 1];
      return [{ op: ">=", v: exact }, { op: "<", v: upper }];
    }
    case "~":
    case "~>":
      return [{ op: ">=", v: exact }, { op: "<", v: nums.length === 1 ? [a + 1, 0, 0] : [a, b + 1, 0] }];
    default:
      return undefined;
  }
}

function test(version: string, c: Comparator): boolean {
  const cmp = compareVersions(version, c.v.join("."));
  if (c.op === ">=") return cmp >= 0;
  if (c.op === ">") return cmp > 0;
  if (c.op === "<") return cmp < 0;
  return cmp <= 0;
}

/** The newest of `candidates` that meets `range`, e.g. which Node line to switch to. */
export function newestSatisfying(candidates: string[], range: string): string | undefined {
  return [...candidates].sort((a, b) => compareVersions(b, a)).find((v) => satisfies(v, range) === true);
}
