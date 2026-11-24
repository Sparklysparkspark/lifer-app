import type { Db } from "./db";
import { toCrop, type Crop } from "../photos/crop";

export type MarkState = "collected" | "seen" | null;
export type Status = "photographed" | "seen" | "none";

export interface Mark {
  scientificName: string;
  state: MarkState;
  isTarget: boolean;
  coverPhotoId: string | null;
  firstCollected: string | null;
  bestQuality: number | null;
  cardCropX: number | null;
  cardCropY: number | null;
  cardCropSize: number | null;
  /** The hub's version of this mark as last seen; null if it never had one. */
  hubVersion: string | null;
}

interface MarkRow {
  scientific_name: string;
  state: MarkState;
  is_target: number;
  cover_photo_id: string | null;
  first_collected: string | null;
  best_quality: number | null;
  card_crop_x: number | null;
  card_crop_y: number | null;
  card_crop_size: number | null;
  hub_version: string | null;
}

const fromRow = (r: MarkRow): Mark => ({
  scientificName: r.scientific_name,
  state: r.state,
  isTarget: !!r.is_target,
  coverPhotoId: r.cover_photo_id,
  firstCollected: r.first_collected,
  bestQuality: r.best_quality,
  cardCropX: r.card_crop_x,
  cardCropY: r.card_crop_y,
  cardCropSize: r.card_crop_size,
  hubVersion: r.hub_version,
});

export async function getMark(db: Db, scientificName: string): Promise<Mark | null> {
  const row = await db.get<MarkRow>("SELECT * FROM marks WHERE scientific_name = ?", [scientificName]);
  return row ? fromRow(row) : null;
}

const UPSERT = `INSERT INTO marks (scientific_name, state, is_target, cover_photo_id, first_collected, best_quality,
    card_crop_x, card_crop_y, card_crop_size, hub_version, local_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (scientific_name) DO UPDATE SET state = excluded.state, is_target = excluded.is_target,
    cover_photo_id = excluded.cover_photo_id, first_collected = excluded.first_collected,
    best_quality = excluded.best_quality, card_crop_x = excluded.card_crop_x, card_crop_y = excluded.card_crop_y,
    card_crop_size = excluded.card_crop_size, hub_version = excluded.hub_version, local_at = excluded.local_at`;

async function write(db: Db, m: Mark, now: string): Promise<void> {
  await db.run("INSERT OR IGNORE INTO species (scientific_name) VALUES (?)", [m.scientificName]);
  await db.run(UPSERT, [
    m.scientificName,
    m.state,
    m.isTarget ? 1 : 0,
    m.coverPhotoId,
    m.firstCollected,
    m.bestQuality,
    m.cardCropX,
    m.cardCropY,
    m.cardCropSize,
    m.hubVersion,
    now,
  ]);
}

const blank = (scientificName: string): Mark => ({
  scientificName,
  state: null,
  isTarget: false,
  coverPhotoId: null,
  firstCollected: null,
  bestQuality: null,
  cardCropX: null,
  cardCropY: null,
  cardCropSize: null,
  hubVersion: null,
});

/** An edit made on the phone: kept at once, queued for the hub (one queue row per species). */
export async function editMark(
  db: Db,
  scientificName: string,
  patch: Partial<Pick<Mark, "state" | "isTarget">>,
  now: Date,
): Promise<Mark> {
  const next = { ...((await getMark(db, scientificName)) ?? blank(scientificName)), ...patch };
  const at = now.toISOString();
  await db.tx(async () => {
    await write(db, next, at);
    // Replace, so a sync already sending an older copy can tell this edit is newer and keep it queued.
    await db.run("INSERT OR REPLACE INTO outbox (kind, ref, created_at) VALUES ('mark', ?, ?)", [scientificName, at]);
  });
  return next;
}

/** The hub's copy of a mark, taken as is. Never called for a mark with an edit still queued. */
export async function applyHubMark(
  db: Db,
  hub: Omit<Mark, "hubVersion"> & { updatedAt?: string | null },
  now: Date,
): Promise<void> {
  const { updatedAt, ...rest } = hub;
  await write(db, { ...rest, hubVersion: updatedAt ?? null }, now.toISOString());
  await db.run("DELETE FROM outbox WHERE kind = 'mark' AND ref = ?", [hub.scientificName]);
}

/** Whether the mark has no information worth keeping (neither seen nor a target). */
export const isBlank = (m: Mark): boolean => m.state === null && !m.isTarget;

export interface SpeciesRow {
  scientificName: string;
  commonName: string | null;
  taxonClass: string | null;
  tier: string | null;
  sensitive: boolean;
  status: Status;
  isTarget: boolean;
  photos: number;
  coverPhotoId: string | null;
  /** The user's chosen crop of the cover, when the cover is the one they chose. */
  cardCrop?: Crop | null;
  lastTakenAt: string | null;
}

export type SpeciesFilter = "all" | "photographed" | "seen" | "targets" | "unseen";

const STATUS = `CASE WHEN COALESCE(c.n, 0) > 0 OR m.state = 'collected' THEN 'photographed'
  WHEN m.state = 'seen' THEN 'seen' ELSE 'none' END`;

// The chosen cover counts only while it is a photo this phone lists for the species (not hidden, not gone);
// otherwise the best photo shows, uncropped, as the species page does.
const COVER_OK = `m.cover_photo_id IS NOT NULL AND EXISTS (SELECT 1 FROM captures v WHERE v.photo_id = m.cover_photo_id
    AND v.scientific_name = sp.scientific_name AND v.hidden = 0 AND v.kind = 'image')`;

export const SPECIES_SQL = `SELECT sp.scientific_name, sp.common_name, sp.taxon_class, sp.tier, sp.sensitive,
    ${STATUS} AS status, COALESCE(m.is_target, 0) AS is_target, COALESCE(c.n, 0) AS photos, c.last_at,
    CASE WHEN ${COVER_OK} THEN m.cover_photo_id ELSE c.best_photo END AS cover,
    CASE WHEN ${COVER_OK} THEN m.card_crop_x END AS crop_x, CASE WHEN ${COVER_OK} THEN m.card_crop_y END AS crop_y,
    CASE WHEN ${COVER_OK} THEN m.card_crop_size END AS crop_size
  FROM species sp
  LEFT JOIN marks m ON m.scientific_name = sp.scientific_name
  LEFT JOIN (
    SELECT scientific_name, count(*) AS n, max(taken_at) AS last_at,
      (SELECT x.photo_id FROM captures x WHERE x.scientific_name = k.scientific_name AND x.photo_id IS NOT NULL
         AND x.hidden = 0 AND x.kind = 'image' ORDER BY x.rating DESC, x.taken_at DESC LIMIT 1) AS best_photo
    FROM captures k WHERE k.hidden = 0 GROUP BY scientific_name
  ) c ON c.scientific_name = sp.scientific_name`;

const WHERE: Record<SpeciesFilter, string> = {
  all: `${STATUS} <> 'none'`,
  photographed: `${STATUS} = 'photographed'`,
  seen: `${STATUS} = 'seen'`,
  targets: "COALESCE(m.is_target, 0) = 1",
  unseen: `${STATUS} = 'none' AND EXISTS (SELECT 1 FROM region_species r WHERE r.scientific_name = sp.scientific_name)`,
};

export interface RawSpecies {
  scientific_name: string;
  common_name: string | null;
  taxon_class: string | null;
  tier: string | null;
  sensitive: number;
  status: Status;
  is_target: number;
  photos: number;
  last_at: string | null;
  cover: string | null;
  crop_x?: number | null;
  crop_y?: number | null;
  crop_size?: number | null;
}

export const speciesFrom = (r: RawSpecies): SpeciesRow => ({
  scientificName: r.scientific_name,
  commonName: r.common_name,
  taxonClass: r.taxon_class,
  tier: r.tier,
  sensitive: !!r.sensitive,
  status: r.status,
  isTarget: !!r.is_target,
  photos: r.photos,
  coverPhotoId: r.cover,
  cardCrop: toCrop(r.crop_x, r.crop_y, r.crop_size),
  lastTakenAt: r.last_at,
});

/** Species for the life list, by common name (scientific name where there is none). */
export async function listSpecies(db: Db, filter: SpeciesFilter): Promise<SpeciesRow[]> {
  const rows = await db.all<RawSpecies>(
    `${SPECIES_SQL} WHERE ${WHERE[filter]} ORDER BY COALESCE(sp.common_name, sp.scientific_name) COLLATE NOCASE`,
  );
  return rows.map(speciesFrom);
}

export async function getSpecies(db: Db, scientificName: string): Promise<SpeciesRow | null> {
  const row = await db.get<RawSpecies>(`${SPECIES_SQL} WHERE sp.scientific_name = ?`, [scientificName]);
  return row ? speciesFrom(row) : null;
}

/** Counts for the life list's filter chips. */
export async function speciesCounts(db: Db): Promise<Record<SpeciesFilter, number>> {
  const out = {} as Record<SpeciesFilter, number>;
  for (const f of Object.keys(WHERE) as SpeciesFilter[]) {
    const r = await db.get<{ n: number }>(`SELECT count(*) AS n FROM (${SPECIES_SQL} WHERE ${WHERE[f]})`);
    out[f] = Number(r?.n ?? 0);
  }
  return out;
}

/** Every species this phone knows (life list, checklists, photos), for name search. */
export async function allSpecies(db: Db): Promise<SpeciesRow[]> {
  return (
    await db.all<RawSpecies>(`${SPECIES_SQL} ORDER BY COALESCE(sp.common_name, sp.scientific_name) COLLATE NOCASE`)
  ).map(speciesFrom);
}
