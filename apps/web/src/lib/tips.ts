// In-app tips: one short line about something a screen can do that nothing on it shows (keyboard
// flows, mostly), shown once, the first time the screen is usable. Each line is a key or two and
// what it does; the words are translated (locales tips.*), the keys aren't.

export type TipId =
  | "import-keys"
  | "viewer-keys"
  | "gallery-select"
  | "collection-select"
  | "similar-group"
  | "smart-album"
  | "trip-dates"
  | "first-map"
  | "photo-versions";

import type { KeyAction } from "./keymap";

export interface TipStep {
  /** Key caps: a keymap action (shown with this platform's label) or literal text ("Shift"). Empty
   *  for a plain sentence. */
  keys: (KeyAction | string)[];
  /** The locale key of what the keys do. */
  text: string;
}

export interface TipDef {
  steps: TipStep[];
  /** Actions that show the tip was learned: pressing one retires it. */
  learn?: KeyAction[];
}

export const TIPS: Record<TipId, TipDef> = {
  "import-keys": {
    steps: [
      { keys: ["previous", "next"], text: "tips.importKeys.choose" },
      { keys: ["confirm"], text: "tips.importKeys.accept" },
      { keys: ["previousGroup", "nextGroup"], text: "tips.importKeys.move" },
    ],
    learn: ["previous", "next", "previousGroup", "nextGroup", "confirm"],
  },
  "viewer-keys": {
    steps: [
      { keys: ["previous", "next"], text: "tips.viewerKeys.next" },
      { keys: ["1–5"], text: "tips.viewerKeys.rate" },
      { keys: [], text: "tips.viewerKeys.zoom" },
      { keys: ["zoomFit"], text: "tips.viewerKeys.fit" },
    ],
    learn: ["previous", "next", "rate1", "rate2", "rate3", "rate4", "rate5"],
  },
  "gallery-select": {
    steps: [
      { keys: ["Shift"], text: "tips.gallerySelect.range" },
      { keys: ["selectAll"], text: "tips.gallerySelect.all" },
    ],
    learn: ["selectAll"],
  },
  "collection-select": {
    steps: [
      { keys: ["Shift"], text: "tips.collectionSelect.range" },
      { keys: [], text: "tips.collectionSelect.group" },
    ],
  },
  "similar-group": { steps: [{ keys: [], text: "tips.similarGroup.compare" }] },
  "smart-album": { steps: [{ keys: [], text: "tips.smartAlbum.rules" }] },
  "trip-dates": { steps: [{ keys: [], text: "tips.trip.dates" }] },
  "first-map": { steps: [{ keys: [], text: "tips.map.pins" }] },
  "photo-versions": {
    steps: [
      { keys: [], text: "tips.photoVersions.badge" },
      { keys: ["versionPrevious", "versionNext"], text: "tips.photoVersions.switch" },
    ],
    learn: ["versionPrevious", "versionNext"],
  },
};

/** Set only by the dev desktop rebuild (VITE_TIPS_ALWAYS=1): every tip shows on every visit,
 *  whether or not it's been seen, so tips can be written and refined. Never set for a release. */
export const TIPS_ALWAYS = import.meta.env.VITE_TIPS_ALWAYS === "1";
