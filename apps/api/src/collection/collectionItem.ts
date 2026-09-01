// Shared between GET /collection and GET /regions/:id/species — both compute the same
// per-user card state (spec §1) from the same joined columns, just over a different base
// query (all species vs. one region's species).
import { MEDIA_CACHE_BUST } from "../config.js";
import { TECHNICAL_MAX_DEPTH_M } from "../species/obscurity.js";

export interface CollectionRow {
  species_id: string;
  scientific_name: string;
  common_name: string | null;
  taxon_class?: string;
  family?: string | null;
  reference_photo: string | null;
  reference_credit: string | null;
  /** True when species.reference_thumb_path is populated (a cached local copy of the
   *  reference photo) — lets the card use the fast local route instead of hotlinking
   *  iNaturalist/Commons directly. */
  has_reference_thumb?: boolean;
  tier: string | null;
  /** Only present on GET /regions/:id/species rows (region_species.local_tier) — a
   *  region-scoped rarity read alongside the fixed global tier. */
  local_tier?: string | null;
  /** Only present on GET /regions/:id/species rows (region_species.is_vagrant). Guards
   *  against cases like Costa's Hummingbird reading "uncommon" in BC purely from raw record
   *  count, when those records were actually a single bird chased/photographed by dozens of
   *  birders over ~10 days. True when this species' records in THIS region are concentrated
   *  in very few years rather than spread out — a real vagrancy signature, not a genuine
   *  established presence. */
  is_vagrant?: boolean | null;
  /** species_traits.endemic_country_iso3 — set if this species is only ever recorded
   *  (real GBIF presence) in one of the 258 crawled countries. */
  endemic_country_iso3?: string | null;
  /** species_traits.endemic_region_label — a richer named-place label (e.g. "the Rocky
   *  Mountains") pulled from the species' own description text. Set independently of
   *  endemic_country_iso3 — see verify-and-label-endemics.ts — so a real multi-country
   *  range/basin endemic can carry a label even when it isn't single-country-endemic. */
  endemic_region_label?: string | null;
  /** species_traits.occurrence_count/last_occurrence_year (global GBIF aggregates, migration
   *  036) and depth_min_m (fish only) — the same three columns OBSCURE_SPECIES_SQL already
   *  reads, reused here to derive isGhost/isLost. Deliberately global, not the region-scoped
   *  region_species.is_vagrant flag — a common species turning up as a one-off vagrant
   *  somewhere shouldn't earn either tag; only genuinely sparse global documentation should. */
  occurrence_count?: number | null;
  last_occurrence_year?: number | null;
  depth_min_m?: string | number | null;
  /** user_species.was_ghost_when_collected/was_lost_when_collected (migration 069) — a
   *  permanent snapshot set by a DB trigger the first time this row was ever marked
   *  'collected', independent of the live isGhost/isLost computed above. Lets a species that's
   *  since been rediscovered (no longer live-Ghost/Lost) still show "you helped find this"
   *  instead of that history silently disappearing once fresh occurrence data catches up. */
  was_ghost_when_collected?: boolean | null;
  was_lost_when_collected?: boolean | null;
  state: "collected" | "seen" | null;
  cover_photo_id: string | null;
  card_crop_x: string | number | null;
  card_crop_y: string | number | null;
  card_crop_size: string | number | null;
  has_cover_photo: boolean;
  /** species.reference_focal_x/y (migration 043) — a focal point for the shared reference
   *  photo, not a per-user crop like card_crop_*. Only relevant when showing that reference
   *  photo (i.e. you have no cover photo of your own yet). */
  reference_focal_x?: string | number | null;
  reference_focal_y?: string | number | null;
  /** storage_volumes.label for the cover photo's original, when it's tagged to a registered
   *  external drive (see ~/.claude/plans/multi-drive-storage.md) — null for anything living on
   *  the primary drive, same as any other original with no volume_id. */
  cover_volume_label?: string | null;
}

// Below this many total GBIF records ever, or with no reference photo found by enrichment, a
// species counts as Ghost's "almost nobody's documented this" signal — the inverse of
// OBSCURE_SPECIES_SQL's own occurrence_count<20 threshold, reused as the actual criterion
// instead of an exclusion here.
const GHOST_MAX_OCCURRENCE_COUNT = 20;
// A species not recorded anywhere in this many years counts as Lost — a narrower, purely
// time-based signal distinct from Ghost's documentation-volume one. Species with nothing since
// before 1950 are excluded (already effectively hidden by OBSCURE_SPECIES_SQL's own default —
// Lost is meant to be a visible badge on an otherwise-normal checklist entry, not a second
// hiding mechanism).
const LOST_YEARS_SILENT = 25;
const LOST_MIN_YEAR = 1950;

// maxDepthM: the same per-user recreational/technical depth cutoff obscureSpeciesSql() uses
// (getObscurityPreferences) — a fish beyond YOUR realistic diving range shouldn't earn a Ghost
// badge just because a wider default would've disqualified it; a technical diver's own 120m
// range should count more fish as reachable than a recreational diver's 60m.
export function isGhostSpecies(row: CollectionRow, maxDepthM: number): boolean {
  if (row.occurrence_count == null) return false; // no data yet — never guess
  const depthDisqualified =
    row.taxon_class === "actinopterygii" && row.depth_min_m != null && Number(row.depth_min_m) >= maxDepthM;
  if (depthDisqualified) return false;
  if (row.last_occurrence_year != null && row.last_occurrence_year < LOST_MIN_YEAR) return false; // that's Lost territory, not Ghost
  return row.occurrence_count < GHOST_MAX_OCCURRENCE_COUNT || row.reference_photo == null;
}

export function isLostSpecies(row: CollectionRow): boolean {
  if (row.last_occurrence_year == null) return false;
  const currentYear = new Date().getFullYear();
  return row.last_occurrence_year < currentYear - LOST_YEARS_SILENT && row.last_occurrence_year >= LOST_MIN_YEAR;
}

export function toCollectionItem(row: CollectionRow, maxDepthM: number = TECHNICAL_MAX_DEPTH_M) {
  const state = row.state ?? "unseen";
  const hasOwnCover = state === "collected" && row.has_cover_photo;
  return {
    speciesId: row.species_id,
    scientificName: row.scientific_name,
    commonName: row.common_name,
    taxonClass: row.taxon_class ?? null,
    family: row.family ?? null,
    state,
    tier: row.tier,
    localTier: row.local_tier ?? null,
    vagrant: row.is_vagrant === true,
    endemic: row.endemic_country_iso3 != null || row.endemic_region_label != null,
    isGhost: isGhostSpecies(row, maxDepthM),
    isLost: isLostSpecies(row),
    // "Rediscovered" — was flagged at the moment you collected it, but the live computation
    // above no longer agrees (either fresh occurrence data flowed in for real, or your own
    // depth-threshold preference changed since). A species already showing as isGhost/isLost
    // right now doesn't need a separate rediscovered badge on top of that.
    rediscoveredGhost: row.was_ghost_when_collected === true && !isGhostSpecies(row, maxDepthM),
    rediscoveredLost: row.was_lost_when_collected === true && !isLostSpecies(row),
    coverPhotoUrl: hasOwnCover
      ? `/api/photos/${row.cover_photo_id}/thumb`
      : row.has_reference_thumb
        ? `/api/species/${row.species_id}/reference-photo/thumb?v=${MEDIA_CACHE_BUST}`
        : row.reference_photo,
    coverPhotoCredit: hasOwnCover ? null : row.reference_credit,
    // Only meaningful for your own photo — the external reference thumbnails are already
    // framed by whoever took them, so there's no crop to apply there. Null means "no
    // custom crop saved yet, just center-cover the whole photo."
    cardCropX: hasOwnCover ? numOrNull(row.card_crop_x) : null,
    cardCropY: hasOwnCover ? numOrNull(row.card_crop_y) : null,
    cardCropSize: hasOwnCover ? numOrNull(row.card_crop_size) : null,
    // The inverse gating of cardCrop* above — a focal point on the shared reference photo
    // only means anything when that's actually what's showing (no cover photo of your own).
    referenceFocalX: hasOwnCover ? null : numOrNull(row.reference_focal_x),
    referenceFocalY: hasOwnCover ? null : numOrNull(row.reference_focal_y),
    coverVolumeLabel: hasOwnCover ? (row.cover_volume_label ?? null) : null,
  };
}

function numOrNull(v: unknown): number | null {
  return v == null ? null : Number(v);
}
