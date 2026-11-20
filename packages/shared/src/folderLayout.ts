// The library's folder layout (users.folder_layout): an ordered list of levels, outermost first.
// A level is a folder only when the photo has a value for it; the RAW/Adjusted/Video/Audio folder
// always comes last.
export const FOLDER_LEVELS = [
  // "Wildlife 2024": the by-year layout's own folder name, kept so its paths stay put.
  "wildlifeYear",
  "year",
  "month",
  "date",
  "trip",
  "country",
  "province",
  "place",
  "group",
  "order",
  "family",
  "species",
] as const;
export type FolderLevel = (typeof FOLDER_LEVELS)[number];

export const FOLDER_LAYOUT_PRESETS = {
  species: ["group", "species"],
  taxonomy: ["group", "order", "family", "species"],
  year: ["wildlifeYear", "group", "species"],
  date: ["year", "date"],
  trip: ["trip", "group", "species"],
  location: ["country", "province", "place", "group", "species"],
} as const satisfies Record<string, readonly FolderLevel[]>;
export type FolderLayoutPreset = keyof typeof FOLDER_LAYOUT_PRESETS;

export const DEFAULT_FOLDER_LAYOUT: readonly FolderLevel[] = FOLDER_LAYOUT_PRESETS.species;

/** Levels that come from where a photo was taken or which trip it's in: never added under a
 *  trip's own destination folder, which already says that. */
export const PLACE_FOLDER_LEVELS: ReadonlySet<FolderLevel> = new Set(["trip", "country", "province", "place"]);

/** The preset this layout is, or "custom". */
export function folderLayoutPreset(layout: readonly string[]): FolderLayoutPreset | "custom" {
  const key = layout.join("/");
  const hit = Object.entries(FOLDER_LAYOUT_PRESETS).find(([, levels]) => levels.join("/") === key);
  return hit ? (hit[0] as FolderLayoutPreset) : "custom";
}
