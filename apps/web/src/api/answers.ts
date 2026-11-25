// What the API client remembers about the answers it parsed: each one's JSON size, so caches
// (lib/resource.ts) can bound themselves by it, and the ETag of the last answer per GET path, so
// asking again sends If-None-Match and a 304 hands back the same object: no parse, no redraw.
// The answer is held weakly, so the page caches alone decide how much stays in memory.

const sizes = new WeakMap<object, number>();
const tagged = new Map<string, { etag: string; data: WeakRef<object> }>();
const TAGGED_MAX = 200;

/** Records a parsed answer: its JSON length and, for a GET with an ETag, the tag. */
export function noteAnswer(path: string, data: object, length: number, etag: string | null): void {
  sizes.set(data, length);
  if (!etag) return;
  tagged.delete(path);
  tagged.set(path, { etag, data: new WeakRef(data) });
  if (tagged.size > TAGGED_MAX) tagged.delete(tagged.keys().next().value!);
}

/** The last tagged answer for a GET path, while something still holds it. */
export function taggedAnswer(path: string): { etag: string; data: object } | null {
  const kept = tagged.get(path);
  const data = kept?.data.deref();
  return kept && data ? { etag: kept.etag, data } : null;
}

/** The size in characters of the JSON an answer was parsed from; 0 when unknown. */
export function answerSize(data: unknown): number {
  return data && typeof data === "object" ? (sizes.get(data) ?? 0) : 0;
}

/** Forgets every kept ETag (on an account change). */
export function forgetTaggedAnswers(): void {
  tagged.clear();
}
