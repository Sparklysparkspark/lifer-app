// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database. Albums, trips and
// membership over the sync protocol: the feeds page by (updated_at, ref) with deletions as refs,
// and a push writes a row only if the server's copy is unchanged since the sender's base.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  AlbumPageSchema,
  PushedAlbumSchema,
  PushedTripSchema,
  TripPageSchema,
  applyPushedLibraryDeletions,
  applyPushedMembers,
  applyPushedRows,
  FIRST_LIBRARY_CURSOR,
  listLibraryChanges,
  type PushedAlbum,
  type PushedSpot,
  type PushedTrip,
} from "./library.js";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000a01";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000a0a";
const CAPTURE = "eeeeeeee-0000-4000-8000-000000000a11";
const ALBUM = "eeeeeeee-0000-4000-8000-000000000a21";
const ALBUM_2 = "eeeeeeee-0000-4000-8000-000000000a22";
const TRIP = "eeeeeeee-0000-4000-8000-000000000a31";

const album = (over: Partial<PushedAlbum> = {}): PushedAlbum => ({
  id: ALBUM,
  name: "Herons",
  description: null,
  coverPhotoId: null,
  coverCropX: null,
  coverCropY: null,
  coverCropSize: null,
  coverLayout: "single",
  quadPhotoIds: null,
  quadCrops: null,
  rules: { species: ["Ardea herodias"] },
  baseUpdatedAt: null,
  ...over,
});
const trip = (over: Partial<PushedTrip> = {}): PushedTrip => ({
  id: TRIP,
  name: "Pantanal",
  description: null,
  sourceFolder: "/photos/pantanal",
  destinationFolder: "/photos/pantanal/Wildlife",
  coverCaptureId: null,
  coverCropX: null,
  coverCropY: null,
  coverCropSize: null,
  coverLayout: "single",
  quadPhotoIds: null,
  quadCrops: null,
  startDate: "2026-05-01",
  endDate: "2026-05-09",
  regionId: null,
  activeOverride: null,
  baseUpdatedAt: null,
  ...over,
});

describe.skipIf(!url)("library sync", () => {
  let db: pg.Pool;
  async function cleanup() {
    await db.query(`DELETE FROM albums WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM trips WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM sync_tombstones WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
  }
  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'lib@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, scientific_name, common_name, taxon_class, gbif_key) VALUES ($1, 'Zzlib testus', 'Lib Bird', 'aves', 980301)`,
      [SPECIES],
    );
    await db.query(`INSERT INTO captures_all (id, user_id, species_id, fingerprint) VALUES ($1, $2, $3, 'lib-1')`, [
      CAPTURE,
      USER,
      SPECIES,
    ]);
  });
  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  it("inserts a new album and trip, then takes edits only from the version the sender had", async () => {
    const [a] = await applyPushedRows(db, USER, "albums", [album()]);
    const [t] = await applyPushedRows(db, USER, "trips", [trip()]);
    expect(a.status).toBe("updated");
    expect(t.status).toBe("updated");
    const base = a.status === "updated" ? a.updatedAt : "";

    const [renamed] = await applyPushedRows(db, USER, "albums", [
      album({ name: "Great blue herons", baseUpdatedAt: base }),
    ]);
    expect(renamed.status).toBe("updated");
    // The same base again is stale now: the server's copy wins and comes back.
    const [stale] = await applyPushedRows(db, USER, "albums", [album({ name: "Stale", baseUpdatedAt: base })]);
    expect(stale).toMatchObject({ status: "conflict", current: { name: "Great blue herons" } });
    // Pushing a row the server has, with no base, is a conflict too.
    const [dup] = await applyPushedRows(db, USER, "albums", [album({ name: "Dup" })]);
    expect(dup.status).toBe("conflict");
    const { rows } = await db.query(`SELECT name, rules FROM albums WHERE id = $1`, [ALBUM]);
    expect(rows[0]).toEqual({ name: "Great blue herons", rules: { species: ["Ardea herodias"] } });
  });

  it("renames a pushed spot whose name another spot here already uses", async () => {
    const spot = (id: string, name: string): PushedSpot => ({
      id,
      name,
      lat: 49.5,
      lon: -123.5,
      regionId: null,
      geoprivacy: "open",
      baseUpdatedAt: null,
    });
    const ids = [1, 2, 3].map((n) => `eeeeeeee-0000-4000-8000-000000000a4${n}`);
    const out = await applyPushedRows(db, USER, "savedSpots", [
      spot(ids[0], "Pond"),
      spot(ids[1], "pond"),
      spot(ids[2], "POND"),
    ]);
    expect(out.map((o) => o.status)).toEqual(["updated", "updated", "updated"]);
    const names = await db.query(`SELECT name FROM saved_spots WHERE user_id = $1 ORDER BY created_at, name`, [USER]);
    expect(names.rows.map((r) => r.name)).toEqual(expect.arrayContaining(["Pond", "pond (2)", "POND (3)"]));
  });

  it("adds membership once and skips rows whose capture isn't here", async () => {
    await applyPushedRows(db, USER, "albums", [album({ id: ALBUM_2, name: "Second" })]);
    const unknown = "eeeeeeee-0000-4000-8000-000000000aff";
    const rows = [
      { albumId: ALBUM, captureId: CAPTURE },
      { albumId: ALBUM, captureId: unknown },
    ];
    expect(await applyPushedMembers(db, USER, "album_captures", rows)).toEqual({ applied: 1, skipped: 1 });
    expect((await applyPushedMembers(db, USER, "album_captures", rows)).applied).toBe(0);
    await applyPushedMembers(db, USER, "album_exclusions", [{ albumId: ALBUM_2, captureId: CAPTURE }]);
  });

  it("feeds and accepts a pushed stored 600-character name", async () => {
    const long = "n".repeat(600);
    await db.query(`UPDATE albums SET name = $2 WHERE id = $1`, [ALBUM, long]);
    await db.query(`UPDATE trips SET name = $2 WHERE id = $1`, [TRIP, long]);
    for (const [entity, schema] of [
      ["albums", AlbumPageSchema],
      ["trips", TripPageSchema],
    ] as const) {
      const page = await listLibraryChanges(db, USER, entity, FIRST_LIBRARY_CURSOR, 50);
      expect(page.items.some((i) => (i as { name: string }).name === long)).toBe(true);
      expect(Value.Check(schema, page)).toBe(true);
    }
    expect(Value.Check(PushedAlbumSchema, album({ name: "n".repeat(600) }))).toBe(true);
    expect(Value.Check(PushedTripSchema, trip({ name: "n".repeat(255) }))).toBe(true);
    expect(Value.Check(PushedTripSchema, trip({ name: long }))).toBe(true);
  });

  it("pages every entity with a cursor that never repeats a row", async () => {
    const first = await listLibraryChanges(db, USER, "albums", FIRST_LIBRARY_CURSOR, 1);
    expect(first.items).toHaveLength(1);
    expect(first.next).not.toBeNull();
    const second = await listLibraryChanges(db, USER, "albums", first.next!, 1);
    expect(second.items).toHaveLength(1);
    expect((second.items[0] as { id: string }).id).not.toBe((first.items[0] as { id: string }).id);
    const trips = await listLibraryChanges(db, USER, "trips", FIRST_LIBRARY_CURSOR, 50);
    expect(trips.items[0]).toMatchObject({ id: TRIP, startDate: "2026-05-01", sourceFolder: "/photos/pantanal" });
    const members = await listLibraryChanges(db, USER, "albumCaptures", FIRST_LIBRARY_CURSOR, 50);
    expect(members.items).toMatchObject([{ albumId: ALBUM, captureId: CAPTURE }]);
    expect(members.last?.after).toBe(`${ALBUM}:${CAPTURE}`);
    const excluded = await listLibraryChanges(db, USER, "albumExclusions", FIRST_LIBRARY_CURSOR, 50);
    expect(excluded.items).toHaveLength(1);
  });

  it("deletes by base and reports deletions as refs in the feed", async () => {
    const [{ u }] = (await db.query(`SELECT updated_at::text AS u FROM albums WHERE id = $1`, [ALBUM_2])).rows;
    // A delete from a version the server has moved past is ignored.
    await db.query(`UPDATE albums SET name = 'Moved on' WHERE id = $1`, [ALBUM_2]);
    expect(
      await applyPushedLibraryDeletions(db, USER, {
        albums: [{ id: ALBUM_2, baseUpdatedAt: new Date(Date.parse(u) - 5000).toISOString() }],
      }),
    ).toBe(0);
    expect(await applyPushedLibraryDeletions(db, USER, { albums: [{ id: ALBUM_2, baseUpdatedAt: null }] })).toBe(1);
    expect(
      await applyPushedLibraryDeletions(db, USER, { albumCaptures: [{ albumId: ALBUM, captureId: CAPTURE }] }),
    ).toBe(1);
    const albums = await listLibraryChanges(db, USER, "albums", FIRST_LIBRARY_CURSOR, 50);
    expect(albums.purged.map((p) => p.ref)).toEqual([ALBUM_2]);
    const members = await listLibraryChanges(db, USER, "albumCaptures", FIRST_LIBRARY_CURSOR, 50);
    expect(members.purged.map((p) => p.ref)).toEqual([`${ALBUM}:${CAPTURE}`]);
    // A pushed edit of a row the server deleted comes back as a conflict with no copy.
    const [gone] = await applyPushedRows(db, USER, "albums", [album({ id: ALBUM_2, baseUpdatedAt: u })]);
    expect(gone).toMatchObject({ status: "conflict", current: null });
  });
});
