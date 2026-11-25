import type { LightboxSlide } from "../components/Lightbox";
import type { PhotoMenuPhoto } from "../components/PhotoMenu";
import type { SpeciesResult } from "../components/SpeciesPicker";
import { formatTakenAt } from "./format";
import { photoSlide, type SlidePhoto } from "./photoSlide";

/** What a list of library photos does when one is changed from the viewer. */
export interface LibrarySlideActions {
  rate: (captureId: string, rating: number | null) => void;
  reassign: (captureId: string, from: string | null | undefined, to: SpeciesResult) => void;
  /** After a change the list can't apply itself (location, date and time, versions). */
  changed: () => void;
  /** The photo went to Trash: drop it from the list. */
  deleted: (captureId: string) => void;
}

/** A library photo as the map, album and trip lists have it (Gallery items and trip photos). */
export type LibraryPhoto = SlidePhoto &
  Omit<PhotoMenuPhoto, "rating" | "hasRaw"> & {
    speciesId?: string | null;
    qualityRating?: number | null;
    lat?: number | string | null;
    lon?: number | string | null;
    regionId?: string | null;
    hasRaw?: boolean;
    hasRawOriginal?: boolean;
  };

const num = (v: number | string | null | undefined) => (v == null ? null : Number(v));

/** A library photo as a Lightbox slide, the same wherever a page has no menu of its own (the
 *  map's side panel, hover card and species pins, albums, trips): rating, Correct the ID, location
 *  and the standard ⋯ menu. */
export function librarySlide(i: LibraryPhoto, caption: string, a: LibrarySlideActions): LightboxSlide {
  return photoSlide(i, {
    caption,
    rating: i.qualityRating ?? null,
    onRate: (rating) => a.rate(i.captureId, rating),
    onReassign: (to) => a.reassign(i.captureId, i.speciesId, to),
    coordinates: { lat: num(i.lat), lon: num(i.lon), hasRegion: !!i.regionId, onChange: a.changed },
    photo: { ...i, rating: i.qualityRating, hasRaw: i.hasRawOriginal ?? i.hasRaw },
    onDeleted: () => a.deleted(i.captureId),
    onChanged: a.changed,
    onVersionsChange: a.changed,
  });
}

/** "Bald Eagle, Nov 17, 2026, 7:42 PM": a photo's name where only its thumbnail shows. */
export const slideCaption = (name: string, i: { takenAt: string | null; takenAtZoned?: boolean | null }) =>
  [name, formatTakenAt(i.takenAt, i.takenAtZoned)].filter(Boolean).join(", ");
