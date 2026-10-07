import { pool } from "@lifer/core/db.js";

// Shared "hide obscure/inaccessible species" rule for checklist endpoints. A species is obscure
// if it's too deep (fish only), historically unfindable, or has no photo from either enrichment
// (reference_photo) or a downloaded pack (reference_display_path). Pack-only species never get
// reference_photo, so both must be checked. Species with no traits row are never hidden.
// A boolean expression: callers LEFT JOIN species_traits AS t and wrap it in NOT(...).
export const RECREATIONAL_MAX_DEPTH_M = 60; // realistic no-trimix recreational scuba range
export const TECHNICAL_MAX_DEPTH_M = 120; // technical (trimix) diving, not the default

// A missing reference photo means "barely documented" only when the records agree, since some
// well known species lack catalog photos. Shared with collectionItem.ts's isGhostSpecies.
export const WELL_DOCUMENTED_MIN_OCCURRENCES = 1000;

export function obscureSpeciesSql(maxDepthM: number): string {
  // Other Taxa species never get occurrence or depth enrichment, so every branch below would
  // hide them. Excluded up front.
  return `(
  s.is_other_taxa = false AND (
    (s.taxon_class = 'actinopterygii' AND t.depth_min_m IS NOT NULL AND t.depth_min_m >= ${maxDepthM})
    OR (t.occurrence_count IS NOT NULL AND t.occurrence_count < 20)
    OR (t.last_occurrence_year IS NOT NULL AND t.last_occurrence_year < 1950)
    OR (s.reference_photo IS NULL AND s.reference_display_path IS NULL
        AND (t.occurrence_count IS NULL OR t.occurrence_count < ${WELL_DOCUMENTED_MIN_OCCURRENCES}))
  )
)`;
}

// Both preferences live on the users row and are read together.
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

// Never hide a species already on the user's life list: the filter keeps new noise out of a
// checklist, it doesn't un-list something already earned.
export const ALREADY_OWNED_SQL = `us.state IN ('collected', 'seen')`;

// Vagrants rarely belong on a "what am I likely to find here" checklist. Requires `rs`
// (region_species) in scope; sea-zone-only species are never flagged.
export const REGION_VAGRANT_SQL = `COALESCE(rs.is_vagrant, false)`;

// User-archived species are always excluded, with no reveal switch. Requires LEFT JOIN
// user_archived_species AS uas ON uas.user_id = $userId AND uas.species_id = s.id.
export const NOT_ARCHIVED_SQL = `(uas.species_id IS NULL OR ${ALREADY_OWNED_SQL})`;

// Hides a species from one region's checklist only, with the same already-owned exemption.
// Requires LEFT JOIN region_species_hidden AS rsh on user, species and the same region_id as rs.
export const NOT_REGION_HIDDEN_SQL = `(rsh.species_id IS NULL OR ${ALREADY_OWNED_SQL})`;

// A region_species row doesn't mean its pack was downloaded: the catalog seed ships every
// checklist up front for browsing. This checks downloaded_packs instead, via a region pack (taxon
// must match; province rows match their parent country's name) or a sea-zone pack (any taxon).
//
// Other Taxa species have no packs, so they are always unlocked.
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
