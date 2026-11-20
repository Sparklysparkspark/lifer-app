/** The sidebar's pages in order. Cmd or Ctrl plus the position jumps to one; menu.rs NAV_ITEMS
 *  repeats this order. Plugin pages and later additions never take a number out of turn. */
export const MAIN_PAGE_ROUTES = ["/", "/gallery", "/gallery?view=map", "/albums", "/stats"] as const;

/** The 1-based chord number for a page route, or null when it has none. */
export function pageNumber(route: string): number | null {
  const i = (MAIN_PAGE_ROUTES as readonly string[]).indexOf(route);
  return i < 0 ? null : i + 1;
}
