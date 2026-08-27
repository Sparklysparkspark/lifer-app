// Response shape for GET /api/collection — one row per species, with the viewing user's
// state computed server-side (lifer-spec.md §1's three card states).

import type { RarityTier, TaxonClass } from "./species.js";
import type { CollectionState } from "./user.js";

export interface CollectionItem {
  speciesId: string;
  scientificName: string;
  commonName: string | null;
  /** Phase 8: null for rows from before multi-taxon support, otherwise the species' taxon. */
  taxonClass: TaxonClass | null;
  /** For grouping the grid into folk-style sections ("Sparrows", "Hawks & Eagles") — see
   *  apps/web/src/lib/speciesGroups.ts. Null for species with no family on file. */
  family: string | null;
  state: CollectionState;
  tier: RarityTier | null;
  /** Region-scoped rarity — how this species ranks against every other species actually on
   *  the checklist of whichever region is currently being viewed, so a country with
   *  unusually heavy birding effort can't skew it the way the global tier's elusiveness axis
   *  (weighted by total per-country record volume) already can. Only populated on GET
   *  /regions/:id/species rows — always null from GET /collection. */
  localTier: RarityTier | null;
  /** True if this species' records in the currently-viewed region are concentrated in very
   *  few years rather than spread out over time — a real vagrancy signature (e.g. one bird
   *  chased/photographed by dozens of birders over a single event), not a genuine
   *  established local presence. Only meaningful on GET /regions/:id/species rows — always
   *  false from GET /collection. Informational only, same as `endemic` — never excludes a
   *  species, just explains why its localTier reads rarer than raw record count alone would
   *  suggest. */
  vagrant: boolean;
  /** True if this species is only ever recorded (real GBIF presence) in exactly one of the
   *  258 countries the elusiveness crawl covers. Which country isn't carried here (grid
   *  cards don't need it); the species detail page resolves the name. */
  endemic: boolean;
  /** The user's cover photo (collected) or the Phase-1 reference photo (seen/unseen). */
  coverPhotoUrl: string | null;
  coverPhotoCredit: string | null;
  /** A movable/resizable square crop for the card thumbnail's own photo, independent of the
   *  full-size hero image on the detail page. All three are fractions (0-100) of the photo's
   *  own width (including cardCropY — see migration 006 for why one shared unit is used).
   *  Null means no custom crop saved yet — render as a plain centered object-fit:cover. */
  cardCropX: number | null;
  cardCropY: number | null;
  cardCropSize: number | null;
  /** A focal point (fractions 0-100) for the shared reference photo — see migration 043.
   *  Only meaningful when coverPhotoUrl is that reference photo (no cover of your own yet);
   *  null otherwise, same convention as cardCropX/Y being null. Applied via CSS
   *  object-position, which (unlike cardCrop's square rect) works against any box shape a
   *  reference photo shows up in, so one stored value covers both the square card thumbnail
   *  and the 16:9 detail-page hero. */
  referenceFocalX: number | null;
  referenceFocalY: number | null;
}

// Response shape for GET /api/collection/stats (spec §9 Phase 4).
export interface CollectionStats {
  totalCollected: number;
  byTier: Record<RarityTier, number>;
  byFamily: Array<{ family: string; count: number }>;
  byYear: Array<{ year: number; count: number }>;
}
