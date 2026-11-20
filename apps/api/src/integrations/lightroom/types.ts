export type LightroomFlag = "pick" | "reject";

/** One photo's Lightroom values beside what Lifer holds now, so a preview can show conflicts. */
export interface PhotoChange {
  /** Lifer's capture, or null when the file isn't in Lifer. */
  captureId: string | null;
  /** The file as Lightroom knows it. */
  path: string;
  /** 1 to 5; null when Lightroom has no rating. */
  rating: number | null;
  flag: LightroomFlag | null;
  /** Lightroom's colour label name ("Red"), or null. */
  label: string | null;
  /** Keyword names and, per keyword, its path through the hierarchy ("Birds > Herons > Great Blue"). */
  keywords: string[];
  keywordPaths: string[];
  caption: string | null;
  lat: number | null;
  lon: number | null;
  /** Taken time as Lightroom stores it (local, no zone), ISO text. */
  takenAt: string | null;
  /** What Lifer has for the same photo; null when the photo isn't there. */
  current: null | {
    rating: number | null;
    flag: LightroomFlag | null;
    lat: number | null;
    lon: number | null;
    tags: string[];
  };
}

export interface AlbumChange {
  name: string;
  /** Collection sets it sits in, outermost first. */
  path: string[];
  /** Lifer captures in it (hand-picked collections). */
  captureIds: string[];
  /** Photos in the collection that aren't in Lifer. */
  missing: number;
  /** A smart collection's rules as Lifer filters; captureIds is empty for these. */
  rules: import("./smartRules.js").MappedRules | null;
}

export interface Unmapped {
  kind: "smartCollection" | "collection" | "publishService" | "other";
  name: string;
  reason: string;
}

export interface ChangeSet {
  photos: PhotoChange[];
  albums: AlbumChange[];
  unmapped: Unmapped[];
  /** Lightroom photos whose files aren't in Lifer, for in-place import. */
  notInLifer: string[];
  /** Photos in the catalogue, virtual copies left out. */
  total: number;
}
