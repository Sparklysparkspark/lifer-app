import type { TFunction } from "i18next";
import type { ApiResponse } from "../../api/client";

export type AlbumSuggestion = ApiResponse<"/albums/suggestions">["suggestions"][number];

/** A suggestion's name in the reader's language. Groups and countries are their own names. */
export function suggestionName(s: AlbumSuggestion, t: TFunction): string {
  const label = s.label ?? "";
  switch (s.kind) {
    case "lifers":
      return t("albums.suggestions.names.lifers");
    case "bestOfYear":
      return t("albums.suggestions.names.bestOfYear", { year: label });
    case "tripHighlights":
      return t("albums.suggestions.names.tripHighlights", { trip: label });
    case "rareAndLegendary":
      return t("albums.suggestions.names.rareAndLegendary");
    case "flight":
      return t("albums.suggestions.names.flight");
    case "behavior":
      return t("albums.suggestions.names.behavior");
    case "environmental":
      return t("albums.suggestions.names.environmental");
    case "groupsOfAnimals":
      return t("albums.suggestions.names.groupsOfAnimals");
    case "goldenHour":
      return t("albums.suggestions.names.goldenHour");
    case "needsRating":
      return t("albums.suggestions.names.needsRating");
    case "missingRegion":
      return t("albums.suggestions.names.missingRegion");
    default:
      return s.name;
  }
}
