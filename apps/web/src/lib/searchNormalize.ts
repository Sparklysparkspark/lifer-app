// Shared by every as-you-type search box so they all feel the same.
export const SEARCH_DEBOUNCE_MS = 150;

/** Lowercase, accents and apostrophes dropped, hyphens and other punctuation as spaces:
 * "Rüppell's Warbler" -> "ruppells warbler", so "ruppells" and "ruppell's" both find it. */
export function normalizeForSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Higher is better; -1 means no match. Every query word must appear somewhere in the text. */
export function matchScore(text: string, query: string): number {
  const q = normalizeForSearch(query);
  if (!q) return 0;
  const t = normalizeForSearch(text);
  if (!t) return -1;
  if (t === q) return 4;
  if (t.startsWith(q)) return 3;
  const words = t.split(" ");
  const tokens = q.split(" ");
  if (!tokens.every((tok) => t.includes(tok))) return -1;
  // Each token starting a word reads as a deliberate match ("gr bl her" -> Great Blue Heron).
  if (tokens.every((tok) => words.some((w) => w.startsWith(tok)))) return 2;
  return 1;
}

/** The best matches first, ties kept in their original order. `texts` may return several names per item. */
export function filterByQuery<T>(
  items: readonly T[],
  query: string,
  texts: (item: T) => Array<string | null | undefined>,
  limit = Infinity,
): T[] {
  if (!normalizeForSearch(query)) return items.slice(0, limit);
  const scored: Array<{ item: T; score: number; i: number }> = [];
  items.forEach((item, i) => {
    let best = -1;
    for (const text of texts(item)) if (text) best = Math.max(best, matchScore(text, query));
    if (best >= 0) scored.push({ item, score: best, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, limit).map((s) => s.item);
}
