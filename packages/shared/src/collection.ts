// Response shape for GET /api/collection: one row per species, with the viewing user's state
// computed server-side.

import type { RarityTier, TaxonClass } from "./species.js";
import type { CollectionState } from "./user.js";

export interface CollectionItem {
  speciesId: string;
  scientificName: string;
  commonName: string | null;
  /** The species' taxon; null only for rows without one. */
  taxonClass: TaxonClass | null;
  /** For grouping the grid into folk-style sections ("Sparrows", "Hawks & Eagles"); see
   *  apps/web/src/lib/speciesGroups.ts. Null for species with no family on file. */
  family: string | null;
  /** Taxonomic order (Passeriformes, Anura), for broad groups like Songbirds or Frogs & Toads. */
  taxonOrder?: string | null;
  state: CollectionState;
  /** Independent of state (migration 090): a collected species can still be a target for a
   *  better photo. */
  isTarget: boolean;
  tier: RarityTier | null;
  /** Region-scoped rarity against the rest of the viewed region's checklist, immune to the
   *  per-country effort skew of the global tier. Only set on GET /regions/:id/species rows. */
  localTier: RarityTier | null;
  /** Why the worldwide / local tier is missing or how it was decided (packages/shared
   *  tierExplain.ts TierReason), e.g. "thin_data" shows as "Not enough data". */
  tierReason?: string | null;
  localTierReason?: string | null;
  /** The user set their own tier here (or everywhere); `localTier`, or `tier` outside a region, is it. */
  tierOverridden?: boolean;
  /** The species was split and some of your photos under it can't be settled by where they were
   *  taken (apps/api species/speciesSplits.ts): the card asks which it is instead of showing tags. */
  nameChanged?: boolean;
  /** Records in the viewed region cluster in very few years (a vagrancy signature, e.g. one
   *  chased bird). Informational only, like `endemic`. Only set on GET /regions/:id/species rows. */
  vagrant: boolean;
  /** 52 weekly relative-frequency values for the viewed region (region_species.seasonality), for
   *  sorting by "most likely this week". Only on GET /regions/:id/species rows; null from
   *  GET /collection. */
  seasonality: number[] | null;
  /** Every calendar year with a non-trashed capture of this species, for big-year counts.
   *  Null if never captured. */
  capturedYears: number[] | null;
  /** True if this species is only ever recorded (real GBIF presence) in exactly one of the
   *  258 countries the elusiveness crawl covers. Which country isn't carried here (grid
   *  cards don't need it); the species detail page resolves the name. */
  endemic: boolean;
  /** Sparse global GBIF documentation but verified reachable (not deep-sea, not silent since
   *  before 1950); thresholds in collectionItem.ts's isGhostSpecies. Distinct from isLost and
   *  from Hide Obscure, which hides unreachable species. */
  isGhost: boolean;
  /** Nothing recorded anywhere (global GBIF) in 25+ years, but not so old (pre-1950) that it's
   *  already covered by Hide Obscure's own default exclusion. */
  isLost: boolean;
  /** Was isGhost when collected (migration 069's trigger snapshot) but no longer is: the
   *  "you helped find this" story. Never true alongside isGhost. */
  rediscoveredGhost: boolean;
  /** Same idea as rediscoveredGhost, for isLost. */
  rediscoveredLost: boolean;
  /** The user's cover photo (collected) or the Phase-1 reference photo (seen/unseen). */
  coverPhotoUrl: string | null;
  coverPhotoCredit: string | null;
  /** Square crop for the card thumbnail, as fractions (0-100) of the photo's width, including
   *  cardCropY (see migration 006). Null means a plain centered object-fit:cover. */
  cardCropX: number | null;
  cardCropY: number | null;
  cardCropSize: number | null;
  /** Focal point (fractions 0-100) for the shared reference photo (migration 043), applied via
   *  object-position so it fits any box shape. Null unless coverPhotoUrl is the reference photo. */
  referenceFocalX: number | null;
  referenceFocalY: number | null;
  /** External drive label (storage_volumes.label) holding the cover original. Null on the
   *  primary drive. Shown only when more than one drive is in use. */
  coverVolumeLabel: string | null;
  /** Added via Settings > Species & Import's "any taxa" search (insects, plants, fungi, ...).
   *  Shown in an "Other Taxa" section and never has rarity data (see migration 089). */
  isOtherTaxa: boolean;
  /** iNaturalist's coarse grouping (e.g. "Insecta") for an isOtherTaxa species, used as a
   *  sub-heading. Null for ordinary species. */
  inatIconicTaxon: string | null;
}

// Response shape for GET /api/collection/stats (spec §9 Phase 4).
export interface CollectionStats {
  totalCollected: number;
  byTier: Record<RarityTier, number>;
  byFamily: Array<{ family: string; count: number }>;
  byYear: Array<{ year: number; count: number }>;
}
