// What a Lightroom catalogue would change in Lifer, as the preview shows it and as the apply job
// writes it. Pure: nothing here touches the database, so both read the same plan.
import type { AlbumChange, ChangeSet, LightroomFlag, PhotoChange } from "./types.js";

export const GROUPS = ["ratings", "flags", "keywords", "locations", "albums", "smartAlbums"] as const;
export type Group = (typeof GROUPS)[number];

export interface GroupPreview {
  group: Group;
  /** Items the catalogue has for this kind. */
  total: number;
  /** Items that would change something in Lifer. */
  willChange: number;
  /** Items where Lifer already has a different value; Lifer's wins unless the user switches it. */
  conflicts: number;
  samples: string[];
}

export interface Preview {
  total: number;
  matched: number;
  notInLifer: number;
  groups: GroupPreview[];
  unmapped: { kind: string; name: string; reason: string }[];
  /** Colour labels and captions are in the catalogue but have nowhere to go in Lifer. */
  leftOut: { labels: number; captions: number };
}

// About 100 m: a Lightroom point this close to Lifer's counts as the same place.
const SAME_PLACE_DEG = 0.001;
const SAMPLES = 3;

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const samePlace = (p: PhotoChange) =>
  p.current?.lat != null &&
  p.current.lon != null &&
  Math.abs(p.current.lat - p.lat!) < SAME_PLACE_DEG &&
  Math.abs(p.current.lon - p.lon!) < SAME_PLACE_DEG;

/** Tags a photo would gain: its keywords Lifer doesn't have yet. */
const newTags = (p: PhotoChange) => {
  const seen = new Set(p.current?.tags.map((t) => t.toLowerCase()));
  const add: string[] = [];
  for (const k of p.keywords.map((k) => k.trim())) {
    if (k && !seen.has(k.toLowerCase())) {
      seen.add(k.toLowerCase());
      add.push(k);
    }
  }
  return add;
};

export function buildPreview(cs: ChangeSet): Preview {
  const here = cs.photos.filter((p) => p.captureId && p.current);
  const row = (
    group: Group,
    rows: { name: string; change: boolean; conflict: boolean; note: string }[],
  ): GroupPreview => ({
    group,
    total: rows.length,
    willChange: rows.filter((r) => r.change && !r.conflict).length,
    conflicts: rows.filter((r) => r.conflict).length,
    samples: rows
      .filter((r) => r.change)
      .slice(0, SAMPLES)
      .map((r) => `${r.name}: ${r.note}`),
  });

  const ratings = here
    .filter((p) => p.rating != null)
    .map((p) => ({
      name: fileName(p.path),
      change: p.current!.rating !== p.rating,
      conflict: p.current!.rating != null && p.current!.rating !== p.rating,
      note: `${p.rating} star${p.rating === 1 ? "" : "s"}`,
    }));
  const flags = here
    .filter((p) => p.flag)
    .map((p) => ({
      name: fileName(p.path),
      change: p.current!.flag !== p.flag,
      conflict: p.current!.flag != null && p.current!.flag !== p.flag,
      note: p.flag!,
    }));
  const keywords = here
    .filter((p) => p.keywords.length > 0)
    .map((p) => {
      const add = newTags(p);
      return { name: fileName(p.path), change: add.length > 0, conflict: false, note: add.join(", ") };
    });
  const locations = here
    .filter((p) => p.lat != null && p.lon != null)
    .map((p) => ({
      name: fileName(p.path),
      change: !samePlace(p),
      conflict: p.current!.lat != null && !samePlace(p),
      note: `${p.lat!.toFixed(4)}, ${p.lon!.toFixed(4)}`,
    }));
  const albumRows = (smart: boolean) =>
    cs.albums
      .filter((a) => (a.rules !== null) === smart)
      .map((a) => ({
        name: a.name,
        change: true,
        conflict: false,
        note: smart ? "smart album" : `${a.captureIds.length} photos`,
      }));

  return {
    total: cs.total,
    matched: here.length,
    notInLifer: cs.notInLifer.length,
    groups: [
      row("ratings", ratings),
      row("flags", flags),
      row("keywords", keywords),
      row("locations", locations),
      row("albums", albumRows(false)),
      row("smartAlbums", albumRows(true)),
    ],
    unmapped: cs.unmapped,
    leftOut: {
      labels: here.filter((p) => p.label).length,
      captions: here.filter((p) => p.caption).length,
    },
  };
}

export interface CaptureEdit {
  id: string;
  rating?: number;
  flag?: LightroomFlag;
  tags?: string[];
  lat?: number;
  lon?: number;
}

/** Per photo, the values to write for the chosen groups; Lifer's own value is kept unless `lightroomWins`. */
export function planEdits(cs: ChangeSet, groups: ReadonlySet<Group>, lightroomWins: boolean): CaptureEdit[] {
  const edits: CaptureEdit[] = [];
  const seen = new Set<string>();
  for (const p of cs.photos) {
    // A file listed twice (two catalogue entries, one capture) is written once.
    if (!p.captureId || !p.current || seen.has(p.captureId)) continue;
    seen.add(p.captureId);
    const e: CaptureEdit = { id: p.captureId };
    const cur = p.current;
    if (groups.has("ratings") && p.rating != null && cur.rating !== p.rating && (cur.rating == null || lightroomWins))
      e.rating = p.rating;
    if (groups.has("flags") && p.flag && cur.flag !== p.flag && (cur.flag == null || lightroomWins)) e.flag = p.flag;
    if (groups.has("keywords")) {
      const add = newTags(p);
      if (add.length > 0) e.tags = [...cur.tags, ...add];
    }
    if (
      groups.has("locations") &&
      p.lat != null &&
      p.lon != null &&
      !samePlace(p) &&
      (cur.lat == null || lightroomWins)
    ) {
      e.lat = p.lat;
      e.lon = p.lon;
    }
    if (Object.keys(e).length > 1) edits.push(e);
  }
  return edits;
}

export function plannedAlbums(cs: ChangeSet, groups: ReadonlySet<Group>): AlbumChange[] {
  return cs.albums.filter((a) => (a.rules ? groups.has("smartAlbums") : groups.has("albums")));
}
