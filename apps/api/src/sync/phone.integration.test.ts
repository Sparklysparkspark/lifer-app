// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// What a paired phone gets from the sync routes: the change feeds, settings, a checklist and
// version-checked marks, by device key, with the routes it must not reach refused.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SINGLE_USER_MODE = "0";
});

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000961";
const OTHER_USER = "eeeeeeee-0000-4000-8000-000000000962";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000096a";
const SPECIES_2 = "eeeeeeee-0000-4000-8000-00000000096b";
const REGION = "eeeeeeee-0000-4000-8000-00000000096c";
const CAPTURE = "eeeeeeee-0000-4000-8000-000000000963";
const VOCAB_CAPTURE = "eeeeeeee-0000-4000-8000-00000000096e";
const ALBUM = "eeeeeeee-0000-4000-8000-000000000964";
const DEVICE = "lifer_test_device_961";
const NARROW = "lifer_test_photos_only_961";
const OTHER_DEVICE = "lifer_test_device_962";
const PACK = "zz-test-961";

describe.skipIf(!url)("phone sync routes", () => {
  let app: FastifyInstance;
  let gated: FastifyInstance;
  let db: pg.Pool;
  async function cleanup() {
    await db.query(`DELETE FROM downloaded_packs WHERE pack_id = $1`, [PACK]);
    await db.query(`DELETE FROM sync_tombstones WHERE user_id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`DELETE FROM users WHERE id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`DELETE FROM install_settings WHERE key LIKE ANY($1)`, [
      [`sensitive_species:${USER}`, `species_name_display:${USER}`],
    ]);
    await db.query(`DELETE FROM regions WHERE id = $1`, [REGION]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SPECIES, SPECIES_2]]);
  }

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    const { hashApiKey } = await import("../auth/apiKeys.js");
    const { syncRoutes } = await import("./routes.js");
    const { phoneSyncRoutes } = await import("./phone.js");
    const { desktopRequestGate } = await import("../auth/desktopGate.js");
    const { installSchemas } = await import("../lib/schema.js");
    await cleanup();
    await db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'phone961@test', 'x'), ($2, 'phone962@test', 'x')`,
      [USER, OTHER_USER],
    );
    const scopes = "{companion}";
    await db.query(
      `INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES
         ($1, 'Test phone (ios)', $2, '${scopes}'), ($1, 'narrow', $3, '{photos.read}'), ($4, 'Other phone (ios)', $5, '${scopes}')`,
      [USER, hashApiKey(DEVICE), hashApiKey(NARROW), OTHER_USER, hashApiKey(OTHER_DEVICE)],
    );
    await db.query(
      `INSERT INTO species (id, scientific_name, common_name, taxon_class, gbif_key, ebird_code) VALUES
         ($1, 'Zzphone alpha', 'Alpha Bird', 'aves', 980961, 'alpbir'), ($2, 'Zzphone beta', 'Beta Bird', 'aves', 980962, NULL)`,
      [SPECIES, SPECIES_2],
    );
    await db.query(`INSERT INTO species_rarity (species_id, tier, computed_at) VALUES ($1, 'rare', now())`, [SPECIES]);
    await db.query(`INSERT INTO regions (id, name, external_codes) VALUES ($1, 'Zzphoneland', '{ZP}')`, [REGION]);
    await db.query(
      `INSERT INTO region_species (region_id, species_id, is_vagrant, is_invasive) VALUES ($1, $2, false, false), ($1, $3, true, false)`,
      [REGION, SPECIES, SPECIES_2],
    );
    await db.query(
      `INSERT INTO downloaded_packs (pack_id, region, species_count, bytes) VALUES ($1, 'Zzphoneland', 2, 1)`,
      [PACK],
    );
    await db.query(
      `INSERT INTO captures_all (id, user_id, species_id, fingerprint, taken_at, tags, quality_rating) VALUES ($1, $2, $3, 'phone-1', '2026-05-01T08:00:00Z', '{kept}', 3)`,
      [CAPTURE, USER, SPECIES],
    );
    await db.query(`INSERT INTO albums (id, user_id, name) VALUES ($1, $2, 'Phone album')`, [ALBUM, USER]);
    await db.query(`INSERT INTO album_captures (album_id, capture_id) VALUES ($1, $2)`, [ALBUM, CAPTURE]);
    await db.query(
      `INSERT INTO trips (user_id, name, source_folder, destination_folder) VALUES ($1, 'Phone trip', '/tmp/x', '/tmp/y')`,
      [USER],
    );

    const build = async (gate: boolean) => {
      const a = Fastify();
      installSchemas(a);
      await a.register(cookie);
      if (gate)
        a.addHook(
          "onRequest",
          desktopRequestGate(4312, () => ({ token: "t", allowUntokened: false })),
        );
      await a.register(syncRoutes, { prefix: "/api" });
      await a.register(phoneSyncRoutes, { prefix: "/api" });
      await a.ready();
      return a;
    };
    app = await build(false);
    gated = await build(true);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await gated?.close();
    if (db) {
      await cleanup();
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  const as = (k: string, extra: Record<string, string> = {}) => ({ "x-api-key": k, ...extra });
  const get = (u: string, k = DEVICE, a = app, extra = {}) =>
    a.inject({ method: "GET", url: `/api${u}`, headers: as(k, extra) });
  const post = (u: string, payload: unknown, k = DEVICE, a = app, extra = {}) =>
    a.inject({ method: "POST", url: `/api${u}`, headers: as(k, extra), payload: payload as object });

  const FEEDS = [
    "/sync/changes",
    "/sync/albums",
    "/sync/trips",
    "/sync/saved-spots",
    "/sync/album-captures",
    "/sync/album-exclusions",
    "/sync/user-species",
    "/sync/preferences",
    "/sync/search-vocab",
    "/sync/region-tree",
    `/sync/regions/${REGION}/checklist`,
  ];

  it("drops a saved spot from the phone once it turns private", async () => {
    const spot = (
      await db.query(
        `INSERT INTO saved_spots (user_id, name, lat, lon, updated_at) VALUES ($1, 'Pond', 1.234, 5.678, now() - interval '1 minute') RETURNING id`,
        [USER],
      )
    ).rows[0].id as string;
    const first = (await get("/sync/saved-spots")).json();
    expect(first.items.map((s: { id: string }) => s.id)).toContain(spot);
    await db.query(`UPDATE saved_spots SET geoprivacy = 'private', updated_at = now() WHERE id = $1`, [spot]);
    const { since, after } = first.last;
    const next = (await get(`/sync/saved-spots?since=${encodeURIComponent(since)}&after=${after}`)).json();
    expect(next.items).toEqual([]);
    expect(next.purged.map((p: { ref: string }) => p.ref)).toEqual([spot]);
  });

  it("serves every feed to a device key and refuses a key without the companion scope", async () => {
    for (const u of FEEDS) {
      expect((await get(u)).statusCode, u).toBe(200);
      expect((await get(u, NARROW)).statusCode, u).toBe(401);
      expect((await app.inject({ method: "GET", url: `/api${u}` })).statusCode, u).toBe(401);
    }
  });

  it("serialises albums and trips whatever shape their quad picks have", async () => {
    const P = (n: number) => `eeeeeeee-0000-4000-8000-0000000009f${n}`;
    const shapes: Array<[string, string[] | null]> = [
      ["null", null],
      ["empty", []],
      ["holes", [P(1), null as never, null as never, null as never]],
      ["all null", [null as never, null as never, null as never, null as never]],
      ["four", [P(1), P(2), P(3), P(4)]],
      ["eight", [P(1), P(2), P(3), P(4), P(5), P(6), P(7), P(8)]],
      ["duplicates", [P(1), P(1), P(2), P(2)]],
    ];
    for (const [name, ids] of shapes) {
      await db.query(
        `INSERT INTO albums (user_id, name, cover_layout, quad_photo_ids, quad_crops, cover_photo_id)
         VALUES ($1, $2, 'quad', $3::uuid[], '[null, {"x": 1, "y": 2, "size": 50}]'::jsonb, NULL)`,
        [USER, `shape ${name}`, ids],
      );
      await db.query(
        `INSERT INTO trips (user_id, name, source_folder, destination_folder, cover_layout, quad_photo_ids)
         VALUES ($1, $2, '/tmp/x', '/tmp/y', 'quad', $3::uuid[])`,
        [USER, `shape ${name}`, ids],
      );
    }
    await db.query(`INSERT INTO albums (user_id, name, rules) VALUES ($1, 'shape smart', '{"species": []}')`, [USER]);
    try {
      for (const feed of ["/sync/albums", "/sync/trips"]) {
        const res = await get(feed);
        expect(res.statusCode, `${feed} ${res.body.slice(0, 200)}`).toBe(200);
        const byName = new Map(res.json().items.map((i: { name: string }) => [i.name, i]));
        expect(byName.get("shape holes")).toMatchObject({ quadPhotoIds: [P(1), null, null, null] });
        expect(byName.get("shape empty")).toMatchObject({ quadPhotoIds: [] });
        expect(byName.get("shape null")).toMatchObject({ quadPhotoIds: null });
        expect(byName.get("shape eight")).toBeTruthy();
        expect(byName.get("shape duplicates")).toBeTruthy();
      }
    } finally {
      await db.query(`DELETE FROM albums WHERE user_id = $1 AND name LIKE 'shape %'`, [USER]);
      await db.query(`DELETE FROM trips WHERE user_id = $1 AND name LIKE 'shape %'`, [USER]);
    }
  });

  it("carries captures with tags, ratings and species, albums with covers, trips and membership", async () => {
    const changes = (await get("/sync/changes")).json();
    expect(changes.items).toMatchObject([
      { id: CAPTURE, scientificName: "Zzphone alpha", tags: ["kept"], qualityRating: 3 },
    ]);
    expect((await get("/sync/albums")).json().items).toMatchObject([
      { id: ALBUM, name: "Phone album", coverPhotoId: null },
    ]);
    expect((await get("/sync/trips")).json().items).toMatchObject([{ name: "Phone trip" }]);
    expect((await get("/sync/album-captures")).json().items).toMatchObject([{ albumId: ALBUM, captureId: CAPTURE }]);
  });

  it("reports an edit and a deletion after the cursor, and never another user's rows", async () => {
    const { since, after } = (await get("/sync/changes")).json().last;
    const q = `?since=${encodeURIComponent(since)}&after=${after}`;
    await db.query(`UPDATE captures_all SET tags = '{kept,edited}', quality_rating = 5 WHERE id = $1`, [CAPTURE]);
    const edited = (await get(`/sync/changes${q}`)).json();
    expect(edited.items).toMatchObject([{ id: CAPTURE, tags: ["kept", "edited"], qualityRating: 5 }]);
    await db.query(`DELETE FROM albums WHERE id = $1`, [ALBUM]);
    const albums = (await get("/sync/albums")).json();
    expect(albums.items).toEqual([]);
    // Another user's device sees none of this user's rows.
    expect((await get("/sync/changes", OTHER_DEVICE)).json().items).toEqual([]);
    expect((await get("/sync/trips", OTHER_DEVICE)).json().items).toEqual([]);
    await db.query(`DELETE FROM captures_all WHERE id = $1`, [CAPTURE]);
    const gone = (await get("/sync/changes")).json();
    expect(gone.purged).toMatchObject([{ id: CAPTURE }]);
  });

  it("writes marks against the version last seen: newest edit wins", async () => {
    const mark = {
      scientificName: "Zzphone beta",
      state: "seen",
      coverPhotoId: null,
      firstCollected: null,
      bestQuality: null,
      cardCropX: null,
      cardCropY: null,
      cardCropSize: null,
      isTarget: true,
    };
    // A new mark with no base applies.
    const first = await post("/sync/user-species", { items: [{ ...mark, baseUpdatedAt: null }] });
    expect(first.statusCode).toBe(200);
    const stamp = first.json().applied["Zzphone beta"];
    expect([stamp, first.json().conflicts]).toEqual([expect.any(String), []]);
    // The phone never saw the hub's mark: conflict, hub copy returned, nothing written.
    const unseen = await post("/sync/user-species", { items: [{ ...mark, isTarget: false, baseUpdatedAt: null }] });
    expect(unseen.json()).toMatchObject({
      applied: {},
      conflicts: [{ scientificName: "Zzphone beta", isTarget: true }],
    });
    // The current version applies and moves the version on.
    const ok = await post("/sync/user-species", { items: [{ ...mark, isTarget: false, baseUpdatedAt: stamp }] });
    const next = ok.json().applied["Zzphone beta"];
    expect(next).toEqual(expect.any(String));
    expect(next).not.toBe(stamp);
    // The stale version (a replay after a lost reply, or a second phone) conflicts.
    const stale = await post("/sync/user-species", { items: [{ ...mark, state: null, baseUpdatedAt: stamp }] });
    expect(stale.json()).toMatchObject({
      applied: {},
      conflicts: [{ scientificName: "Zzphone beta", isTarget: false, state: "seen" }],
    });
    const held = (await get("/sync/user-species")).json().items;
    expect(held).toMatchObject([{ scientificName: "Zzphone beta", isTarget: false, state: "seen" }]);
    // Another user's mark of the same species is untouched.
    expect((await get("/sync/user-species", OTHER_DEVICE)).json().items).toEqual([]);
    // Malformed: a state outside the two, a missing base.
    expect(
      (await post("/sync/user-species", { items: [{ ...mark, state: "owned", baseUpdatedAt: null }] })).statusCode,
    ).toBe(400);
    const { baseUpdatedAt: _b, ...noBase } = { ...mark, baseUpdatedAt: null };
    expect((await post("/sync/user-species", { items: [noBase] })).statusCode).toBe(400);
  });

  it("gives the naming preference, sensitive list, geoprivacy default and chosen regions", async () => {
    await db.query(`INSERT INTO install_settings (key, value) VALUES ($1, $2::jsonb), ($3, $4::jsonb)`, [
      `species_name_display:${USER}`,
      JSON.stringify({ main: "scientific", also: ["ebird"] }),
      `sensitive_species:${USER}`,
      JSON.stringify({ enabled: true, added: [SPECIES], removed: [SPECIES_2] }),
    ]);
    const prefs = (await get("/sync/preferences")).json();
    expect(prefs).toMatchObject({
      nameDisplay: { main: "scientific", also: ["ebird"] },
      sensitive: {
        enabled: true,
        added: ["Zzphone alpha"],
        removed: ["Zzphone beta"],
        iucnStatuses: ["VU", "EN", "CR"],
      },
      geoprivacy: { spotDefault: "open" },
    });
    expect(prefs.regions).toContainEqual({ regionId: REGION, name: "Zzphoneland", packIds: [PACK], speciesCount: 2 });
  });

  it("downloads a region's checklist, and 404s an unknown region", async () => {
    const list = (await get(`/sync/regions/${REGION}/checklist`)).json();
    expect(list).toMatchObject({ regionId: REGION, name: "Zzphoneland" });
    expect(list.items).toEqual([
      expect.objectContaining({
        scientificName: "Zzphone alpha",
        commonName: "Alpha Bird",
        ebirdCode: "alpbir",
        tier: "rare",
        localTier: null,
        worldTier: "rare",
        isVagrant: false,
      }),
      expect.objectContaining({ scientificName: "Zzphone beta", tier: null, isVagrant: true }),
    ]);
    expect((await get("/sync/regions/eeeeeeee-0000-4000-8000-0000000009ff/checklist")).statusCode).toBe(404);
  });

  it("sends each region's own tier beside the worldwide one, so a phone never shows one region's tier elsewhere", async () => {
    const OTHER = "eeeeeeee-0000-4000-8000-00000000096f";
    await db.query(`INSERT INTO regions (id, name) VALUES ($1, 'Zzphoneother')`, [OTHER]);
    await db.query(`UPDATE species_rarity SET tier_reason = 'computed' WHERE species_id = $1`, [SPECIES]);
    await db.query(
      `UPDATE region_species SET local_tier = 'legendary', tier_reason = 'few_records' WHERE region_id = $1 AND species_id = $2`,
      [REGION, SPECIES],
    );
    await db.query(
      `INSERT INTO region_species (region_id, species_id, local_tier, is_vagrant, is_invasive) VALUES ($1, $2, 'common', false, false)`,
      [OTHER, SPECIES],
    );
    const alpha = async (region: string) =>
      (await get(`/sync/regions/${region}/checklist`))
        .json()
        .items.find((i: { scientificName: string }) => i.scientificName === "Zzphone alpha");
    try {
      expect(await alpha(REGION)).toMatchObject({
        tier: "legendary",
        localTier: "legendary",
        worldTier: "rare",
        localTierReason: "few_records",
        tierReason: "computed",
      });
      expect(await alpha(OTHER)).toMatchObject({ tier: "common", localTier: "common", worldTier: "rare" });
      // The user's own tier wins on every scope, as on the desktop.
      await db.query(`INSERT INTO user_tier_overrides (user_id, species_id, tier) VALUES ($1, $2, 'uncommon')`, [
        USER,
        SPECIES,
      ]);
      expect(await alpha(REGION)).toMatchObject({ tier: "uncommon", localTier: "uncommon", worldTier: "uncommon" });
    } finally {
      await db.query(`DELETE FROM user_tier_overrides WHERE user_id = $1`, [USER]);
      await db.query(`UPDATE region_species SET local_tier = NULL, tier_reason = NULL WHERE region_id = $1`, [REGION]);
      await db.query(`UPDATE species_rarity SET tier_reason = NULL WHERE species_id = $1`, [SPECIES]);
      await db.query(`DELETE FROM regions WHERE id = $1`, [OTHER]);
    }
  });

  it("gives the region tree: regions with a species list, their ancestors, depth and own species count", async () => {
    const PARENT = "eeeeeeee-0000-4000-8000-00000000096e";
    await db.query(`INSERT INTO regions (id, name) VALUES ($1, 'Zzphoneworld')`, [PARENT]);
    await db.query(`UPDATE regions SET parent_id = $1 WHERE id = $2`, [PARENT, REGION]);
    try {
      const { regions } = (await get("/sync/region-tree")).json();
      expect(regions).toContainEqual({ id: REGION, name: "Zzphoneland", parentId: PARENT, depth: 1, speciesCount: 2 });
      expect(regions).toContainEqual({ id: PARENT, name: "Zzphoneworld", parentId: null, depth: 0, speciesCount: 0 });
    } finally {
      await db.query(`UPDATE regions SET parent_id = NULL WHERE id = $1`, [REGION]);
      await db.query(`DELETE FROM regions WHERE id = $1`, [PARENT]);
    }
  });

  it("gives the search vocabulary: region tree over the photos, and species order, family and aliases", async () => {
    const PARENT = "eeeeeeee-0000-4000-8000-00000000096d";
    await db.query(`INSERT INTO regions (id, name) VALUES ($1, 'Zzphonecontinent')`, [PARENT]);
    await db.query(`UPDATE regions SET parent_id = $1 WHERE id = $2`, [PARENT, REGION]);
    await db.query(
      `INSERT INTO captures_all (id, user_id, species_id, fingerprint, taken_at, region_id) VALUES ($1, $2, $3, 'phone-vocab', '2026-05-02T08:00:00Z', $4)`,
      [VOCAB_CAPTURE, USER, SPECIES, REGION],
    );
    await db.query(
      `UPDATE species SET taxon_order = 'Zzorder', family = 'Zzfamily', common_name_aliases = '{Alpha Alias}' WHERE id = $1`,
      [SPECIES],
    );
    await db.query(`INSERT INTO species_synonyms (species_id, synonym_name) VALUES ($1, 'Zzphone oldname')`, [SPECIES]);
    try {
      const v = (await get("/sync/search-vocab")).json();
      expect(v.regions).toEqual(
        expect.arrayContaining([
          { id: REGION, name: "Zzphoneland", parentId: PARENT },
          expect.objectContaining({ id: PARENT, name: "Zzphonecontinent" }),
        ]),
      );
      expect(v.species).toEqual([
        {
          scientificName: "Zzphone alpha",
          taxonOrder: "Zzorder",
          family: "Zzfamily",
          aliases: ["Alpha Alias", "Zzphone oldname"],
          codes: ["alpbir"],
        },
      ]);
      expect((await get("/sync/search-vocab", OTHER_DEVICE)).json().species).toEqual([]);
      expect((await get(`/sync/regions/${REGION}/checklist`)).json().items[0]).toMatchObject({
        taxonOrder: "Zzorder",
        family: "Zzfamily",
      });
    } finally {
      await db.query(`UPDATE regions SET parent_id = NULL WHERE id = $1`, [REGION]);
      await db.query(`DELETE FROM captures_all WHERE id = $1`, [VOCAB_CAPTURE]);
      await db.query(`DELETE FROM species_synonyms WHERE species_id = $1`, [SPECIES]);
      await db.query(`DELETE FROM regions WHERE id = $1`, [PARENT]);
    }
  });

  it("reaches the phone routes through the desktop gate, and not the desktop's own sync routes", async () => {
    const host = { host: "127.0.0.1:4312" };
    for (const u of FEEDS) expect((await get(u, DEVICE, gated, host)).statusCode, u).toBe(200);
    expect((await post("/sync/user-species", { items: [] }, DEVICE, gated, host)).statusCode).toBe(200);
    // Whole-capture pushes, link revocation and the desktop-only jobs stay out of a phone's reach.
    expect((await post("/sync/push", { captures: [] }, DEVICE, gated, host)).statusCode).toBe(401);
    expect((await post("/sync/link/revoke", {}, DEVICE, gated, host)).statusCode).toBe(401);
    expect((await get("/sync/status", DEVICE, gated, host)).statusCode).toBe(401);
    // And with the app server's own check, a device key has no sync scope for the push.
    expect((await post("/sync/push", { captures: [] })).statusCode).toBe(401);
  });
});
