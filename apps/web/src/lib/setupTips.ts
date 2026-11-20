// Cards shown while setup works: what Lifer does, one sentence each. They reuse the tour's copy
// where the two overlap, so the tour and the setup screen can't drift apart.

export interface SetupTip {
  id: string;
  /** Locale keys. */
  title: string;
  body: string;
  /** A sidebar icon (AppSidebar ICONS). */
  icon: "collection" | "review" | "search" | "map" | "gallery";
  /** Its guide page, for docsUrl(). */
  guide: string;
}

export const SETUP_TIPS: SetupTip[] = [
  {
    id: "collection",
    title: "tour.collection.title",
    body: "tour.collection.body",
    icon: "collection",
    guide: "/guides/collection-and-checklists",
  },
  {
    id: "import",
    title: "tour.import.title",
    body: "tour.import.body",
    icon: "review",
    guide: "/guides/importing#choosing-species",
  },
  {
    id: "seen",
    title: "setupTips.seen.title",
    body: "setupTips.seen.body",
    icon: "collection",
    guide: "/guides/collection-and-checklists#card-actions",
  },
  {
    id: "search",
    title: "tour.gallery.title",
    body: "setupTips.search.body",
    icon: "gallery",
    guide: "/guides/gallery-and-search#photo-search",
  },
  { id: "map", title: "tour.map.title", body: "tour.map.body", icon: "map", guide: "/guides/photo-map" },
  {
    id: "keys",
    title: "tour.search.title",
    body: "tour.search.body",
    icon: "search",
    guide: "/guides/gallery-and-search#quick-search",
  },
];

/** How long each card stays before the next, unless the user pages or prefers reduced motion. */
export const SETUP_TIP_MS = 8000;
