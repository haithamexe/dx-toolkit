/**
 * `fn` over `items`, at most `limit` at a time, results in the items' order. For work that starts a
 * process per item (git for each of 22 projects): all at once would start 22 and slow the computer,
 * one at a time waits for each in turn. A failed item gives `fallback(item, error)`, so one bad
 * project doesn't lose the others' answers.
 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>, fallback?: (item: T, error: unknown) => R): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        if (!fallback) throw err;
        out[i] = fallback(items[i], err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
