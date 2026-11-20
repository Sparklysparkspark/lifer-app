// A deterministic extreme library for the sweeps and for screenshots: 5,000 species, 60,000
// photos, 300-character names, a 50-state country, hundreds of exclusions, 1,000 albums, 500
// trips, missing files, empty fields, sensitive species and videos. Written straight to the
// database in bulk SQL, with every photo sharing the same few tiny image files.
//
// It only runs against lifer_test or an e2e database: every entry point refuses anything else.
//   npx tsx e2e/support/extremeLibrary.ts [extreme|sparse|empty|clear]   (TEST_DATABASE_URL, default below)
// Then open the app on it with: DATABASE_URL=<that url> npm run dev -w api
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "@node-rs/argon2";
import pg, { type ClientBase } from "pg";
import sharp from "sharp";

export const TEST_DATABASE_URL = "postgres://lifer:lifer@localhost:5432/lifer_test";
export const EXTREME_ACCOUNT = { email: "extreme@lifer.test", password: "correct horse battery staple" };
// The seeds' country (region 2 of insertRegions). A bare / only opens it while it is the one
// downloaded country, and the packs earlier specs downloaded stay.
export const SEED_COLLECTION = "/?region=e0000000-0003-4000-8000-000000000002";

const LONG = 300;

interface Sizes {
  species: number;
  photos: number;
  trips: number;
  albums: number;
  states: number;
}
const EXTREME: Sizes = { species: 5000, photos: 60_000, trips: 500, albums: 1000, states: 50 };
const SPARSE: Sizes = { species: 1, photos: 1, trips: 1, albums: 1, states: 1 };

// Ids are e0000000-<kind>-4000-8000-<index>, so every run makes the same rows.
const KIND = { user: 1, species: 2, region: 3, trip: 4, capture: 5, photo: 6, album: 7 } as const;
const idSql = (kind: keyof typeof KIND, index: string) =>
  `('e0000000-${String(KIND[kind]).padStart(4, "0")}-4000-8000-' || lpad(to_hex(${index}), 12, '0'))::uuid`;
const USER_ID = `e0000000-${String(KIND.user).padStart(4, "0")}-4000-8000-000000000000`;
const GBIF_BASE = 970_000_000;

// The same rule startServer uses for wiping, plus the integration-test database. Never "lifer".
const isSeedableName = (name: string) => name === "lifer_test" || name.includes("e2e");

/** Throws unless this connection is the test database. Called before every write.
 *  Schema-qualified so a search_path set through the URL can't shadow it. */
export async function assertTestDatabase(db: ClientBase): Promise<void> {
  const { rows } = await db.query<{ db: string }>("SELECT pg_catalog.current_database() AS db");
  if (!isSeedableName(rows[0].db)) {
    throw new Error(
      `Refusing to seed "${rows[0].db}": the extreme seed only runs against lifer_test or an e2e database.`,
    );
  }
}

export interface SeedFiles {
  thumb: string;
  display: string;
  original: string;
}

/** Writes the few shared image files every seeded photo points at. */
export async function writeSharedImages(dir = path.join(os.tmpdir(), "lifer-extreme")): Promise<SeedFiles> {
  mkdirSync(dir, { recursive: true });
  const base = sharp({ create: { width: 480, height: 320, channels: 3, background: "#6b8f71" } });
  const files = {
    thumb: path.join(dir, "thumb.webp"),
    display: path.join(dir, "display.webp"),
    original: path.join(dir, "original.jpg"),
  };
  await base.clone().resize(160, 107).webp().toFile(files.thumb);
  await base.clone().webp().toFile(files.display);
  writeFileSync(files.original, await base.clone().jpeg().toBuffer());
  return files;
}

// Removes what an earlier run made (and only that), so a re-run is the same and other rows stay.
async function reset(db: ClientBase): Promise<void> {
  await db.query("DELETE FROM users WHERE id = $1", [USER_ID]);
  await db.query("DELETE FROM species WHERE gbif_key > $1 AND gbif_key <= $2", [
    GBIF_BASE,
    GBIF_BASE + EXTREME.species,
  ]);
  await db.query("DELETE FROM regions WHERE id::text LIKE 'e0000000-%'");
  await db.query("DELETE FROM downloaded_packs WHERE pack_id LIKE 'extreme-%'");
}

async function insertUser(db: ClientBase): Promise<void> {
  await db.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)", [
    USER_ID,
    EXTREME_ACCOUNT.email,
    await hash(EXTREME_ACCOUNT.password),
  ]);
}

// Species 0 to 2 use names from eBird's sensitive list (core/species/sensitiveSpecies.ts).
const SENSITIVE = ["Ara ambiguus", "Anodorhynchus glaucus", "Aratinga solstitialis"];

async function insertSpecies(db: ClientBase, count: number): Promise<void> {
  await db.query(
    `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class, family, taxon_order, sort_order)
     SELECT ${idSql("species", "i")}, $1 + i + 1,
       CASE WHEN i < 3 THEN ($2::text[])[i + 1] ELSE 'Extremus sp' || lpad(i::text, 4, '0') END,
       CASE WHEN i % 50 = 0 THEN NULL
            WHEN i % 97 = 1 THEN left(repeat('Extraordinarily Long Common Name ', 12), $3)
            ELSE 'Extreme Species ' || lpad(i::text, 4, '0') END,
       CASE WHEN i % 10 < 7 THEN 'aves' WHEN i % 10 < 9 THEN 'mammalia' ELSE 'reptilia' END,
       CASE WHEN i % 40 = 0 THEN NULL ELSE 'Family' || (i % 120) END,
       'Order' || (i % 25), i + 1
     FROM generate_series(0, $4::int - 1) AS i`,
    [GBIF_BASE, SENSITIVE, LONG, count],
  );
}

async function insertRegions(db: ClientBase, states: number): Promise<void> {
  const region = (n: number) => idSql("region", String(n));
  // 0 world, 1 continent, 2 country, 10 + s the states.
  await db.query(`INSERT INTO regions (id, name, has_children) VALUES (${region(0)}, 'Extreme World', true)`);
  await db.query(
    `INSERT INTO regions (id, name, parent_id, has_children) VALUES (${region(1)}, 'Extreme Continent', ${region(0)}, true)`,
  );
  await db.query(
    `INSERT INTO regions (id, name, parent_id, external_codes, sovereignty_group, has_children, subdivision_type)
     VALUES (${region(2)}, 'Extreme States of America', ${region(1)}, '{XSA}', 'XSA', true, 'state')`,
  );
  await db.query(
    `INSERT INTO regions (id, name, parent_id, has_children, subdivision_type)
     SELECT ${idSql("region", "10 + s")},
       CASE WHEN s = 6 THEN left(repeat('Extraordinarily Long State Name ', 12), $1)
            ELSE 'Extreme State ' || lpad((s + 1)::text, 2, '0') END,
       ${region(2)}, false, 'state'
     FROM generate_series(0, $2::int - 1) AS s`,
    [LONG, states],
  );
}

// Without an installed pack the Collection shows its welcome screen instead of the country, and
// without occurrence_computed_at it offers the download. A NULL taxon is an all-taxa pack.
async function insertPack(db: ClientBase, species: number): Promise<void> {
  await db.query(
    `INSERT INTO downloaded_packs (pack_id, region, taxon, species_count) VALUES ('extreme-xsa-all', 'Extreme States of America', NULL, $1)`,
    [species],
  );
  await db.query(
    `INSERT INTO pack_species (pack_id, species_id, provided_enrichment)
     SELECT 'extreme-xsa-all', ${idSql("species", "i")}, true FROM generate_series(0, $1::int - 1) AS i`,
    [species],
  );
  await db.query(`UPDATE regions SET occurrence_computed_at = now() WHERE id = ${idSql("region", "2")}`);
}

// Overall tiers for Stats, every tier including unrated.
async function insertRarity(db: ClientBase, species: number): Promise<void> {
  await db.query(
    `INSERT INTO species_rarity (species_id, tier)
     SELECT ${idSql("species", "i")}, (ARRAY['common','occasional','uncommon','rare','legendary','unrated'])[i % 6 + 1]
     FROM generate_series(0, $1::int - 1) AS i`,
    [species],
  );
}

async function insertChecklists(db: ClientBase, count: number): Promise<void> {
  const tier = `(ARRAY['common','occasional','uncommon','rare','legendary'])[i % 5 + 1]`;
  await db.query(
    `INSERT INTO region_species (region_id, species_id, local_tier, local_frequency)
     SELECT ${idSql("region", "2")}, ${idSql("species", "i")}, ${tier}, (i % 100) / 100.0
     FROM generate_series(0, $1::int - 1) AS i`,
    [count],
  );
  await db.query(
    `INSERT INTO region_species (region_id, species_id, local_tier, local_frequency)
     SELECT ${idSql("region", "10 + i % 50")}, ${idSql("species", "i")}, ${tier}, (i % 100) / 100.0
     FROM generate_series(0, $1::int - 1) AS i`,
    [count],
  );
  // Hundreds of species the user hid from the country's checklist.
  await db.query(
    `INSERT INTO region_species_hidden (user_id, region_id, species_id)
     SELECT $1, ${idSql("region", "2")}, ${idSql("species", "i")} FROM generate_series(100, 399) AS i
     WHERE i < $2::int`,
    [USER_ID, count],
  );
}

async function insertTrips(db: ClientBase, n: Sizes): Promise<void> {
  await db.query(
    `INSERT INTO trips (id, user_id, name, source_folder, destination_folder, start_date, end_date, region_id, description)
     SELECT ${idSql("trip", "i")}, $1,
       CASE WHEN i % 50 = 7 THEN left(repeat('An Extraordinarily Long Trip Name ', 12), $2)
            ELSE 'Extreme Trip ' || lpad(i::text, 3, '0') END,
       '/nonexistent/extreme/source/' || i, '/nonexistent/extreme/library/' || i,
       CASE WHEN i % 10 = 0 THEN NULL ELSE DATE '2015-01-01' + i * 7 END,
       CASE WHEN i % 10 = 0 THEN NULL ELSE DATE '2015-01-01' + i * 7 + 5 END,
       ${idSql("region", "10 + i % 50")},
       CASE WHEN i % 2 = 0 THEN NULL ELSE 'Trip notes ' || i END
     FROM generate_series(0, $3::int - 1) AS i`,
    [USER_ID, LONG, n.trips],
  );
}

// The last 500 species (fewer in a small seed) are not collected: 300 seen, 100 targeted, the rest untouched.
const uncollected = (n: Sizes) => Math.min(500, Math.floor(n.species / 10));

async function insertPhotos(db: ClientBase, files: SeedFiles, n: Sizes): Promise<void> {
  await db.query(
    `INSERT INTO captures_all (id, user_id, species_id, fingerprint, taken_at, lat, lon, camera_model, quality_rating,
       trip_id, region_id, location_label, hidden_at, deleted_at, subject_count)
     SELECT ${idSql("capture", "i")}, $1, ${idSql("species", "i % $2::int")}, 'extreme-' || i,
       CASE WHEN i % 53 = 0 THEN NULL ELSE TIMESTAMPTZ '2015-01-01 08:00+00' + i * INTERVAL '37 minutes' END,
       CASE WHEN i % 11 = 0 THEN NULL ELSE -90 + (i % 1800) / 10.0 END,
       CASE WHEN i % 11 = 0 THEN NULL ELSE -180 + (i % 3600) / 10.0 END,
       CASE WHEN i % 7 = 0 THEN NULL ELSE 'Extreme Camera ' || (i % 9) END,
       CASE WHEN i % 5 = 0 THEN NULL ELSE i % 5 + 1 END,
       CASE WHEN i % 7 = 6 THEN NULL ELSE ${idSql("trip", "i % $3::int")} END,
       ${idSql("region", "10 + i % 50")},
       CASE WHEN i % 13 = 0 THEN NULL
            WHEN i % 1000 = 5 THEN left(repeat('An Extraordinarily Long Place Name ', 12), $4)
            ELSE 'Extreme Place ' || (i % 700) END,
       CASE WHEN i % 400 = 399 THEN now() END,
       CASE WHEN i % 900 = 1 THEN now() END,
       i % 4
     FROM generate_series(0, $5::int - 1) AS i`,
    [USER_ID, n.species - uncollected(n), n.trips, LONG, n.photos],
  );
  // Every 100th capture (offset 7) is a video; its poster frame is the shared still.
  await db.query(
    `INSERT INTO photos (id, capture_id, display_path, thumb_path, width, height, kind, duration_seconds)
     SELECT ${idSql("photo", "i")}, ${idSql("capture", "i")}, $1, $2,
       CASE i % 3 WHEN 0 THEN 480 WHEN 1 THEN 320 ELSE 480 END,
       CASE i % 3 WHEN 0 THEN 320 WHEN 1 THEN 480 ELSE 480 END,
       CASE WHEN i % 100 = 7 THEN 'video' ELSE 'image' END,
       CASE WHEN i % 100 = 7 THEN 3 + i % 120 END
     FROM generate_series(0, $3::int - 1) AS i`,
    [files.display, files.thumb, n.photos],
  );
  await db.query(
    `UPDATE captures_all c SET current_photo_id = p.id FROM photos p WHERE p.capture_id = c.id AND c.user_id = $1`,
    [USER_ID],
  );
  // Every 50th (offset 3) original is gone from disk.
  await db.query(
    `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size, user_id, species_id, health)
     SELECT ${idSql("capture", "i")}, CASE WHEN i % 100 = 7 THEN 'video' ELSE 'jpeg' END, 'path',
       CASE WHEN i % 50 = 3 THEN '/nonexistent/extreme/missing/IMG_' || i || '.jpg' ELSE $1 END,
       false, 'extreme-' || i, 4096, $2, ${idSql("species", "i % $3::int")},
       CASE WHEN i % 50 = 3 THEN 'missing' END
     FROM generate_series(0, $4::int - 1) AS i`,
    [files.original, USER_ID, n.species - uncollected(n), n.photos],
  );
}

async function insertCollection(db: ClientBase, n: Sizes): Promise<void> {
  await db.query(
    `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, first_collected, best_quality, is_target)
     SELECT $1, ${idSql("species", "i")},
       CASE WHEN i < $2::int THEN 'collected' WHEN i < $2::int + 300 THEN 'seen' END,
       CASE WHEN i < $2::int THEN ${idSql("photo", "i")} END,
       CASE WHEN i < $2::int THEN DATE '2012-01-01' + i END,
       CASE WHEN i < $2::int THEN i % 5 + 1 END,
       i >= $2::int + 300 AND i < $2::int + 400
     FROM generate_series(0, $3::int - 1) AS i WHERE i < $2::int + 400`,
    [USER_ID, n.species - uncollected(n), n.species],
  );
}

async function insertAlbums(db: ClientBase, n: Sizes): Promise<void> {
  await db.query(
    `INSERT INTO albums (id, user_id, name, description, cover_photo_id)
     SELECT ${idSql("album", "i")}, $1,
       CASE WHEN i % 100 = 9 THEN left(repeat('An Extraordinarily Long Album Name ', 12), $2)
            ELSE 'Extreme Album ' || lpad(i::text, 4, '0') END,
       CASE WHEN i % 2 = 0 THEN NULL ELSE 'Album notes ' || i END,
       ${idSql("photo", "i * 60 % $4::int")}
     FROM generate_series(0, $3::int - 1) AS i`,
    [USER_ID, LONG, n.albums, n.photos],
  );
  // 60 photos per album, and 300 photos the first album had removed.
  await db.query(
    `INSERT INTO album_captures (album_id, capture_id)
     SELECT ${idSql("album", "a")}, ${idSql("capture", "a * 60 + k")}
     FROM generate_series(0, $1::int - 1) AS a, generate_series(0, 59) AS k WHERE a * 60 + k < $2::int`,
    [n.albums, n.photos],
  );
  await db.query(
    `INSERT INTO album_exclusions (album_id, capture_id)
     SELECT ${idSql("album", "0")}, ${idSql("capture", "i")} FROM generate_series(30000, 30299) AS i
     WHERE i < $1::int`,
    [n.photos],
  );
}

async function inTransaction(db: ClientBase, work: () => Promise<void>): Promise<void> {
  await assertTestDatabase(db);
  await db.query("BEGIN");
  try {
    await reset(db);
    await work();
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  }
  // Fresh statistics, so the next seed's cascading delete isn't planned for empty tables (the
  // specs reseed back to back, before autovacuum has looked).
  await db.query("ANALYZE");
}

/** The full extreme library. Replaces its own earlier rows and leaves everything else alone. */
export async function seedExtreme(db: ClientBase, files?: SeedFiles): Promise<void> {
  const shared = files ?? (await writeSharedImages());
  await inTransaction(db, async () => {
    await insertUser(db);
    await insertSpecies(db, EXTREME.species);
    await insertRarity(db, EXTREME.species);
    await insertRegions(db, EXTREME.states);
    await insertChecklists(db, EXTREME.species);
    await insertPack(db, EXTREME.species);
    await insertTrips(db, EXTREME);
    await insertPhotos(db, shared, EXTREME);
    await insertCollection(db, EXTREME);
    await insertAlbums(db, EXTREME);
  });
}

/** The opposite end: an account with one species, one photo, one trip and one album, or
 *  with `items: 0` nothing at all but the account and its region. */
export async function seedSparse(db: ClientBase, { items = 1 }: { items?: 0 | 1 } = {}): Promise<void> {
  const files = await writeSharedImages();
  await inTransaction(db, async () => {
    await insertUser(db);
    await insertRegions(db, SPARSE.states);
    if (items === 0) return;
    await insertSpecies(db, SPARSE.species);
    await insertRarity(db, SPARSE.species);
    await insertPack(db, SPARSE.species);
    await db.query(
      `INSERT INTO region_species (region_id, species_id, local_tier) VALUES (${idSql("region", "2")}, ${idSql("species", "0")}, 'common')`,
    );
    await insertTrips(db, SPARSE);
    await insertPhotos(db, files, SPARSE);
    await insertCollection(db, SPARSE);
    await insertAlbums(db, SPARSE);
  });
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "extreme";
  const url = process.env.TEST_DATABASE_URL ?? TEST_DATABASE_URL;
  // Checked on the URL before connecting, and again on the live connection by assertTestDatabase.
  const dbName = new URL(url).pathname.slice(1);
  if (!isSeedableName(dbName)) {
    throw new Error(`Refusing "${dbName}": the extreme seed only runs against lifer_test or an e2e database.`);
  }
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    const started = Date.now();
    if (mode === "extreme") await seedExtreme(db);
    else if (mode === "sparse") await seedSparse(db);
    else if (mode === "empty") await seedSparse(db, { items: 0 });
    else if (mode === "clear") await inTransaction(db, async () => {});
    else throw new Error(`Unknown mode "${mode}": use extreme, sparse, empty or clear.`);
    console.log(
      `Seeded "${mode}" into ${new URL(url).pathname.slice(1)} in ${((Date.now() - started) / 1000).toFixed(1)}s.`,
    );
    console.log(`Sign in as ${EXTREME_ACCOUNT.email} / ${EXTREME_ACCOUNT.password}`);
  } finally {
    await db.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
