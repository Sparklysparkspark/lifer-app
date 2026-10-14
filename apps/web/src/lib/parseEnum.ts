/** `value` when it's one of `allowed`, else `fallback`: for URL params and stored choices, which
 *  can hold anything (an old bookmark, a hand-edited link). */
export function parseEnum<T extends string>(value: string | null | undefined, allowed: readonly T[], fallback: T): T {
  return value != null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}
