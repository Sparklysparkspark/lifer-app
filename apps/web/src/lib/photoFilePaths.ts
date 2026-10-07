/** The stored files for a photo, for LightboxSlide.info.files: the main original and its RAW,
 *  without repeats (a RAW-only photo has the same file as both). */
export function photoFilePaths(...refs: Array<string | null | undefined>): string[] {
  return [...new Set(refs.filter((r): r is string => !!r))];
}
