// Every translated label that is picked by value, written out as whole keys so a missing one is caught by check:i18n.
export const TIER_LABEL: Record<string, string> = {
  common: "tiers.common",
  occasional: "tiers.occasional",
  uncommon: "tiers.uncommon",
  rare: "tiers.rare",
  legendary: "tiers.legendary",
};
export const ARRANGE_LABEL = {
  common: "collection.arrangeBy.common",
  scientific: "collection.arrangeBy.scientific",
  rarity: "collection.arrangeBy.rarity",
  photographedFirst: "collection.arrangeBy.photographedFirst",
  seenFirst: "collection.arrangeBy.seenFirst",
  targetsFirst: "collection.arrangeBy.targetsFirst",
} as const;
export const GROUP_BY_LABEL = { broad: "collection.groupBy.broad", none: "collection.groupBy.none" } as const;
export const SIZE_LABEL = { large: "collection.size.large", small: "collection.size.small", list: "collection.size.list" } as const;
export const COUNT_LABEL = { all: "stats.count.all", featured: "stats.count.featured", top: "stats.count.top" } as const;
export const PART_LABEL = { targets: "trips.part.targets", photos: "trips.part.photos" } as const;
export const ALBUM_ARRANGE_LABEL = { name: "albums.arrangeBy.name", count: "albums.arrangeBy.count" } as const;
export const NAME_ORDER_LABEL = { common: "settings.namesCommon", scientific: "settings.namesScientific" } as const;
export const VERDICT_TITLE = {
  none: "identify.verdictTitle.none",
  seen: "identify.verdictTitle.seen",
  photographed: "identify.verdictTitle.photographed",
} as const;
export const VERDICT_LINE = {
  none: "identify.verdictLine.none",
  seen: "identify.verdictLine.seen",
  photographed: "identify.verdictLine.photographed",
} as const;
export const MONTH_KEYS = [
  "months.jan",
  "months.feb",
  "months.mar",
  "months.apr",
  "months.may",
  "months.jun",
  "months.jul",
  "months.aug",
  "months.sep",
  "months.oct",
  "months.nov",
  "months.dec",
] as const;
