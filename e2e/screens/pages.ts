// Every page a HIG review opens, by the name `--pages=` takes. Detail pages need an id from the seed, so they're not listed.
export const PAGES: Record<string, string> = {
  home: "/home",
  collection: "/",
  review: "/review",
  "year-in-review": "/year-in-review",
  explore: "/explore",
  gallery: "/gallery",
  albums: "/albums",
  "albums-all": "/albums?section=albums",
  "trips-all": "/albums?section=trips",
  stats: "/stats",
  tags: "/tags",
  places: "/places",
  import: "/import",
  trash: "/trash",
  inaturalist: "/inaturalist",
  archived: "/archived",
  "hidden-species": "/hidden-species",
  "sensitive-species": "/sensitive-species",
  "archive-health": "/archive-health",
  guide: "/guide",
  "api-keys": "/settings/api-keys",
  ...Object.fromEntries(
    [
      "general",
      "account",
      "species",
      "library",
      "metadata",
      "storage",
      "server",
      "integrations",
      "regions",
      "offline-data",
    ].map((id) => [`settings-${id}`, `/settings/${id}`]),
  ),
};

export const SEEDS = ["extreme", "sparse", "empty"] as const;
export const THEMES = ["light", "dark"] as const;
// Phone width, the 1280 default window, and a 27 inch display.
export const SIZES = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
  { width: 2560, height: 1440 },
] as const;
