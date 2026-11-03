/**
 * Small fuzzy scorer for names like "shop-website" or "Admin-Frontend".
 * Higher is better; -1 means no match.
 *
 *   exact > prefix > start of a word ("web" in "shop-website") > substring > letters in order ("sw")
 */
export function fuzzyScore(query: string, target: string): number {
  const q = normalize(query);
  const t = normalize(target);
  if (!q) return 0;
  if (!t) return -1;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 900 - (t.length - q.length);

  const words = splitWords(target).map(normalize);
  if (words.some((w) => w.startsWith(q))) return 700 - (t.length - q.length);

  const acronym = words.map((w) => w[0] ?? "").join("");
  if (acronym.startsWith(q) && q.length >= 2) return 650 - (acronym.length - q.length);

  const idx = t.indexOf(q);
  if (idx >= 0) return 500 - idx - (t.length - q.length) / 10;

  // letters in order, fewer gaps is better
  let ti = 0;
  let gaps = 0;
  let last = -1;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    if (last >= 0) gaps += found - last - 1;
    last = found;
    ti = found + 1;
  }
  return Math.max(1, 300 - gaps * 5 - (t.length - q.length));
}

export interface Ranked<T> {
  item: T;
  score: number;
}

export function fuzzyRank<T>(query: string, items: T[], keys: (item: T) => string[]): Ranked<T>[] {
  const ranked: Ranked<T>[] = [];
  for (const item of items) {
    let best = -1;
    for (const key of keys(item)) best = Math.max(best, fuzzyScore(query, key));
    if (best >= 0) ranked.push({ item, score: best });
  }
  return ranked.sort((a, b) => b.score - a.score);
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s_\-.]+/g, "");
}

/** "Admin-Frontend" -> ["Admin", "Frontend"]; "apiGateway" -> ["api", "Gateway"] */
export function splitWords(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter(Boolean);
}
