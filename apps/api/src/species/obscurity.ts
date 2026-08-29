import { pool } from "../db.js";

// Shared "hide obscure/inaccessible species" rule for checklist endpoints (regions/routes.ts,
// collection/routes.ts). Two independent reasons a species counts as obscure by default:
//
// 1. Depth: a fish whose shallowest known depth (species_traits.depth_min_m) is 120m+ is beyond
//    even technical scuba diving — nobody photographing on a life-list app will realistically
//    ever see it. Fish only, since a pelagic seabird still has to come to land eventually.
// 2. Historical rarity: species_traits.occurrence_count/last_occurrence_year (migration 036,
//    backed by GBIF's global occurrence records, which reach back to the 1800s) — fewer than 20
//    records ever, or none since 1950, reads as "no longer findable in practice" regardless of
//    taxon.
//
// Species missing this data entirely (traits not yet backfilled) are never hidden — absence of
// evidence isn't evidence of obscurity, and hiding on missing data would make the filter's
// blast radius grow silently as new gaps appear rather than shrink as data fills in.
//
// Callers must LEFT JOIN species_traits AS t (and select species AS s) for this fragment to
// resolve; it's a boolean SQL expression, not a full WHERE clause, so it composes with
// `NOT (...)` when the caller wants to hide obscure species, or is skipped entirely (via the
// $-parameterized toggle) when the caller wants to reveal them.
// s.reference_photo (the enrichment-discovered photo URL, NOT a locally-cached file path) is
// null only when enrichment genuinely never found ANY usable photo anywhere (iNaturalist,
// Wikipedia, Commons) — unlike reference_display_path, it's never null just because a pack
// hasn't delivered its cached copy yet, so this can't misfire on a species merely waiting on a
// download. A species nobody can even see a picture of isn't realistically photographable —
// exactly the tier philosophy's own "photographability, not conservation status" standard —
// and tends to correlate with exactly the kind of GBIF-noise/geographic-outlier species this
// whole obscurity filter exists to hide by default (rarely enriched with real gallery data).
export const OBSCURE_SPECIES_SQL = `(
  (s.taxon_class = 'actinopterygii' AND t.depth_min_m IS NOT NULL AND t.depth_min_m >= 120)
  OR (t.occurrence_count IS NOT NULL AND t.occurrence_count < 20)
  OR (t.last_occurrence_year IS NOT NULL AND t.last_occurrence_year < 1950)
  OR s.reference_photo IS NULL
)`;

// Moved off the collection page's per-view filter bar and into a persisted account preference
// (migration 038 — users.hide_obscure_species, default true) — decided once from Settings
// rather than re-checked on every region.
export async function getHideObscurePreference(userId: string): Promise<boolean> {
  const res = await pool.query<{ hide_obscure_species: boolean }>(
    `SELECT hide_obscure_species FROM users WHERE id = $1`,
    [userId],
  );
  return res.rows[0]?.hide_obscure_species ?? true;
}

// Never hide a species the user has already collected/seen — us.state is only non-null once a
// user_species row exists (collected or seen; "unseen" is the absence of a row, not a state
// value), so this exempts anything already on their life list. Without this, turning the
// toggle on after adding a rare/vagrant species would make that species vanish from their own
// collection view even though the underlying capture/user_species data is untouched — the
// filter is meant to keep new noise out of a checklist, not un-list something already earned.
export const ALREADY_OWNED_SQL = `us.state IS NOT NULL`;

// Region-only counterpart to OBSCURE_SPECIES_SQL: a species region_species.is_vagrant marked
// true (see migration 024 — computed via passesRecurrenceCheck in regions/routes.ts, e.g. a
// storm-blown-in rarity or a one-off historical record) rarely belongs on a "what am I likely
// to find here" default checklist, even though the flag was originally built purely as a
// local_tier scoring signal, never as an exclusion. Requires `rs` (region_species, LEFT JOINed
// on region_id) to be in scope — sea-zone-only species have no region_species row and are
// never flagged vagrant by this.
export const REGION_VAGRANT_SQL = `COALESCE(rs.is_vagrant, false)`;

// User-archived species (migration 037) are always excluded from checklist/count views,
// unconditionally — unlike the obscurity toggle above, there's no "reveal archived species"
// switch, since archiving is a deliberate, targeted per-species choice, not a broad default
// worth ever reversing en masse. Requires callers to LEFT JOIN user_archived_species AS uas
// ON uas.user_id = $userId AND uas.species_id = s.id.
export const NOT_ARCHIVED_SQL = `(uas.species_id IS NULL OR ${ALREADY_OWNED_SQL})`;

// A species/region row existing in region_species (or sea_zone_species) does NOT by itself
// mean its pack was ever downloaded — a portable catalog seed (see desktop's embedded_db.rs)
// brings over the WHOLE region_species/sea_zone_species tables up front, across every taxon
// and zone, purely so there's something to browse before any pack is downloaded at all. This
// checks the real signal instead: does a downloaded_packs row actually cover this species,
// either through a region pack (taxon-split — Canada's birds pack is separate from its fish
// pack, so both taxon AND region must match) or a sea-zone pack (never taxon-split, so any
// zone download covers every taxon in it)? Region packs are always built at country level
// (bundling every province), so a province's own region_species rows are matched via its
// PARENT country's name — the province's own name never appears in downloaded_packs.region.
// Requires `s` (species) in scope; used for the whole-catalog "All species" view
// (collection/routes.ts), which — unlike a single region's checklist — has no one regionId to
// resolve ahead of time the way regions/routes.ts's resolvePackRegionName does.
export const SPECIES_UNLOCKED_SQL = `(
  EXISTS (
    SELECT 1 FROM region_species rs2
    JOIN regions r2 ON r2.id = rs2.region_id
    LEFT JOIN regions parent2 ON parent2.id = r2.parent_id
    JOIN downloaded_packs dp ON dp.region = (
      CASE WHEN COALESCE(array_length(parent2.external_codes, 1), 0) = 0 THEN r2.name ELSE parent2.name END
    )
    WHERE rs2.species_id = s.id AND (dp.taxon IS NULL OR dp.taxon = s.taxon_class)
  )
  OR EXISTS (
    SELECT 1 FROM sea_zone_species szs
    JOIN sea_zones sz ON sz.id = szs.sea_zone_id
    JOIN downloaded_packs dp2 ON dp2.region = sz.name
    WHERE szs.species_id = s.id
  )
)`;
