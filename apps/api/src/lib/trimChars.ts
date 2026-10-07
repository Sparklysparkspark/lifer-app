// Trims a set of characters from the ends of a string in linear time. Regexes like /[. ]+$/ look
// equivalent but backtrack quadratically on a long run of those characters that isn't at the end,
// which a request can supply (CodeQL js/polynomial-redos).

/** `value` without any of `chars` at its end. */
export function trimEndChars(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1])) end--;
  return value.slice(0, end);
}

/** `value` without any of `chars` at its start or end. */
export function trimChars(value: string, chars: string): string {
  let start = 0;
  while (start < value.length && chars.includes(value[start])) start++;
  return trimEndChars(value.slice(start), chars);
}
