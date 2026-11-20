// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database. The desktop side of
// albums, trips and membership: the pull never overwrites an edit not pushed yet, the push sends
// what changed with its base, and a conflict takes the server's copy.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AlbumChange } from "./library.js";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000b01";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000b0a";
const CAPTURE = "eeeeeeee-0000-4000-8000-000000000b11";
const SERVER_CAPTURE = "eeeeeeee-0000-4000-8000-000000000b12";
const ALBUM = "eeeeeeee-0000-4000-8000-000000000b21";
const TRIP = "eeeeeeee-0000-4000-8000-000000000b31";

const serverAlbum = (over: Partial<AlbumChange> = {}): AlbumChange => ({
  id: ALBUM,
  name: "From the server",
  description: null,
  coverPhotoId: null,
  coverCropX: null,
  coverCropY: null,
  coverCropSize: null,
  coverLayout: "single",
  quadPhotoIds: null,
  quadCrops: null,
  rules: null,
  updatedAt: "2026-06-01T00:00:00.000000Z",
  ...over,
});

describe.skipIf(!url)("library mirror", () => {
  let db: pg.Pool;
  let lib: typeof import("./libraryMirror.js");
  const row = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows[0];
  async function cleanup() {
    await db.query(`DELETE FROM albums WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM trips WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM saved_spots WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM sync_tombstones WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
  }
  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    lib = await import("./libraryMirror.js");
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'libmirror@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, scientific_name, common_name, taxon_class, gbif_key) VALUES ($1, 'Zzlibmirror testus', 'Mirror Bird', 'aves', 980401)`,
      [SPECIES],
    );
    // A photo imported here and pushed: the server calls it SERVER_CAPTURE.
    await db.query(
      `INSERT INTO captures_all (id, user_id, species_id, fingerprint, remote_id, pushed_at, origin) VALUES ($1, $2, $3, 'lm-1', $4, now(), 'local')`,
      [CAPTURE, USER, SPECIES, SERVER_CAPTURE],
    );
  });
  afterAll(async () => {
    await cleanup();
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("takes the server's album as already pushed, keeps a local edit through a pull, and force replaces it", async () => {
    expect(await lib.applyRows(db, USER, "albums", [serverAlbum()])).toBe(1);
    expect(await row(`SELECT name, pushed_at >= updated_at AS settled FROM albums WHERE id = $1`, [ALBUM])).toEqual({
      name: "From the server",
      settled: true,
    });
    await db.query(`UPDATE albums SET name = 'Mine' WHERE id = $1`, [ALBUM]);
    expect(await lib.unpushedLibraryCount(USER)).toBe(1);
    expect(await lib.applyRows(db, USER, "albums", [serverAlbum({ name: "Server edit" })])).toBe(0);
    expect((await row(`SELECT name FROM albums WHERE id = $1`, [ALBUM])).name).toBe("Mine");
    expect(await lib.applyRows(db, USER, "albums", [serverAlbum({ name: "Server edit" })], true)).toBe(1);
    expect(await lib.unpushedLibraryCount(USER)).toBe(0);
  });

  it("resolves a membership row by the server's id for a capture pushed from here", async () => {
    const rows = [{ albumId: ALBUM, captureId: SERVER_CAPTURE }];
    expect(await lib.applyMembers(db, USER, "album_captures", rows)).toBe(1);
    expect(await lib.applyMembers(db, USER, "album_captures", rows)).toBe(0);
    expect((await row(`SELECT capture_id FROM album_captures WHERE album_id = $1`, [ALBUM])).capture_id).toBe(CAPTURE);
    expect(await lib.unpushedLibraryCount(USER)).toBe(0);
  });

  it("pushes new and edited rows with their base and records what the server took", async () => {
    await db.query(
      `INSERT INTO trips (id, user_id, name, source_folder, destination_folder, cover_capture_id) VALUES ($1, $2, 'Trip', '/t', '/t/w', $3)`,
      [TRIP, USER, CAPTURE],
    );
    await db.query(`UPDATE albums SET name = 'Renamed here' WHERE id = $1`, [ALBUM]);
    const sent: { trips?: Record<string, unknown>[]; albums?: Record<string, unknown>[] }[] = [];
    const reply = (id: string) => ({
      albums: [],
      trips: [],
      savedSpots: [],
      members: { applied: 0, skipped: 0 },
      deleted: 0,
      ...{ [id]: [] },
    });
    const pushed = await lib.pushLibraryRows(USER, async (body) => {
      sent.push(body as never);
      const items = (body.trips ?? body.albums ?? []) as { id: string }[];
      const key = body.trips ? "trips" : "albums";
      return {
        ...reply(key),
        [key]: items.map((i) => ({ id: i.id, status: "updated", updatedAt: "2026-07-01T00:00:00.000000Z" })),
      };
    });
    expect(pushed).toEqual({ pushed: 2, conflicts: 0 });
    // The trip's cover goes by the server's id; the album's base is the version the server last had.
    expect(sent[0].trips?.[0]).toMatchObject({ id: TRIP, coverCaptureId: SERVER_CAPTURE, baseUpdatedAt: null });
    expect(sent[1].albums?.[0]).toMatchObject({ id: ALBUM, name: "Renamed here" });
    expect(sent[1].albums?.[0].baseUpdatedAt).toMatch(/^2026-06-01T00:00:00/);
    expect(await lib.unpushedLibraryCount(USER)).toBe(0);
  });

  it("pushes a saved spot, then a pull of the same spot leaves nothing waiting", async () => {
    const SPOT = "a1b2c3d4-0000-4000-8000-0000000000e1";
    await db.query(`INSERT INTO saved_spots (id, user_id, name, lat, lon) VALUES ($1, $2, 'Pond', 49.5, -123.5)`, [
      SPOT,
      USER,
    ]);
    expect(await lib.unpushedLibraryCount(USER)).toBe(1);
    const sent: Record<string, unknown>[][] = [];
    const pushed = await lib.pushLibraryRows(USER, async (body) => {
      if (!body.savedSpots) return undefined;
      sent.push(body.savedSpots as Record<string, unknown>[]);
      return {
        albums: [],
        trips: [],
        savedSpots: [{ id: SPOT, status: "updated", updatedAt: "2026-07-02T00:00:00.000000Z" }],
        members: { applied: 0, skipped: 0 },
        deleted: 0,
      } as never;
    });
    expect(pushed.pushed).toBe(1);
    expect(sent[0][0]).toMatchObject({ id: SPOT, name: "Pond", lat: 49.5, lon: -123.5, geoprivacy: "open" });
    expect(await lib.unpushedLibraryCount(USER)).toBe(0);
    expect(
      await lib.applyRows(db, USER, "saved_spots", [
        { ...sent[0][0], name: "Pond 2", updatedAt: "2026-07-03T00:00:00.000000Z" } as never,
      ]),
    ).toBe(1);
    expect((await row(`SELECT name FROM saved_spots WHERE id = $1`, [SPOT])).name).toBe("Pond 2");
  });

  it("takes the server's copy on a conflict and drops a row the server deleted", async () => {
    await db.query(`UPDATE albums SET name = 'Edited again' WHERE id = $1`, [ALBUM]);
    await db.query(`UPDATE trips SET name = 'Trip edited' WHERE id = $1`, [TRIP]);
    const reply = (key: "albums" | "trips", outcome: object) => ({
      albums: [],
      trips: [],
      savedSpots: [],
      members: { applied: 0, skipped: 0 },
      deleted: 0,
      [key]: [outcome],
    });
    const pushed = await lib.pushLibraryRows(USER, async (body) => {
      if (body.trips) return reply("trips", { id: TRIP, status: "conflict", current: null }) as never;
      return reply("albums", { id: ALBUM, status: "conflict", current: serverAlbum({ name: "Server won" }) }) as never;
    });
    expect(pushed).toEqual({ pushed: 0, conflicts: 2 });
    expect((await row(`SELECT name FROM albums WHERE id = $1`, [ALBUM])).name).toBe("Server won");
    expect(await row(`SELECT 1 FROM trips WHERE id = $1`, [TRIP])).toBeUndefined();
    // Dropping what the server deleted isn't a deletion to send back.
    expect(await lib.unpushedLibraryCount(USER)).toBe(0);
    expect((await row(`SELECT count(*)::int AS n FROM sync_tombstones WHERE user_id = $1`, [USER])).n).toBe(0);
  });

  it("sends membership and deletions made here, and forgets deletions once sent", async () => {
    await db.query(`DELETE FROM album_captures WHERE album_id = $1`, [ALBUM]);
    await db.query(`INSERT INTO album_exclusions (album_id, capture_id) VALUES ($1, $2)`, [ALBUM, CAPTURE]);
    const sent: object[] = [];
    const send = async (body: object) => {
      sent.push(body);
      return undefined;
    };
    expect(await lib.pushLibraryMembers(USER, send)).toBe(1);
    expect(sent[0]).toEqual({ albumExclusions: [{ albumId: ALBUM, captureId: SERVER_CAPTURE }] });
    expect(await lib.pushLibraryDeletions(USER, send)).toBe(1);
    expect(sent[1]).toMatchObject({ deleted: { albumCaptures: [{ albumId: ALBUM, captureId: SERVER_CAPTURE }] } });
    expect(await lib.unpushedLibraryCount(USER)).toBe(0);
  });

  it("asks before starting over for a server with a new instance id, and keeps everything until told", async () => {
    const { adoptServer, pendingServer, ServerChangedError } = await import("./mirror.js");
    const { pool } = await import("@lifer/core/db.js");
    const saved = (await db.query(`SELECT value FROM install_settings WHERE key = 'sync_instance'`)).rows[0];
    await db.query(
      `INSERT INTO install_settings (key, value) VALUES ('sync_instance', '"old-server"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    try {
      await db.query(`UPDATE captures_all SET pushed_at = now() WHERE id = $1`, [CAPTURE]);
      await expect(adoptServer(USER, "new-server")).rejects.toBeInstanceOf(ServerChangedError);
      expect(await pendingServer(pool)).toBe("new-server");
      expect(
        (await row(`SELECT pushed_at IS NOT NULL AS pushed FROM captures_all WHERE id = $1`, [CAPTURE])).pushed,
      ).toBe(true);
      // The old server answering again clears the question.
      await adoptServer(USER, "old-server");
      expect(await pendingServer(pool)).toBeNull();
      await expect(adoptServer(USER, "new-server")).rejects.toBeInstanceOf(ServerChangedError);
      await adoptServer(USER, "new-server", true);
      expect(await pendingServer(pool)).toBeNull();
      expect(await row(`SELECT pushed_at, remote_id FROM captures_all WHERE id = $1`, [CAPTURE])).toEqual({
        pushed_at: null,
        remote_id: null,
      });
    } finally {
      if (saved)
        await db.query(`UPDATE install_settings SET value = $1 WHERE key = 'sync_instance'`, [
          JSON.stringify(saved.value),
        ]);
      else await db.query(`DELETE FROM install_settings WHERE key = 'sync_instance'`);
    }
  });
});
