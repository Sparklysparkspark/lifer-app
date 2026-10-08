import type { TFunction } from "i18next";

/** What a back link on the next page should say to return to `pathname`: the name of a top-level
 *  page, or a plain "Back" for any other page (a species, an album) the link would also return to. */
export function backLabelFor(pathname: string, t: TFunction): string {
  if (pathname === "/") return t("nav.collection");
  if (pathname.startsWith("/import")) return t("import.bulk.title");
  if (pathname.startsWith("/stats")) return t("nav.stats");
  if (pathname.startsWith("/gallery")) return t("nav.gallery");
  if (pathname.startsWith("/albums") || pathname.startsWith("/trips")) return t("nav.albumsAndTrips");
  if (pathname.startsWith("/settings")) return t("nav.settings");
  return t("nav.back");
}
