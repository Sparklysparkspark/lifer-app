/** Just the word: pluralWord(1, "photo") is "photo", pluralWord(2, "photo") is "photos". */
export function pluralWord(count: number, singular: string, plural: string = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

/** Count and word: pluralize(1, "photo") is "1 photo", pluralize(1200, "species", "species") is "1,200 species". */
export function pluralize(count: number, singular: string, plural?: string): string {
  return `${count.toLocaleString()} ${pluralWord(count, singular, plural)}`;
}
