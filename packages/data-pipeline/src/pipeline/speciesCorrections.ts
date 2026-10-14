// Hand-checked corrections to catalog species that an upstream source gets wrong for the concept the
// catalog uses (data/reference/species-corrections.json). The usual case is a lump: the catalog
// keeps GBIF's broad species while iNaturalist and IUCN use the same name for one narrow part of it,
// so their common name and Red List status describe the wrong animal. Applied at the end of the
// catalog and enrich stages, after every step that writes these fields, so a correction always
// wins and a refresh can't undo it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { isIucnCode, type IucnCode } from "@lifer/shared";

type Db = Pool | PoolClient;

export const SPECIES_CORRECTIONS_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "data",
  "reference",
  "species-corrections.json",
);

export interface SpeciesCorrection {
  scientificName: string;
  /** Why the correction exists, for the next person to read it. */
  reason: string;
  commonName?: string;
  /** null clears the status (no assessment covers this concept). Absent leaves it alone. */
  iucnStatus?: IucnCode | null;
  iucnNote?: string | null;
  extinct?: boolean;
  /** The country (Natural Earth iso3) the species is endemic to, or null for none. Applied by the
   *  endemic stage, for a species its records can't settle (a long-established introduced
   *  population no register lists). */
  endemicCountry?: string | null;
}

export function parseSpeciesCorrections(json: unknown): SpeciesCorrection[] {
  if (!Array.isArray(json)) throw new Error("species corrections: expected an array");
  return json.map((entry, i) => {
    const at = `species corrections[${i}]`;
    if (typeof entry !== "object" || entry === null) throw new Error(`${at}: expected an object`);
    const e = entry as Record<string, unknown>;
    if (typeof e.scientificName !== "string" || !e.scientificName) throw new Error(`${at}: scientificName missing`);
    if (typeof e.reason !== "string" || !e.reason) throw new Error(`${at}: reason missing`);
    if ("commonName" in e && (typeof e.commonName !== "string" || !e.commonName))
      throw new Error(`${at}: commonName must be a non-empty string`);
    if ("iucnStatus" in e && e.iucnStatus !== null && !isIucnCode(e.iucnStatus as string))
      throw new Error(`${at}: iucnStatus must be an IUCN code or null`);
    if ("iucnNote" in e && e.iucnNote !== null && typeof e.iucnNote !== "string")
      throw new Error(`${at}: iucnNote must be a string or null`);
    if ("extinct" in e && typeof e.extinct !== "boolean") throw new Error(`${at}: extinct must be true or false`);
    if ("endemicCountry" in e && e.endemicCountry !== null && !/^[A-Z]{3}$/.test(String(e.endemicCountry)))
      throw new Error(`${at}: endemicCountry must be a three-letter country code or null`);
    return e as unknown as SpeciesCorrection;
  });
}

export function loadSpeciesCorrections(file = SPECIES_CORRECTIONS_FILE): SpeciesCorrection[] {
  return parseSpeciesCorrections(JSON.parse(readFileSync(file, "utf8")));
}

/** Applies each correction to its catalog species; returns the names that matched no species. */
export async function applySpeciesCorrections(db: Db, corrections: SpeciesCorrection[]): Promise<string[]> {
  const missing: string[] = [];
  for (const c of corrections) {
    const res = await db.query<{ id: string }>(
      `SELECT id FROM species WHERE scientific_name = $1 AND NOT is_other_taxa`,
      [c.scientificName],
    );
    const id = res.rows[0]?.id;
    if (!id) {
      missing.push(c.scientificName);
      continue;
    }
    if (c.commonName !== undefined) {
      // The name it replaces stays searchable.
      await db.query(
        `UPDATE species SET
           common_name_aliases = CASE
             WHEN common_name IS NULL OR common_name = $2 OR common_name = ANY(COALESCE(common_name_aliases, '{}'))
               THEN common_name_aliases
             ELSE array_append(COALESCE(common_name_aliases, '{}'), common_name) END,
           common_name = $2
         WHERE id = $1`,
        [id, c.commonName],
      );
    }
    if (c.iucnStatus !== undefined || c.iucnNote !== undefined || c.extinct !== undefined) {
      await db.query(
        `UPDATE species_traits SET
           iucn_status = CASE WHEN $2 THEN $3 ELSE iucn_status END,
           iucn_source = CASE WHEN $2 AND $3::text IS NULL THEN NULL ELSE iucn_source END,
           iucn_note = CASE WHEN $4 THEN $5 ELSE iucn_note END,
           fully_extinct = COALESCE($6, fully_extinct)
         WHERE species_id = $1`,
        [
          id,
          c.iucnStatus !== undefined,
          c.iucnStatus ?? null,
          c.iucnNote !== undefined,
          c.iucnNote ?? null,
          c.extinct ?? null,
        ],
      );
    }
  }
  return missing;
}
