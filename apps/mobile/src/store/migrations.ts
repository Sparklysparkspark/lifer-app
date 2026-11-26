import type { Db } from "./db";

// Append only: a shipped migration never changes. The version lives in PRAGMA user_version.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE species (
    scientific_name TEXT PRIMARY KEY,
    common_name TEXT,
    taxon_class TEXT,
    tier TEXT,
    sensitive INTEGER NOT NULL DEFAULT 0
  );

  -- A species mark: seen, photographed (collected) and the target flag. hub_version is the hub's
  -- copy as last seen (null: never seen one), sent back so the hub can tell a stale edit.
  CREATE TABLE marks (
    scientific_name TEXT PRIMARY KEY,
    state TEXT,
    is_target INTEGER NOT NULL DEFAULT 0,
    cover_photo_id TEXT,
    first_collected TEXT,
    best_quality INTEGER,
    card_crop_x REAL,
    card_crop_y REAL,
    card_crop_size REAL,
    hub_version TEXT,
    local_at TEXT NOT NULL
  );

  CREATE TABLE captures (
    id TEXT PRIMARY KEY,
    photo_id TEXT,
    scientific_name TEXT NOT NULL,
    taken_at TEXT,
    location_label TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    rating INTEGER,
    region_id TEXT,
    trip_id TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'image',
    width INTEGER,
    height INTEGER
  );
  CREATE INDEX captures_taken ON captures (taken_at DESC);
  CREATE INDEX captures_species ON captures (scientific_name, taken_at DESC);
  CREATE INDEX captures_trip ON captures (trip_id);
  CREATE INDEX captures_photo ON captures (photo_id);

  CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT NOT NULL, cover_photo_id TEXT);
  CREATE TABLE album_captures (
    album_id TEXT NOT NULL,
    capture_id TEXT NOT NULL,
    PRIMARY KEY (album_id, capture_id)
  ) WITHOUT ROWID;

  CREATE TABLE trips (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    start_date TEXT,
    end_date TEXT,
    region_id TEXT,
    cover_capture_id TEXT,
    active_override INTEGER,
    local INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE saved_spots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    region_id TEXT,
    geoprivacy TEXT NOT NULL DEFAULT 'open'
  );

  CREATE TABLE regions (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    hub_region_id TEXT,
    species_count INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    added_at TEXT NOT NULL
  );
  CREATE TABLE region_species (
    region_key TEXT NOT NULL,
    scientific_name TEXT NOT NULL,
    vagrant INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (region_key, scientific_name)
  ) WITHOUT ROWID;
  CREATE INDEX region_species_name ON region_species (scientific_name);

  CREATE TABLE sightings (
    id TEXT PRIMARY KEY,
    scientific_name TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    lat REAL,
    lon REAL,
    trip_id TEXT
  );
  CREATE INDEX sightings_species ON sightings (scientific_name);

  CREATE TABLE outbox (
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    created_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_try_at TEXT,
    PRIMARY KEY (kind, ref)
  ) WITHOUT ROWID;

  CREATE TABLE media (
    photo_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    last_used INTEGER NOT NULL,
    PRIMARY KEY (photo_id, kind)
  ) WITHOUT ROWID;
  CREATE INDEX media_lru ON media (kind, last_used);
  `,
  // One photo's image vector for offline search: 768 little-endian float16 numbers, unit length.
  `
  CREATE TABLE capture_vectors (capture_id TEXT PRIMARY KEY, vec BLOB NOT NULL) WITHOUT ROWID;
  `,
  // The cover crops of albums and trips (percent of the photo's width, as on the desktop). The
  // album and trip cursors reset so the next sync fetches them for rows already stored.
  `
  ALTER TABLE albums ADD COLUMN cover_crop_x REAL;
  ALTER TABLE albums ADD COLUMN cover_crop_y REAL;
  ALTER TABLE albums ADD COLUMN cover_crop_size REAL;
  ALTER TABLE trips ADD COLUMN cover_crop_x REAL;
  ALTER TABLE trips ADD COLUMN cover_crop_y REAL;
  ALTER TABLE trips ADD COLUMN cover_crop_size REAL;
  DELETE FROM meta WHERE key IN ('cursor.albums', 'cursor.trips');
  `,
  // Offline search reads more of each photo: where and with what it was taken (the capture feed is
  // pulled again to fill them), the species' order and family, the detector's subject box and light
  // stats per photo, and the background vectors ("tree in the background").
  `
  ALTER TABLE captures ADD COLUMN lat REAL;
  ALTER TABLE captures ADD COLUMN lon REAL;
  ALTER TABLE captures ADD COLUMN camera_model TEXT;
  ALTER TABLE captures ADD COLUMN focal_length_mm REAL;
  ALTER TABLE species ADD COLUMN taxon_order TEXT;
  ALTER TABLE species ADD COLUMN family TEXT;
  CREATE TABLE capture_frames (
    capture_id TEXT PRIMARY KEY,
    box TEXT,
    unsure INTEGER NOT NULL DEFAULT 0,
    aspect REAL NOT NULL,
    light TEXT,
    zoned INTEGER
  ) WITHOUT ROWID;
  CREATE TABLE capture_backgrounds (capture_id TEXT PRIMARY KEY, vec BLOB NOT NULL) WITHOUT ROWID;
  DELETE FROM meta WHERE key = 'cursor.captures';
  `,
  // What search reads of the hub's catalog: the region tree over the photos (so a named region
  // reaches its sub-regions), and each photographed species' other names and codes.
  `
  CREATE TABLE search_regions (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT) WITHOUT ROWID;
  CREATE TABLE species_names (scientific_name TEXT PRIMARY KEY, aliases TEXT NOT NULL, codes TEXT NOT NULL) WITHOUT ROWID;
  `,
  // Logging sightings is gone (Merlin does it better); trips and species facts read photos only.
  `
  DROP TABLE sightings;
  `,
  // Rarity by scope: a region's own tier sits on its checklist row and species.tier is the worldwide
  // one (it held the last synced region's). Kept checklists are fetched again to fill them. Also the
  // hub's Needs a better photo mark (null: not yet heard) and each album's cover as the desktop shows it.
  `
  ALTER TABLE region_species ADD COLUMN tier TEXT;
  ALTER TABLE region_species ADD COLUMN tier_reason TEXT;
  ALTER TABLE species ADD COLUMN tier_reason TEXT;
  ALTER TABLE marks ADD COLUMN needs_better_photo INTEGER;
  ALTER TABLE albums ADD COLUMN hub_cover_photo_id TEXT;
  DELETE FROM meta WHERE key LIKE 'regionSig.%';
  `,
  // Field guide order within a family (the hub's species sort order, null from an older hub), and a
  // province's home country so a photo in it also counts in that country. Kept checklists are fetched again.
  `
  ALTER TABLE species ADD COLUMN sort_order INTEGER;
  ALTER TABLE search_regions ADD COLUMN home_country_id TEXT;
  DELETE FROM meta WHERE key LIKE 'regionSig.%';
  `,
];

export async function migrate(db: Db): Promise<void> {
  const row = await db.get<{ user_version: number }>("PRAGMA user_version");
  const from = Number(row?.user_version ?? 0);
  for (let v = from; v < MIGRATIONS.length; v++) {
    await db.tx(async () => {
      await db.exec(MIGRATIONS[v]);
      await db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}
