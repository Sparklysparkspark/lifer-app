// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SINGLE_USER_MODE = "0";
});

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000951";
const SYNC_KEY = "lifer_test_sync_revoke_951";
const OTHER_KEY = "lifer_test_photos_only_951";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000095a";
const CAPTURE = "eeeeeeee-0000-4000-8000-000000000952";

describe.skipIf(!url)("sync key routes", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  async function cleanup() {
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM sync_tombstones WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
  }
  const keys = async () =>
    (await db.query<{ name: string }>(`SELECT name FROM api_keys WHERE user_id = $1 ORDER BY name`, [USER])).rows.map(
      (r) => r.name,
    );

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    const { hashApiKey } = await import("../auth/apiKeys.js");
    const { syncRoutes } = await import("./routes.js");
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'sync-revoke@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES
         ($1, 'desktop', $2, '{sync,photos.read}'), ($1, 'script', $3, '{photos.read}')`,
      [USER, hashApiKey(SYNC_KEY), hashApiKey(OTHER_KEY)],
    );
    await db.query(
      `INSERT INTO species (id, scientific_name, common_name, taxon_class, gbif_key) VALUES ($1, 'Zzsync routeus', 'Route Bird', 'aves', 980951)`,
      [SPECIES],
    );
    await db.query(
      `INSERT INTO captures_all (id, user_id, species_id, fingerprint, taken_at, tags) VALUES ($1, $2, $3, 'sync-route', '2026-05-01T08:00:00Z', '{kept}')`,
      [CAPTURE, USER, SPECIES],
    );
    app = Fastify();
    await app.register(cookie);
    await app.register(syncRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await cleanup();
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  const pushed = {
    id: CAPTURE,
    deletedAt: null,
    hiddenAt: null,
    scientificName: "Zzsync routeus",
    fingerprint: "sync-route",
    takenAt: "2026-05-01T08:00:00.000Z",
    lat: 51.5,
    lon: null,
    cameraModel: null,
    lens: null,
    focalLengthMm: null,
    aperture: null,
    shutter: null,
    iso: null,
    qualityRating: 4,
    tags: ["kept"],
    locationLabel: null,
    regionId: null,
    cullVerdict: null,
    cullLabel: null,
    baseUpdatedAt: null as string | null,
  };
  const push = (captures: unknown[]) =>
    app.inject({ method: "POST", url: "/api/sync/push", headers: { "x-api-key": SYNC_KEY }, payload: { captures } });
  const row = async () =>
    (await db.query(`SELECT taken_at, tags, quality_rating FROM captures_all WHERE id = $1`, [CAPTURE])).rows[0];

  it("refuses a push with a field missing or a malformed id, and changes nothing", async () => {
    const before = await row();
    const { takenAt: _t, ...noTakenAt } = pushed;
    expect((await push([noTakenAt])).statusCode).toBe(400);
    expect((await push([{ ...pushed, id: "not-a-uuid" }])).statusCode).toBe(400);
    expect((await push([{ ...pushed, lat: 95 }])).statusCode).toBe(400);
    expect((await push([{ ...pushed, tags: ["x".repeat(2001)] }])).statusCode).toBe(400);
    expect(await row()).toEqual(before);
  });

  it("accepts the shape the desktop sends", async () => {
    const res = await push([pushed]);
    expect(res.statusCode).toBe(200);
    expect(res.json().outcomes).toEqual([{ id: CAPTURE, status: "updated", updatedAt: expect.any(String) }]);
    expect((await row()).quality_rating).toBe(4);
    // The base comes back in Postgres' text form, which the next push sends as it is.
    const again = await push([{ ...pushed, qualityRating: 5, baseUpdatedAt: res.json().outcomes[0].updatedAt }]);
    expect(again.json()).toMatchObject({ outcomes: [{ status: "updated" }] });
    expect((await row()).quality_rating).toBe(5);

    const changes = await app.inject({ method: "GET", url: "/api/sync/changes", headers: { "x-api-key": SYNC_KEY } });
    expect(changes.json()).toMatchObject({
      items: [{ id: CAPTURE, lat: 51.5, qualityRating: 5, tags: ["kept"] }],
      purged: [],
      next: null,
    });
    // The page's end, sent back as the cursor, is a valid query.
    const { since, after } = changes.json().last;
    const rest = await app.inject({
      method: "GET",
      url: `/api/sync/changes?since=${encodeURIComponent(since)}&after=${after}`,
      headers: { "x-api-key": SYNC_KEY },
    });
    expect([rest.statusCode, rest.json().items]).toEqual([200, []]);
  });

  it("still serves a protocol 1 desktop, which sends and reads captures and marks only", async () => {
    const v1 = await app.inject({
      method: "POST",
      url: "/api/sync/push",
      headers: { "x-api-key": SYNC_KEY },
      payload: { captures: [], userSpecies: [], deleted: { captures: [], userSpecies: [] } },
    });
    expect(v1.statusCode).toBe(200);
    expect(v1.json()).toMatchObject({ outcomes: [], userSpecies: 0, deleted: 0 });
    for (const feed of ["/api/sync/changes", "/api/sync/user-species"]) {
      expect((await app.inject({ method: "GET", url: feed, headers: { "x-api-key": SYNC_KEY } })).statusCode).toBe(200);
    }
  });

  it("carries a species correction in the push and its own feed", async () => {
    const send = (payload: object) =>
      app.inject({ method: "POST", url: "/api/sync/push", headers: { "x-api-key": SYNC_KEY }, payload });
    const feed = async () =>
      (await app.inject({ method: "GET", url: "/api/sync/species-split-kept", headers: { "x-api-key": SYNC_KEY } })).json();
    expect((await send({ captures: [], speciesSplitKept: [CAPTURE] })).json().library.members).toEqual({
      applied: 1,
      skipped: 0,
    });
    expect((await feed()).items).toEqual([{ captureId: CAPTURE, updatedAt: expect.any(String) }]);
    await send({ captures: [], deleted: { speciesSplitKept: [CAPTURE] } });
    expect(await feed()).toMatchObject({ items: [], purged: [{ ref: CAPTURE }] });
  });

  it("lets a desktop sync key revoke itself, and nothing else", async () => {
    const other = await app.inject({
      method: "POST",
      url: "/api/sync/link/revoke",
      headers: { "x-api-key": OTHER_KEY },
    });
    expect(other.statusCode).toBe(401);
    const res = await app.inject({ method: "POST", url: "/api/sync/link/revoke", headers: { "x-api-key": SYNC_KEY } });
    expect([res.statusCode, res.json()]).toEqual([200, { ok: true }]);
    expect(await keys()).toEqual(["script"]);
    // Gone now, so a second try isn't let in.
    const again = await app.inject({
      method: "POST",
      url: "/api/sync/link/revoke",
      headers: { "x-api-key": SYNC_KEY },
    });
    expect(again.statusCode).toBe(401);
  });
});
