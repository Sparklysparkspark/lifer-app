// Lifer's layout standard as class names. The sizes themselves live in src/theme.css (the design
// tokens), so tweaking one there changes every page. Use these and components/Card.tsx instead of
// picking paddings and gaps per page.

/** A page's content area: page padding, section gaps between its children. */
export const PAGE_BODY = "p-page space-y-section";
/** Between sections of a page (when the container isn't PAGE_BODY). */
export const SECTION_GAP = "gap-section";
/** Between related items: cards in a grid, a photo and its panel, fields in a group. */
export const ITEM_GAP = "gap-item";
/** The app's panel, as components/Card.tsx draws it, for containers that can't use Card itself. */
export const PANEL = "rounded-panel border border-line bg-surface p-panel";

/** A spacing token's current size in px, for layout code that has to measure ("item" for
 *  --spacing-item). */
export function spacingPx(token: "page" | "section" | "item" | "panel"): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--spacing-${token}`).trim();
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return value.endsWith("rem") ? parseFloat(value) * rem : parseFloat(value) || 0;
}
