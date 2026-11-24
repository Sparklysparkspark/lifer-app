// Per-user card state shared by GET /collection and GET /regions/:id/species.
import type { RarityTier } from "@lifer/shared";
import { MEDIA_CACHE_BUST } from "@lifer/core/config.js";
import { monthlyFromWeekly } from "@lifer/core/species/seasonality.js";
import { TECHNICAL_MAX_DEPTH_M, WELL_DOCUMENTED_MIN_OCCURRENCES } from "../species/obscurity.js";

export interface CollectionRow {
  species_id: string;
  scientific_name: string;
  common_name: string | null;
  aba_code?: string | null;
  ebird_code?: string | null;
  taxon_class?: string;
  family?: string | null;
  /** species.taxon_order, for broad groups like Songbirds or Frogs & Toads. */
  taxon_order?: string | null;
  reference_photo: string | null;
  reference_credit: string | null;
  /** True when a local cached copy of the reference photo exists, so the card avoids hotlinking. */
  has_reference_thumb?: boolean;
  tier: RarityTier | null;
  /** Region-scoped tier, only on GET /regions/:id/species rows. */
  local_tier?: RarityTier | null;
  /** Why a tier is missing or how it was decided (tier_reason, migration 115), worldwide and here. */
  tier_reason?: string | null;
  local_tier_reason?: string | null;
  /** The user's own tier (user_tier_overrides): wins over the computed one on this install. */
  override_tier?: RarityTier | null;
  /** Region rows only: records here are concentrated in very few years, so a single
   *  much-photographed vagrant doesn't read as an established species. */
  is_vagrant?: boolean | null;
  /** Region rows only: an established population here, but not native (migration 085). */
  is_invasive?: boolean | null;
  /** 52 weekly values; most regions only have this, not the monthly column. */
  weekly_frequency?: number[] | null;
  /** Set when the species is only recorded in one country. */
  endemic_country_iso3?: string | null;
  /** Named-place endemic label from the species description, independent of
   *  endemic_country_iso3 so multi-country endemics can carry one too. */
  endemic_region_label?: string | null;
  /** Global GBIF aggregates used to derive isGhost/isLost. Deliberately global so a one-off
   *  regional vagrant of a common species earns neither tag. */
  occurrence_count?: number | null;
  last_occurrence_year?: number | null;
  depth_min_m?: string | number | null;
  /** Snapshot set by a DB trigger when first collected, so a since-rediscovered species can
   *  still show that it was Ghost/Lost at the time. */
  was_ghost_when_collected?: boolean | null;
  was_lost_when_collected?: boolean | null;
  state: "collected" | "seen" | null;
  is_target?: boolean;
  needs_better_photo?: boolean;
  cover_photo_id: string | null;
  card_crop_x: string | number | null;
  card_crop_y: string | number | null;
  card_crop_size: string | number | null;
  has_cover_photo: boolean;
  /** Focal point for the shared reference photo, used only when there is no cover photo. */
  reference_focal_x?: string | number | null;
  reference_focal_y?: string | number | null;
  /** Label of the external drive holding the cover photo's original; null on the primary drive. */
  cover_volume_label?: string | null;
  /** See CollectionItem in packages/shared/src/collection.ts. */
  is_other_taxa?: boolean;
  inat_iconic_taxon?: string | null;
  /** Every year with a non-trashed capture, not just the first, so "big year" filters work. */
  captured_years?: number[] | null;
  /** Seen only because a recording of it exists. */
  heard?: boolean | null;
  /** Collected only through suggested photos (captures/identification.ts). */
  suggested?: boolean | null;
  /** Region rows only: the region (or selected sea zone) the user added this species to by hand,
   *  when the catalog doesn't list it here (regions/checklistAdditions.ts). */
  user_added_region_id?: string | null;
  user_added_region_name?: string | null;
  /** "seaZone" when user_added_region_id is a sea zone; null or absent for a region. */
  user_added_kind?: string | null;
  /** Region rows only: where the user's photos of it were taken (checklist.ts PHOTOGRAPHED_WHERE_SQL). */
  photographed_where?: "here" | "elsewhere" | null;
  /** rawOnlySql: every photo of it is still an unedited RAW. */
  raw_only?: boolean | null;
}

/** A collected species whose every photo is a RAW with no edited version: none beside a RAW and
 *  none linked to one (linked versions are hidden captures, so the second probe finds them).
 *  `user` is the user id's SQL parameter; `s` and `us` are the query's species and user_species. */
export const rawOnlySql = (user: string) => `(us.state = 'collected'
  AND EXISTS (SELECT 1 FROM captures rc JOIN originals ro ON ro.capture_id = rc.id
    WHERE rc.user_id = ${user} AND rc.species_id = s.id AND rc.hidden_at IS NULL AND ro.kind = 'raw')
  AND NOT EXISTS (SELECT 1 FROM captures ec JOIN originals eo ON eo.capture_id = ec.id
    WHERE ec.user_id = ${user} AND ec.species_id = s.id AND ec.hidden_at IS NULL AND eo.kind <> 'raw')
  AND NOT EXISTS (SELECT 1 FROM captures gc JOIN capture_versions gv ON gv.group_capture_id = gc.id AND gv.state = 'linked'
    JOIN originals vo ON vo.capture_id = gv.capture_id
    WHERE gc.user_id = ${user} AND gc.species_id = s.id AND gc.hidden_at IS NULL AND vo.kind <> 'raw'))`;

// Ghost: fewer GBIF records than this, or no reference photo at all. Packs set only the thumb
// path, not reference_photo, so both must be checked.
const GHOST_MAX_OCCURRENCE_COUNT = 20;
// Lost: not recorded anywhere in this many years. Nothing since before 1950 is excluded, since
// OBSCURE_SPECIES_SQL already hides those.
const LOST_YEARS_SILENT = 25;
const LOST_MIN_YEAR = 1950;

// maxDepthM: the user's diving depth cutoff; fish beyond it never count as Ghost.
export function isGhostSpecies(row: CollectionRow, maxDepthM: number): boolean {
  if (row.occurrence_count == null) return false; // no data yet, never guess
  const depthDisqualified =
    row.taxon_class === "actinopterygii" && row.depth_min_m != null && Number(row.depth_min_m) >= maxDepthM;
  if (depthDisqualified) return false;
  if (row.last_occurrence_year != null && row.last_occurrence_year < LOST_MIN_YEAR) return false; // Lost territory, not Ghost
  return (
    row.occurrence_count < GHOST_MAX_OCCURRENCE_COUNT ||
    (row.reference_photo == null && !row.has_reference_thumb && row.occurrence_count < WELL_DOCUMENTED_MIN_OCCURRENCES)
  );
}

export function isLostSpecies(row: CollectionRow): boolean {
  if (row.last_occurrence_year == null) return false;
  const currentYear = new Date().getFullYear();
  return row.last_occurrence_year < currentYear - LOST_YEARS_SILENT && row.last_occurrence_year >= LOST_MIN_YEAR;
}

export function toCollectionItem(row: CollectionRow, maxDepthM: number = TECHNICAL_MAX_DEPTH_M) {
  const state = row.state ?? ("unseen" as const);
  const hasOwnCover = state === "collected" && row.has_cover_photo;
  return {
    speciesId: row.species_id,
    scientificName: row.scientific_name,
    commonName: row.common_name,
    abaCode: row.aba_code ?? null,
    ebirdCode: row.ebird_code ?? null,
    taxonClass: row.taxon_class ?? null,
    family: row.family ?? null,
    taxonOrder: row.taxon_order ?? null,
    state,
    isTarget: row.is_target === true,
    needsBetterPhoto: row.needs_better_photo === true,
    rawOnly: row.raw_only === true,
    // A tier the user set wins: over the local tier where there is one, else over the worldwide one.
    tier: row.override_tier && row.local_tier === undefined ? row.override_tier : row.tier,
    localTier: row.override_tier && row.local_tier !== undefined ? row.override_tier : (row.local_tier ?? null),
    tierReason: row.tier_reason ?? null,
    localTierReason: row.local_tier_reason ?? null,
    tierOverridden: row.override_tier != null,
    vagrant: row.is_vagrant === true,
    introduced: row.is_invasive === true,
    seasonality: monthlyFromWeekly(row.weekly_frequency),
    endemic: row.endemic_country_iso3 != null || row.endemic_region_label != null,
    isGhost: isGhostSpecies(row, maxDepthM),
    isLost: isLostSpecies(row),
    // Rediscovered: flagged when collected, but no longer Ghost/Lost now.
    rediscoveredGhost: row.was_ghost_when_collected === true && !isGhostSpecies(row, maxDepthM),
    rediscoveredLost: row.was_lost_when_collected === true && !isLostSpecies(row),
    coverPhotoUrl: hasOwnCover
      ? `/api/photos/${row.cover_photo_id}/thumb`
      : row.has_reference_thumb
        ? `/api/species/${row.species_id}/reference-photo/thumb?v=${MEDIA_CACHE_BUST}`
        : row.reference_photo,
    coverPhotoCredit: hasOwnCover ? null : row.reference_credit,
    // Crop applies only to your own photo. Null means center-cover.
    cardCropX: hasOwnCover ? numOrNull(row.card_crop_x) : null,
    cardCropY: hasOwnCover ? numOrNull(row.card_crop_y) : null,
    cardCropSize: hasOwnCover ? numOrNull(row.card_crop_size) : null,
    // Focal point applies only when the reference photo is showing.
    referenceFocalX: hasOwnCover ? null : numOrNull(row.reference_focal_x),
    referenceFocalY: hasOwnCover ? null : numOrNull(row.reference_focal_y),
    coverVolumeLabel: hasOwnCover ? (row.cover_volume_label ?? null) : null,
    isOtherTaxa: row.is_other_taxa === true,
    inatIconicTaxon: row.inat_iconic_taxon ?? null,
    capturedYears: row.captured_years ?? null,
    heard: row.heard === true,
    suggested: row.suggested === true,
    ...(row.photographed_where !== undefined && { photographedWhere: row.photographed_where }),
    // Only region rows carry it, so GET /collection items are unchanged.
    ...(row.user_added_region_id !== undefined && {
      userAddedRegion: row.user_added_region_id
        ? {
            id: row.user_added_region_id,
            name: row.user_added_region_name ?? "",
            kind: row.user_added_kind === "seaZone" ? ("seaZone" as const) : ("region" as const),
          }
        : null,
    }),
  };
}

function numOrNull(v: unknown): number | null {
  return v == null ? null : Number(v);
}
