import { pool } from "../db.js";

// Shared "hide obscure/inaccessible species" rule for checklist endpoints (regions/routes.ts,
// collection/routes.ts) — a species is obscure if it's too deep for the given depth cutoff
// (fish only; species_traits.depth_min_m), historically unfindable (species_traits
// occurrence_count < 20 or last_occurrence_year < 1950), or has no photo at all, from either
// enrichment (s.reference_photo, the remote source URL) or a downloaded pack (s.reference_
// display_path, the locally-cached file). Confirmed live: a species enriched only via an
// offline pack (never through the catalog seed or a live lazy-enrichment fetch) has a real,
// visible local photo but reference_photo stays NULL forever — applyChecklist's own species
// UPDATE never sets that column, only the local path ones — so checking reference_photo alone
// wrongly hid the vast majority of a downloaded pack's species (BC's birds: 484 of 498) the
// moment "Hide Obscure/Inaccessible Species" (on by default) was active. Species missing
// traits entirely are never hidden — absence of evidence isn't obscurity.
// A boolean expression, not a full WHERE clause: callers LEFT JOIN species_traits AS t and
// wrap in NOT(...) to hide obscure species, or skip it to reveal them.
export const RECREATIONAL_MAX_DEPTH_M = 60; // realistic no-trimix recreational scuba range
export const TECHNICAL_MAX_DEPTH_M = 120; // technical (trimix) divers are a small minority — not the default

export function obscureSpeciesSql(maxDepthM: number): string {
  // "Other taxa" species (Settings > Species & Import's any-taxa search — insects, arachnids,
  // plants, fungi) never run through occurrence/depth enrichment at all (see migration 089), so
  // every OR branch below would otherwise read as true for them by default (no traits row, no
  // guaranteed reference photo) and hide them from their own "Other Taxa" section the moment
  // hideObscure's default-on setting applied — excluded up front instead, same reasoning as
  // rarity/occurrence never being computed for them in the first place.
  return `(
  s.is_other_taxa = false AND (
    (s.taxon_class = 'actinopterygii' AND t.depth_min_m IS NOT NULL AND t.depth_min_m >= ${maxDepthM})
    OR (t.occurrence_count IS NOT NULL AND t.occurrence_count < 20)
    OR (t.last_occurrence_year IS NOT NULL AND t.last_occurrence_year < 1950)
    OR (s.reference_photo IS NULL AND s.reference_display_path IS NULL)
  )
)`;
}

// Moved off the collection page's per-view filter bar and into persisted account preferences
// (migration 038 — users.hide_obscure_species, default true; migration 068 —
// users.technical_diving, default false) — decided once from Settings rather than re-checked on
// every region. One query since both live on the same row and are almost always read together.
export async function getObscurityPreferences(userId: string): Promise<{ hideObscure: boolean; maxDepthM: number }> {
  const res = await pool.query<{ hide_obscure_species: boolean; technical_diving: boolean }>(
    `SELECT hide_obscure_species, technical_diving FROM users WHERE id = $1`,
    [userId],
  );
  const row = res.rows[0];
  return {
    hideObscure: row?.hide_obscure_species ?? true,
    maxDepthM: row?.technical_diving ? TECHNICAL_MAX_DEPTH_M : RECREATIONAL_MAX_DEPTH_M,
  };
}

// Kept for any caller that only ever needs the hide/show boolean, not the depth threshold too.
export async function getHideObscurePreference(userId: string): Promise<boolean> {
  return (await getObscurityPreferences(userId)).hideObscure;
}

// Never hide a species the user has already collected/seen — "unseen" is the absence of a
// user_species row, not a state value, so this exempts anything already on their life list.
// Without this, turning the toggle on after adding a rare/vagrant species would make that
// species vanish from their own collection view even though the underlying capture/user_species
// data is untouched — the filter is meant to keep new noise out of a checklist, not un-list
// something already earned. is_target (migration 090) is its own independent column, not a
// value of state, so it was never part of this check anyway — wanting to find a species someday
// shouldn't bypass the archive/obscurity/pack-unlock gates the way actually having collected or
// seen it does.
export const ALREADY_OWNED_SQL = `us.state IN ('collected', 'seen')`;

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

// Region-scoped counterpart to NOT_ARCHIVED_SQL (migration 100, region_species_hidden) — hides a
// species from ONE region's checklist (e.g. a vagrant entry a user doesn't want cluttering that
// region) without touching its global record or any other region's checklist. Same
// already-owned exemption as the global archive: something actually collected/seen there stays
// visible rather than silently vanishing. Requires callers to LEFT JOIN region_species_hidden AS
// rsh ON rsh.user_id = $userId AND rsh.species_id = s.id AND rsh.region_id = <the same region_id
// column rs itself was joined on>.
export const NOT_REGION_HIDDEN_SQL = `(rsh.species_id IS NULL OR ${ALREADY_OWNED_SQL})`;

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
//
// Other Taxa species (is_other_taxa) have no pack concept at all — no pack is ever built for
// "other-taxa", so without this carve-out one would only ever pass this check by accident (a
// user who happens to have an all-taxa pack downloaded for that region), staying invisible
// everywhere otherwise despite being manually, deliberately added.
export const SPECIES_UNLOCKED_SQL = `(
  s.is_other_taxa = true
  OR EXISTS (
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
