import type { TFunction } from "i18next";

/** What a back link on the next page should say to return to `pathname`: the name of a top-level
 *  page, the kind of a trip or album (callers that know its name pass that instead), or a plain
 *  "Back" for any other page (a species, say) the link would also return to. */
export function backLabelFor(pathname: string, t: TFunction): string {
  if (pathname === "/") return t("nav.collection");
  if (pathname.startsWith("/import")) return t("import.bulk.title");
  if (pathname.startsWith("/stats")) return t("nav.stats");
  if (pathname.startsWith("/gallery")) return t("nav.gallery");
  if (pathname.startsWith("/trips/")) return t("nav.trip");
  if (pathname.startsWith("/albums/")) return t("nav.album");
  if (pathname.startsWith("/albums") || pathname.startsWith("/trips")) return t("nav.albumsAndTrips");
  if (pathname.startsWith("/settings")) return t("nav.settings");
  return t("nav.back");
}

/** Link state for leaving `location`: the next page's back link names it (or says `label`), and
 *  returns to it (search and filters included) even without an earlier history entry to go back to. */
export function backStateFor(location: { pathname: string; search: string }, t: TFunction, label?: string) {
  return { backLabel: label ?? backLabelFor(location.pathname, t), backTo: location.pathname + location.search };
}
