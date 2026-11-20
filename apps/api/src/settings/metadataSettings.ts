// Per-user copyright/caption template, file name template and sensitive species choices. Kept in
// install_settings under per-user keys, like speciesNameDisplay.ts: small values, no migration.
import { DEFAULT_FILE_NAME_TEMPLATE, DEFAULT_METADATA_TEMPLATE, type MetadataTemplate } from "@lifer/shared";
import { pool } from "@lifer/core/db.js";
import {
  EBIRD_SENSITIVE_SPECIES,
  isEbirdSensitiveAt,
  type SensitiveLocation,
} from "@lifer/core/species/sensitiveSpecies.js";
import { getInstallSetting, setInstallSetting } from "../lib/installSettings.js";

const metadataKey = (userId: string) => `metadata_template:${userId}`;
const fileNameKey = (userId: string) => `file_name_template:${userId}`;
const sensitiveKey = (userId: string) => `sensitive_species:${userId}`;

export async function getMetadataTemplate(userId: string): Promise<MetadataTemplate> {
  const saved = await getInstallSetting<Partial<MetadataTemplate>>(pool, metadataKey(userId));
  const t = { ...DEFAULT_METADATA_TEMPLATE };
  if (saved && typeof saved === "object") {
    for (const k of ["creator", "copyright", "credit", "usageTerms", "caption"] as const)
      if (typeof saved[k] === "string") t[k] = saved[k];
    t.replaceExisting = saved.replaceExisting === true;
  }
  return t;
}

export async function setMetadataTemplate(userId: string, value: MetadataTemplate): Promise<MetadataTemplate> {
  const saved: MetadataTemplate = {
    creator: value.creator.trim(),
    copyright: value.copyright.trim(),
    credit: value.credit.trim(),
    usageTerms: value.usageTerms.trim(),
    caption: value.caption.trim(),
    replaceExisting: value.replaceExisting,
  };
  await setInstallSetting(pool, metadataKey(userId), saved);
  return saved;
}

export async function getFileNameTemplate(userId: string): Promise<string> {
  const saved = await getInstallSetting<unknown>(pool, fileNameKey(userId));
  return typeof saved === "string" && saved.trim() ? saved : DEFAULT_FILE_NAME_TEMPLATE;
}

export async function setFileNameTemplate(userId: string, template: string): Promise<string> {
  const saved = template.trim() || DEFAULT_FILE_NAME_TEMPLATE;
  await setInstallSetting(pool, fileNameKey(userId), saved);
  return saved;
}

export interface SensitiveSpeciesSettings {
  enabled: boolean;
  /** Species the user marked sensitive on top of the defaults. */
  added: string[];
  /** Default-sensitive species the user chose to treat as ordinary. */
  removed: string[];
}

export async function getSensitiveSettings(userId: string): Promise<SensitiveSpeciesSettings> {
  const saved = await getInstallSetting<Partial<SensitiveSpeciesSettings>>(pool, sensitiveKey(userId));
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { enabled: saved?.enabled !== false, added: ids(saved?.added), removed: ids(saved?.removed) };
}

export async function setSensitiveSettings(userId: string, value: SensitiveSpeciesSettings): Promise<void> {
  await setInstallSetting(pool, sensitiveKey(userId), {
    enabled: value.enabled,
    added: [...new Set(value.added)],
    removed: [...new Set(value.removed)],
  });
}

/** IUCN statuses whose locations are hidden by default. */
export const SENSITIVE_IUCN = ["VU", "EN", "CR"];

// Every entry, regional ones too: this is the default list the Sensitive species page shows. Whether
// a photo is sensitive where it was taken is decided by sensitiveCapturesAmong.
const EBIRD_SENSITIVE_NAMES = [...EBIRD_SENSITIVE_SPECIES.keys()];

// Sensitive by default: threatened on the IUCN Red List, or on eBird's sensitive species list.
const DEFAULT_SENSITIVE_SQL = `(st.iucn_status = ANY($2::text[]) OR s.scientific_name = ANY($3::text[]))`;

/** The place names a region sits in, to match against eBird's area labels. Read from its ancestors
 *  by their eBird codes, as photoPlaceForRegion does, plus the group the subdivision is listed under. */
async function sensitiveLocation(regionId: string): Promise<SensitiveLocation | null> {
  const res = await pool.query<{
    state: string | null;
    group_name: string | null;
    country: string | null;
    code: string | null;
  }>(
    `WITH RECURSIVE up AS (
       SELECT id, name, parent_id, COALESCE(home_country_id, parent_id) AS up_id, ebird_region_code, 0 AS depth
         FROM regions WHERE id = $1
       UNION ALL
       SELECT r.id, r.name, r.parent_id, COALESCE(r.home_country_id, r.parent_id), r.ebird_region_code, up.depth + 1
         FROM regions r JOIN up ON r.id = up.up_id WHERE up.depth < 12
     ),
     state AS (SELECT name, parent_id FROM up WHERE ebird_region_code ~ '^[A-Z]{2}-[A-Z0-9]+$' ORDER BY depth LIMIT 1),
     country AS (SELECT id, name, ebird_region_code FROM up WHERE ebird_region_code ~ '^[A-Z]{2}$' ORDER BY depth LIMIT 1)
     SELECT (SELECT name FROM state) AS state,
            (SELECT g.name FROM regions g WHERE g.id = (SELECT parent_id FROM state)
                AND g.id <> (SELECT id FROM country) AND g.ebird_region_code IS NULL) AS group_name,
            (SELECT name FROM country) AS country, (SELECT ebird_region_code FROM country) AS code`,
    [regionId],
  );
  const row = res.rows[0];
  return row ? { state: row.state, group: row.group_name, country: row.country, countryCode: row.code } : null;
}

/** A photo to check: its species and where it was taken. A photo with coordinates but no region
 *  counts as having no location. */
export interface SensitiveCandidate {
  capture_id: string;
  species_id: string;
  region_id: string | null;
}

/** Which of these photos this user treats as sensitive where they were taken, by capture id. A
 *  species is sensitive when it's on the user's own list, threatened on the IUCN Red List, or listed
 *  by eBird for the photo's area (isEbirdSensitiveAt); a species the user marked ordinary never is.
 *  Empty when the feature is off. Every share, export and upload that hides places goes through this. */
export async function sensitiveCapturesAmong(userId: string, photos: SensitiveCandidate[]): Promise<Set<string>> {
  if (photos.length === 0) return new Set();
  const settings = await getSensitiveSettings(userId);
  if (!settings.enabled) return new Set();
  const speciesIds = [...new Set(photos.map((p) => p.species_id))];
  const res = await pool.query<{ id: string; scientific_name: string; threatened: boolean }>(
    `SELECT s.id, s.scientific_name, COALESCE(st.iucn_status = ANY($2::text[]), false) AS threatened
       FROM species s LEFT JOIN species_traits st ON st.species_id = s.id
      WHERE s.id = ANY($1::uuid[])`,
    [speciesIds, SENSITIVE_IUCN],
  );
  const species = new Map(res.rows.map((r) => [r.id, r]));
  const removed = new Set(settings.removed);
  const added = new Set(settings.added);
  const locations = new Map<string, SensitiveLocation | null>();
  const sensitive = new Set<string>();
  for (const photo of photos) {
    const s = species.get(photo.species_id);
    if (!s) continue;
    if (added.has(s.id) || (!removed.has(s.id) && s.threatened)) {
      sensitive.add(photo.capture_id);
      continue;
    }
    if (removed.has(s.id) || !EBIRD_SENSITIVE_SPECIES.has(s.scientific_name)) continue;
    let at: SensitiveLocation | null = null;
    if (photo.region_id) {
      if (!locations.has(photo.region_id)) locations.set(photo.region_id, await sensitiveLocation(photo.region_id));
      at = locations.get(photo.region_id) ?? null;
    }
    if (isEbirdSensitiveAt(s.scientific_name, at)) sensitive.add(photo.capture_id);
  }
  return sensitive;
}

export interface SensitiveSpeciesRow {
  id: string;
  commonName: string | null;
  scientificName: string;
  iucnStatus: string | null;
  /** Why it's on the list: "iucn", "ebird", or "added" by the user. */
  reason: "iucn" | "ebird" | "added";
  /** On a default list but marked not sensitive by the user, so it can be restored. */
  removed: boolean;
  /** For an eBird species listed only in some areas: those areas, as eBird names them ("Ontario-CA").
   *  Empty when it's sensitive everywhere. */
  areas: string[];
}

/** The areas eBird lists a species in, each once; empty for a global entry or a species not listed. */
function ebirdAreas(scientificName: string): string[] {
  const scope = EBIRD_SENSITIVE_SPECIES.get(scientificName);
  return scope && !scope.global ? [...new Set(scope.regions.map((r) => r.region))] : [];
}

/** True when a species is sensitive by default, before the user's own choices. */
export async function isDefaultSensitive(speciesId: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM species s LEFT JOIN species_traits st ON st.species_id = s.id
      WHERE s.id = $1 AND ${DEFAULT_SENSITIVE_SQL}`,
    [speciesId, SENSITIVE_IUCN, EBIRD_SENSITIVE_NAMES],
  );
  return (res.rowCount ?? 0) > 0;
}

/** The sensitive species among those the user has photos of (the whole catalog would be
 *  thousands), every one they added by hand, and default ones they marked not sensitive. */
export async function listSensitiveSpecies(userId: string): Promise<SensitiveSpeciesRow[]> {
  const s = await getSensitiveSettings(userId);
  const res = await pool.query<{
    id: string;
    common_name: string | null;
    scientific_name: string;
    iucn_status: string | null;
    added: boolean;
    removed: boolean;
  }>(
    `SELECT s.id, s.common_name, s.scientific_name, st.iucn_status,
            s.id = ANY($5::uuid[]) AS added, s.id = ANY($4::uuid[]) AND NOT s.id = ANY($5::uuid[]) AS removed
       FROM species s LEFT JOIN species_traits st ON st.species_id = s.id
      WHERE (s.id = ANY($5::uuid[])
             OR (${DEFAULT_SENSITIVE_SQL} AND s.id = ANY($4::uuid[]))
             OR (${DEFAULT_SENSITIVE_SQL} AND NOT s.id = ANY($4::uuid[])
                 AND EXISTS (SELECT 1 FROM captures c WHERE c.user_id = $1 AND c.species_id = s.id)))
      ORDER BY lower(COALESCE(s.common_name, s.scientific_name))`,
    [userId, SENSITIVE_IUCN, EBIRD_SENSITIVE_NAMES, s.removed, s.added],
  );
  return res.rows.map((r) => ({
    id: r.id,
    commonName: r.common_name,
    scientificName: r.scientific_name,
    iucnStatus: r.iucn_status,
    reason: r.added ? "added" : SENSITIVE_IUCN.includes(r.iucn_status ?? "") ? "iucn" : "ebird",
    removed: r.removed,
    areas: ebirdAreas(r.scientific_name),
  }));
}
