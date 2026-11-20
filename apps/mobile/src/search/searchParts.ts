// The parts of a typed search, shown as removable tokens above the results like the desktop's.
import type { SearchPart } from "@lifer/shared";

export type { SearchPart };

/** The query without one part's words (whatever the case or punctuation between them), or the query unchanged when they can't be found. */
export function removeSearchPart(query: string, part: Pick<SearchPart, "text">): string {
  const words = part.text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return query;
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped.join("[^\\p{L}\\p{N}]+")}(?![\\p{L}\\p{N}])`, "iu");
  if (!pattern.test(query)) return query;
  return query
    .replace(pattern, " ")
    .replace(/\s*,(\s*,)*/g, ",")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,]+|[\s,]+$/g, "");
}
