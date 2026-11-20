// Province listings backed by eBird alone, with a handful of records and no open list naming them
// there, come off the checklist: a few eBird records are rarely enough to call a bird part of a
// region's list (Florida Scrub-Jay in Ontario, Ferruginous Hawk in the UK).
//
// A listing is judged only when ALL of these hold:
//   - its evidence is eBird only (region_species.evidence_source = 'ebird');
//   - GBIF records and iNaturalist research-grade photos there together are under EBIRD_ONLY_MAX_RECORDS;
//   - no open list (data/reference/open-region-lists.json: {species, region, country, source}) names
//     the species there;
//   - it isn't a taxonomy mismatch whose accepted species the province lists on other evidence
//     (data/reference/ebird-taxon-map.json): those are the same bird under eBird's finer split, so
//     the listing is dropped as a duplicate rather than as unsupported.
// With no open lists in the file nothing is judged, so a fresh checkout never prunes on eBird alone.
// Every removal is written to data/review/ebird-only-unsupported.tsv for the maintainer to skim.
//
// Usage (from packages/data-pipeline): npx tsx src/scripts/check-ebird-only.ts [--apply]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@lifer/core/db.js";
import { PROVINCES_WITH_COUNTRY_SQL } from "@lifer/core/regions/regionTree.js";
import { deleteListings, knownFeral, referenceListings } from "./remove-escapes.js";

export const EBIRD_ONLY_MAX_RECORDS = 5;

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const OPEN_LISTS = "open-region-lists.json";
const REVIEW_FILE = path.join(DATA_DIR, "review", "ebird-only-unsupported.tsv");

export interface EbirdOnlyListing {
  regionId: string;
  speciesId: string;
  species: string;
  region: string;
  country: string;
  records: number;
}

export type EbirdOnlyVerdict = "keep" | "unsupported" | "duplicate";

/** What to do with one eBird-only listing. `acceptedListed`: the species eBird's split maps to is
 *  already listed in the province on other evidence. */
export function judgeEbirdOnly(
  l: Pick<EbirdOnlyListing, "records">,
  openListed: boolean,
  acceptedListed: boolean,
): EbirdOnlyVerdict {
  if (acceptedListed) return "duplicate";
  if (openListed || l.records >= EBIRD_ONLY_MAX_RECORDS) return "keep";
  return "unsupported";
}

export async function checkEbirdOnly(apply: boolean): Promise<Array<EbirdOnlyListing & { verdict: EbirdOnlyVerdict }>> {
  const client = await pool.connect();
  try {
    const open = await referenceListings(client, OPEN_LISTS);
    if (open.size === 0) {
      console.log(`[ebird-only] ${OPEN_LISTS} names nothing yet, so nothing is judged`);
      return [];
    }
    const taxonMap = JSON.parse(
      readFileSync(path.join(DATA_DIR, "reference", "ebird-taxon-map.json"), "utf8"),
    ) as Array<{
      ebird: string;
      accepted: string;
    }>;
    await client.query("BEGIN");
    const rows = await client.query<{
      region_id: string;
      species_id: string;
      species: string;
      region: string;
      country: string;
      records: string;
      accepted_listed: boolean;
    }>(
      `SELECT rs.region_id, rs.species_id, s.scientific_name AS species, r.name AS region, c.name AS country,
              greatest(COALESCE(rs.local_frequency, 0), COALESCE(rs.inat_rg_count, 0)) AS records,
              EXISTS (SELECT 1 FROM unnest($1::text[], $2::text[]) m(ebird, accepted)
                      JOIN species a ON a.scientific_name = m.accepted
                      JOIN region_species ars ON ars.species_id = a.id AND ars.region_id = rs.region_id
                      WHERE m.ebird = s.scientific_name AND ars.evidence_source IS DISTINCT FROM 'ebird') AS accepted_listed
       FROM region_species rs
       JOIN species s ON s.id = rs.species_id
       JOIN regions r ON r.id = rs.region_id
       JOIN (${PROVINCES_WITH_COUNTRY_SQL}) p ON p.id = rs.region_id
       JOIN regions c ON c.id = p.country_id
       WHERE rs.evidence_source = 'ebird' AND s.taxon_class = 'aves'`,
      [taxonMap.map((m) => m.ebird), taxonMap.map((m) => m.accepted)],
    );
    const keep = await knownFeral(client);
    const judged = rows.rows
      .map((r) => {
        const l: EbirdOnlyListing = {
          regionId: r.region_id,
          speciesId: r.species_id,
          species: r.species,
          region: r.region,
          country: r.country,
          records: Number(r.records),
        };
        return { ...l, verdict: judgeEbirdOnly(l, open.has(`${r.region_id}|${r.species_id}`), r.accepted_listed) };
      })
      .filter((l) => l.verdict !== "keep" && !keep.has(`${l.regionId}|${l.speciesId}`));
    await deleteListings(
      client,
      judged.map((l) => ({ region_id: l.regionId, species_id: l.speciesId })),
    );
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    mkdirSync(path.dirname(REVIEW_FILE), { recursive: true });
    writeFileSync(
      REVIEW_FILE,
      [
        "country\tregion\tspecies\trecords\tverdict",
        ...judged.map((l) => [l.country, l.region, l.species, l.records, l.verdict].join("\t")),
      ].join("\n") + "\n",
    );
    return judged;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const apply = process.argv.includes("--apply");
  checkEbirdOnly(apply)
    .then(async (rows) => {
      console.log(`[ebird-only] ${apply ? "removed" : "would remove"} ${rows.length} listings, see ${REVIEW_FILE}`);
      await pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
