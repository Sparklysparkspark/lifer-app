// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55493/lifer npx vitest run checklistAdditions
// Adding a species to a region's or a sea zone's checklist by hand: add, repeat, remove, sign-in
// and key scopes, bad input, how the checklist shows it (with and without the region's pack, and
// with sea zones ticked), and that a catalog update or a pack install keeps it while a removal
// never takes a catalog row with it.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import * as tar from "tar";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SINGLE_USER_MODE = "0";
  // vi.hoisted runs before the imports above are initialized, so it has to require.
  /* eslint-disable @typescript-eslint/no-require-imports */
  process.env.APP_DATA_DIR = require("node:fs").mkdtempSync(
    require("node:path").join(require("node:os").tmpdir(), "lifer-additions-data-"),
  );
  /* eslint-enable @typescript-eslint/no-require-imports */
});

const url = process.env.TEST_DATABASE_URL;
const USER = "abcdabcd-0000-4000-8000-000000000a01";
const OTHER_USER = "abcdabcd-0000-4000-8000-000000000a02";
const TOKEN = "lifer_test_checklist_additions_a01";
const OTHER_TOKEN = "lifer_test_checklist_additions_a02";
const WRITE_KEY = "lifer_test_key_collection_write_a01";
const READ_KEY = "lifer_test_key_collection_read_a01";
// On the country's and the province's catalog checklists.
const LISTED = "abcdabcd-0000-4000-8000-000000000b01";
// A catalog bird on neither checklist.
const MISSING = "abcdabcd-0000-4000-8000-000000000b02";
// Hand-imported (Other Taxa, synthetic negative GBIF key) by USER for the country, which makes it
// USER's own addition there (migration 125, species/otherTaxa.ts).
const HAND = "abcdabcd-0000-4000-8000-000000000b03";
// A catalog bird only the seed in the catalog update test lists.
const SEEDED = "abcdabcd-0000-4000-8000-000000000b04";
const ALL_SPECIES = [LISTED, MISSING, HAND, SEEDED];
const UNKNOWN = "abcdabcd-0000-4000-8000-000000000fff";
const HUB = "Zzadd Continent";
const COUNTRY = "Zzaddland";
const PROVINCE = "Zzadd North";
// A country whose pack isn't downloaded (no occurrence_computed_at).
const PACKLESS = "Zzadd Packless";
// The country's nearby water; the bight's catalog checklist lists LISTED.
const SEA = "Zzadd Sea";
const BIGHT = "Zzadd Bight";

describe.skipIf(!url)("checklist additions", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;
  let hubId: string;
  let countryId: string;
  let provinceId: string;
  let packlessId: string;
  let seaId: string;
  let bightId: string;

  type Auth = "user" | "other" | "none" | { key: string };
  const call = (method: "GET" | "PUT" | "DELETE", route: string, auth: Auth = "user") =>
    app.inject({
      method,
      url: route,
      cookies: auth === "user" ? { [cookieName]: TOKEN } : auth === "other" ? { [cookieName]: OTHER_TOKEN } : {},
      headers: typeof auth === "object" ? { "x-api-key": auth.key } : {},
    });
  const addition = (regionId: string, speciesId: string) => `/api/regions/${regionId}/checklist-additions/${speciesId}`;
  const seaAddition = (seaZoneId: string, speciesId: string) =>
    `/api/sea-zones/${seaZoneId}/checklist-additions/${speciesId}`;
  type Marker = { id: string; name: string; kind: "region" | "seaZone" };
  const regionMarker = (id: string, name: string): Marker => ({ id, name, kind: "region" });

  async function checklist(regionId: string, auth: Auth = "user", query = "") {
    const res = await call("GET", `/api/regions/${regionId}/species${query}`, auth);
    expect(res.statusCode).toBe(200);
    return (res.json().items as Array<{ speciesId: string; userAddedRegion?: Marker | null }>).map((i) => ({
      speciesId: i.speciesId,
      userAddedRegion: i.userAddedRegion ?? null,
    }));
  }
  const ids = async (regionId: string, query = "", auth: Auth = "user") =>
    (await checklist(regionId, auth, query)).map((i) => i.speciesId);
  const catalogRows = async () =>
    (
      await db.query<{ region_id: string; species_id: string }>(
        `SELECT region_id, species_id FROM region_species WHERE species_id = ANY($1) ORDER BY region_id, species_id`,
        [ALL_SPECIES],
      )
    ).rows;
  const additionRows = async () =>
    (
      await db.query<{ user_id: string; region_id: string; species_id: string }>(
        `SELECT user_id, region_id, species_id FROM region_species_user_added WHERE species_id = ANY($1)
         ORDER BY user_id, region_id, species_id`,
        [ALL_SPECIES],
      )
    ).rows;

  async function cleanup() {
    await db.query(`DELETE FROM captures_all WHERE user_id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`DELETE FROM user_species WHERE user_id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`DELETE FROM users WHERE id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`DELETE FROM regions WHERE name = ANY($1)`, [[PROVINCE, COUNTRY, PACKLESS, HUB]]);
    await db.query(`DELETE FROM sea_zones WHERE name = ANY($1)`, [[SEA, BIGHT]]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [ALL_SPECIES]);
    await db.query(`DELETE FROM downloaded_packs WHERE region = $1`, [COUNTRY]);
  }

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    const { hashApiKey } = await import("../auth/apiKeys.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { regionRoutes } = await import("./routes.js");

    await cleanup();
    await db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'additions@test', 'x'), ($2, 'additions-other@test', 'x')`,
      [USER, OTHER_USER],
    );
    await db.query(
      `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day'), ($3, $4, now() + interval '1 day')`,
      [hashToken(TOKEN), USER, hashToken(OTHER_TOKEN), OTHER_USER],
    );
    await db.query(
      `INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES
         ($1, 'writer', $2, '{collection.write}'), ($1, 'reader', $3, '{collection.read}')`,
      [USER, hashApiKey(WRITE_KEY), hashApiKey(READ_KEY)],
    );
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class, is_other_taxa) VALUES
         ($1, 930001, 'Zzaddus listed', 'Listed Bird', 'aves', false),
         ($2, 930002, 'Zzaddus missing', 'Missing Bird', 'aves', false),
         ($3, -930003, 'Zzaddus manualis', 'Hand Beetle', 'insecta', true),
         ($4, 930004, 'Zzaddus seeded', 'Seeded Bird', 'aves', false)`,
      ALL_SPECIES,
    );
    // Well recorded, so "Hide obscure species" (on by default) leaves LISTED alone. MISSING is
    // obscure (almost no records): added by hand, it shows anyway.
    await db.query(
      `INSERT INTO species_traits (species_id, occurrence_count, last_occurrence_year, source_attribution)
       VALUES ($1, 5000, 2025, 'test'), ($2, 5, 2025, 'test')`,
      [LISTED, MISSING],
    );
    const zone = async (name: string) =>
      (
        await db.query<{ id: string }>(
          `INSERT INTO sea_zones (name, wkt, bbox_min_lon, bbox_min_lat, bbox_max_lon, bbox_max_lat)
           VALUES ($1, 'POLYGON((0 0,1 0,1 1,0 1,0 0))', 0, 0, 1, 1) RETURNING id`,
          [name],
        )
      ).rows[0].id;
    seaId = await zone(SEA);
    bightId = await zone(BIGHT);
    await db.query(`INSERT INTO sea_zone_species (sea_zone_id, species_id, record_count) VALUES ($1, $2, 10)`, [
      bightId,
      LISTED,
    ]);
    hubId = (await db.query<{ id: string }>(`INSERT INTO regions (name) VALUES ($1) RETURNING id`, [HUB])).rows[0].id;
    countryId = (
      await db.query<{ id: string }>(
        `INSERT INTO regions (name, parent_id, external_codes, occurrence_computed_at, has_children, nearby_sea_zone_ids)
         VALUES ($1, $2, '{ZZA}', now(), true, $3) RETURNING id`,
        [COUNTRY, hubId, [seaId, bightId]],
      )
    ).rows[0].id;
    // The catalog seed ships its checklist rows, but they wait for the pack.
    packlessId = (
      await db.query<{ id: string }>(
        `INSERT INTO regions (name, parent_id, external_codes) VALUES ($1, $2, '{ZZB}') RETURNING id`,
        [PACKLESS, hubId],
      )
    ).rows[0].id;
    provinceId = (
      await db.query<{ id: string }>(
        `INSERT INTO regions (name, parent_id, external_codes, occurrence_computed_at)
         VALUES ($1, $2, '{ZZA-N}', now()) RETURNING id`,
        [PROVINCE, countryId],
      )
    ).rows[0].id;
    // The country's bird pack is installed, so its catalog birds show.
    await db.query(`INSERT INTO downloaded_packs (pack_id, region, taxon) VALUES ('zzadd-aves', $1, 'aves')`, [
      COUNTRY,
    ]);

    app = Fastify();
    await app.register(cookie);
    await app.register(regionRoutes, { prefix: "/api" });
    await app.ready();
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM region_species_user_added WHERE user_id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`DELETE FROM sea_zone_species_user_added WHERE user_id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`DELETE FROM region_species_hidden WHERE user_id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`DELETE FROM captures_all WHERE user_id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`DELETE FROM user_species WHERE user_id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`DELETE FROM region_species WHERE species_id = ANY($1)`, [ALL_SPECIES]);
    await db.query(`INSERT INTO region_species (region_id, species_id) VALUES ($1, $3), ($2, $3), ($4, $3)`, [
      countryId,
      provinceId,
      LISTED,
      packlessId,
    ]);
    await db.query(`INSERT INTO region_species_user_added (user_id, region_id, species_id) VALUES ($1, $2, $3)`, [
      USER,
      countryId,
      HAND,
    ]);
  });

  const handImport = () => ({ user_id: USER, region_id: countryId, species_id: HAND });
  // additionRows' ORDER BY: a uuid sorts like its lowercase text.
  const inQueryOrder = (rows: Array<{ user_id: string; region_id: string; species_id: string }>) =>
    [...rows].sort((a, b) =>
      `${a.user_id}${a.region_id}${a.species_id}` < `${b.user_id}${b.region_id}${b.species_id}` ? -1 : 1,
    );

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("adds a hand-imported species to another region, once, and shows it marked on that checklist", async () => {
    const first = await call("PUT", addition(provinceId, HAND));
    expect([first.statusCode, first.json()]).toEqual([200, { ok: true, added: true, alreadyOnChecklist: false }]);
    const again = await call("PUT", addition(provinceId, HAND));
    expect([again.statusCode, again.json()]).toEqual([200, { ok: true, added: false, alreadyOnChecklist: false }]);
    expect(await additionRows()).toEqual(
      inQueryOrder([
        { user_id: USER, region_id: countryId, species_id: HAND },
        { user_id: USER, region_id: provinceId, species_id: HAND },
      ]),
    );

    expect(await checklist(provinceId)).toContainEqual({
      speciesId: HAND,
      userAddedRegion: regionMarker(provinceId, PROVINCE),
    });
    // On the country, its own addition there wins over the province's.
    expect(await checklist(countryId)).toContainEqual({
      speciesId: HAND,
      userAddedRegion: regionMarker(countryId, COUNTRY),
    });
    expect(await checklist(provinceId)).toContainEqual({ speciesId: LISTED, userAddedRegion: null });

    const list = await call("GET", `/api/regions/${provinceId}/checklist-additions`);
    expect(list.json().items).toEqual([
      expect.objectContaining({ speciesId: HAND, commonName: "Hand Beetle", alreadyOnChecklist: false }),
    ]);
    const bySpecies = await call("GET", `/api/species/${HAND}/checklist-additions`);
    // The country it was imported for, and the province it was added to (sorted by name, which
    // depends on the database's collation, so not checked here).
    const { items, seaZones } = bySpecies.json();
    expect(items).toHaveLength(2);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ regionId: provinceId, regionName: PROVINCE, alreadyOnChecklist: false }),
        expect.objectContaining({ regionId: countryId, regionName: COUNTRY, alreadyOnChecklist: false }),
      ]),
    );
    expect(seaZones).toEqual([]);
  });

  it("adds a catalog species a checklist is missing, which also rolls up to the country", async () => {
    expect((await checklist(provinceId)).map((i) => i.speciesId)).not.toContain(MISSING);
    expect((await call("PUT", addition(provinceId, MISSING))).json()).toMatchObject({ added: true });

    const marker = regionMarker(provinceId, PROVINCE);
    expect(await checklist(provinceId)).toContainEqual({ speciesId: MISSING, userAddedRegion: marker });
    expect(await checklist(countryId)).toContainEqual({ speciesId: MISSING, userAddedRegion: marker });
    const count = await call("GET", `/api/regions/${provinceId}/species/count`);
    expect(count.json().total).toBe((await checklist(provinceId)).length);
    // Nothing was written to the catalog's own checklists.
    expect(await catalogRows()).not.toContainEqual(expect.objectContaining({ species_id: MISSING }));
  });

  it("keeps each user's additions to themselves", async () => {
    await call("PUT", addition(provinceId, MISSING));
    expect((await checklist(provinceId, "other")).map((i) => i.speciesId)).not.toContain(MISSING);
    const res = await call("DELETE", addition(provinceId, MISSING), "other");
    expect([res.statusCode, res.json().code]).toEqual([404, "not_added"]);
    expect(await additionRows()).toContainEqual({ user_id: USER, region_id: provinceId, species_id: MISSING });
    // The hand import is USER's too: another user doesn't see it.
    expect((await checklist(countryId, "other")).map((i) => i.speciesId)).not.toContain(HAND);
  });

  it("removes an addition, and never the catalog's row for the same species", async () => {
    // Already on the catalog checklist: recorded, and reported as such.
    const res = await call("PUT", addition(provinceId, LISTED));
    expect(res.json()).toEqual({ ok: true, added: true, alreadyOnChecklist: true });
    await call("PUT", addition(provinceId, MISSING));
    const before = await catalogRows();

    for (const species of [LISTED, MISSING]) {
      const removed = await call("DELETE", addition(provinceId, species));
      expect([removed.statusCode, removed.json()]).toEqual([200, { ok: true }]);
    }
    expect(await additionRows()).toEqual([handImport()]);
    expect(await catalogRows()).toEqual(before);
    const ids = (await checklist(provinceId)).map((i) => i.speciesId);
    expect(ids).toContain(LISTED);
    expect(ids).not.toContain(MISSING);

    // Removing again, or something never added, changes nothing.
    const twice = await call("DELETE", addition(provinceId, MISSING));
    expect([twice.statusCode, twice.json()]).toEqual([
      404,
      { error: "You haven't added that species to this region's checklist", code: "not_added" },
    ]);
    const catalogOnly = await call("DELETE", addition(countryId, LISTED));
    expect(catalogOnly.statusCode).toBe(404);
    expect(await catalogRows()).toEqual(before);
  });

  it("brings back a species you'd hidden in that region", async () => {
    await db.query(`INSERT INTO region_species_hidden (user_id, region_id, species_id) VALUES ($1, $2, $3)`, [
      USER,
      provinceId,
      LISTED,
    ]);
    expect((await checklist(provinceId)).map((i) => i.speciesId)).not.toContain(LISTED);
    await call("PUT", addition(provinceId, LISTED));
    expect((await checklist(provinceId)).map((i) => i.speciesId)).toContain(LISTED);
  });

  it("refuses bad input", async () => {
    const malformed = await call("PUT", `/api/regions/nope/checklist-additions/${HAND}`);
    expect([malformed.statusCode, malformed.json()]).toEqual([
      400,
      { error: "Invalid path: regionId must be an id (a UUID)", code: "invalid_request" },
    ]);
    expect((await call("DELETE", `/api/regions/${provinceId}/checklist-additions/nope`)).statusCode).toBe(400);
    expect((await call("GET", `/api/species/nope/checklist-additions`)).statusCode).toBe(400);

    const unknownRegion = await call("PUT", addition(UNKNOWN, HAND));
    expect([unknownRegion.statusCode, unknownRegion.json()]).toEqual([404, { error: "Region not found" }]);
    const unknownSpecies = await call("PUT", addition(provinceId, UNKNOWN));
    expect([unknownSpecies.statusCode, unknownSpecies.json()]).toEqual([404, { error: "Species not found" }]);
    expect((await call("GET", `/api/regions/${UNKNOWN}/checklist-additions`)).statusCode).toBe(404);
    expect((await call("GET", `/api/species/${UNKNOWN}/checklist-additions`)).statusCode).toBe(404);

    const hub = await call("PUT", addition(hubId, HAND));
    expect([hub.statusCode, hub.json().code]).toEqual([400, "no_checklist"]);
    expect(await additionRows()).toEqual([handImport()]);
  });

  it("needs a sign-in or a key with the right scope", async () => {
    for (const [method, route] of [
      ["PUT", addition(provinceId, HAND)],
      ["DELETE", addition(provinceId, HAND)],
      ["GET", `/api/regions/${provinceId}/checklist-additions`],
      ["GET", `/api/species/${HAND}/checklist-additions`],
      ["GET", `/api/sea-zones`],
      ["PUT", seaAddition(seaId, HAND)],
      ["DELETE", seaAddition(seaId, HAND)],
      ["GET", `/api/sea-zones/${seaId}/checklist-additions`],
    ] as const) {
      const res = await call(method, route, "none");
      expect([method, route, res.statusCode]).toEqual([method, route, 401]);
    }
    // A read-only key can list but not change; a write key can change.
    expect((await call("PUT", addition(provinceId, HAND), { key: READ_KEY })).statusCode).toBe(401);
    expect((await call("GET", `/api/species/${HAND}/checklist-additions`, { key: READ_KEY })).statusCode).toBe(200);
    expect((await call("PUT", addition(provinceId, HAND), { key: WRITE_KEY })).json()).toMatchObject({ added: true });
    expect((await call("GET", `/api/species/${HAND}/checklist-additions`, { key: WRITE_KEY })).statusCode).toBe(401);
    expect((await call("DELETE", addition(provinceId, HAND), { key: WRITE_KEY })).statusCode).toBe(200);
    expect((await call("PUT", addition(provinceId, HAND), { key: "lifer_not_a_key" })).statusCode).toBe(401);
    expect((await call("PUT", seaAddition(seaId, HAND), { key: READ_KEY })).statusCode).toBe(401);
    expect((await call("GET", `/api/sea-zones`, { key: READ_KEY })).statusCode).toBe(200);
    expect((await call("PUT", seaAddition(seaId, HAND), { key: WRITE_KEY })).json()).toMatchObject({ added: true });
  });

  it("survives a catalog seed update that prunes the region's checklist", async () => {
    const { applyCatalogSeedFile } = await import("../species/catalogSeedUpdate.js");
    await call("PUT", addition(provinceId, MISSING));
    await call("PUT", addition(provinceId, LISTED));
    // The seed's province checklist no longer lists LISTED: its catalog row goes, the additions stay.
    const dump = [
      "COPY public.region_species (region_id, species_id, is_vagrant, is_invasive) FROM stdin;",
      `${provinceId}\t${SEEDED}\tf\tf`,
      "\\.",
      "",
    ].join("\n");
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "lifer-additions-seed-")), "seed.sql.gz");
    writeFileSync(file, gzipSync(dump));
    const merged = await applyCatalogSeedFile(db, file, null, { update: () => {}, throwIfCancelled: () => {} });
    expect(merged.region_speciesRemoved).toBe(1);

    expect(await additionRows()).toEqual(
      inQueryOrder([
        handImport(),
        { user_id: USER, region_id: provinceId, species_id: LISTED },
        { user_id: USER, region_id: provinceId, species_id: MISSING },
      ]),
    );
    const marker = regionMarker(provinceId, PROVINCE);
    const items = await checklist(provinceId);
    expect(items).toContainEqual({ speciesId: MISSING, userAddedRegion: marker });
    // No longer in the catalog here, so it now shows as your addition.
    expect(items).toContainEqual({ speciesId: LISTED, userAddedRegion: marker });
  });

  it("survives a pack install that replaces the region's checklist for its taxon", async () => {
    const { applyPack } = await import("../offlinePacks/apply.js");
    await call("PUT", addition(countryId, MISSING));
    await call("PUT", addition(countryId, HAND));

    const dir = mkdtempSync(path.join(os.tmpdir(), "lifer-additions-pack-"));
    const manifest = {
      type: "region",
      region: COUNTRY,
      taxon: "aves",
      // A bird pack listing no birds at all: every catalog bird on the country's list goes.
      species: [],
    };
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "lifer-additions-pack-out-")), "test.pack.tar.gz");
    await tar.create({ gzip: true, file, cwd: dir }, ["manifest.json"]);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await applyPack(client, file);
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    expect(await catalogRows()).not.toContainEqual({ region_id: countryId, species_id: LISTED });
    expect(await additionRows()).toEqual(
      inQueryOrder([
        { user_id: USER, region_id: countryId, species_id: HAND },
        { user_id: USER, region_id: countryId, species_id: MISSING },
      ]),
    );
    const ids = (await checklist(countryId)).map((i) => i.speciesId);
    expect(ids).toContain(MISSING);
    expect(ids).not.toContain(LISTED);
  });

  describe("a region without its pack", () => {
    it("lists only what's yours there, with the catalog's checklist left for the pack", async () => {
      const empty = await call("GET", `/api/regions/${packlessId}/species`);
      expect(empty.json()).toMatchObject({
        needsPack: true,
        region: { id: packlessId, name: PACKLESS, canDrillDown: true },
        stats: { total: 0, collected: 0, seen: 0 },
        items: [],
      });

      // Added by hand, and photographed there: both show without the pack, and only those.
      await call("PUT", addition(packlessId, MISSING));
      await db.query(`INSERT INTO captures_all (user_id, species_id, fingerprint, region_id) VALUES ($1, $2, $3, $4)`, [
        USER,
        LISTED,
        "zzadd-packless-capture",
        packlessId,
      ]);
      const res = await call("GET", `/api/regions/${packlessId}/species`);
      expect(res.json().needsPack).toBe(true);
      expect(res.json().taxonPackMissing).toBe(false);
      const items = await checklist(packlessId);
      expect(items).toEqual(
        expect.arrayContaining([
          { speciesId: MISSING, userAddedRegion: regionMarker(packlessId, PACKLESS) },
          { speciesId: LISTED, userAddedRegion: null },
        ]),
      );
      expect(items).toHaveLength(2);
      const count = await call("GET", `/api/regions/${packlessId}/species/count`);
      expect(count.json().total).toBe(2);

      // The catalog lists LISTED there too, but that list isn't shown yet, so an addition of it is
      // marked: removing it is what would take it off.
      expect((await call("PUT", addition(packlessId, LISTED))).json()).toMatchObject({ alreadyOnChecklist: true });
      expect(await checklist(packlessId)).toContainEqual({
        speciesId: LISTED,
        userAddedRegion: regionMarker(packlessId, PACKLESS),
      });
      // Someone else's additions and photos aren't theirs to see.
      expect(await checklist(packlessId, "other")).toEqual([]);
    });
  });

  describe("sea zones", () => {
    const zoneQuery = (zones: string[], includeLand = true) =>
      `?seaZoneIds=${zones.join(",")}${includeLand ? "" : "&includeLand=0"}`;

    it("lists every sea zone to pick from", async () => {
      const res = await call("GET", "/api/sea-zones");
      expect(res.statusCode).toBe(200);
      const zones = res.json().zones as Array<{ id: string; name: string }>;
      expect(zones).toEqual(
        expect.arrayContaining([
          { id: seaId, name: SEA },
          { id: bightId, name: BIGHT },
        ]),
      );
    });

    it("adds a species to a sea zone, shown on a region's checklist only with that zone ticked", async () => {
      const first = await call("PUT", seaAddition(seaId, MISSING));
      expect([first.statusCode, first.json()]).toEqual([200, { ok: true, added: true, alreadyOnChecklist: false }]);
      const again = await call("PUT", seaAddition(seaId, MISSING));
      expect(again.json()).toEqual({ ok: true, added: false, alreadyOnChecklist: false });

      // Like the zone's own catalog species: not on the land list until the zone is ticked.
      expect(await ids(countryId)).not.toContain(MISSING);
      const seaMarker: Marker = { id: seaId, name: SEA, kind: "seaZone" };
      expect(await checklist(countryId, "user", zoneQuery([seaId]))).toContainEqual({
        speciesId: MISSING,
        userAddedRegion: seaMarker,
      });
      // Only the zone: land additions and the land checklist drop out, the zone's addition stays.
      const seaOnly = await ids(countryId, zoneQuery([seaId], false));
      expect(seaOnly).toContain(MISSING);
      expect(seaOnly).not.toContain(HAND);
      expect(seaOnly).not.toContain(LISTED);
      // On the land checklist too, but that isn't in a sea-only view, so the addition is marked there.
      await call("PUT", seaAddition(seaId, LISTED));
      expect(await checklist(countryId, "user", zoneQuery([seaId], false))).toContainEqual({
        speciesId: LISTED,
        userAddedRegion: seaMarker,
      });
      expect(await checklist(countryId, "user", zoneQuery([seaId]))).toContainEqual({
        speciesId: LISTED,
        userAddedRegion: null,
      });
      const count = await call("GET", `/api/regions/${countryId}/species/count${zoneQuery([seaId])}`);
      expect(count.json().total).toBe((await ids(countryId, zoneQuery([seaId]))).length);
      // The region offers the zone with your count, so the page shows it even without a fish pack.
      const zones = (await call("GET", `/api/regions/${countryId}/sea-zones`)).json().zones;
      expect(zones).toEqual([
        { id: bightId, name: BIGHT, addedByYou: 0 },
        { id: seaId, name: SEA, addedByYou: 2 },
      ]);
      // Sea zone additions stay with their zone: World and continent views don't take in water.
      const hub = (await call("GET", `/api/regions/${hubId}/aggregate-species`)).json();
      expect(hub.items.map((i: { speciesId: string }) => i.speciesId)).not.toContain(MISSING);
      // Each user's own.
      expect(await ids(countryId, zoneQuery([seaId]), "other")).not.toContain(MISSING);
    });

    it("marks nothing the zone's catalog already lists, and lists additions by species and by zone", async () => {
      const listed = await call("PUT", seaAddition(bightId, LISTED));
      expect(listed.json()).toEqual({ ok: true, added: true, alreadyOnChecklist: true });
      expect(await checklist(countryId, "user", zoneQuery([bightId], false))).toContainEqual({
        speciesId: LISTED,
        userAddedRegion: null,
      });
      await call("PUT", seaAddition(seaId, LISTED));

      const bySpecies = (await call("GET", `/api/species/${LISTED}/checklist-additions`)).json();
      expect(bySpecies.items).toEqual([]);
      expect(bySpecies.seaZones).toEqual([
        expect.objectContaining({
          seaZoneId: bightId,
          seaZoneName: BIGHT,
          alreadyOnChecklist: true,
          nearRegionId: countryId,
        }),
        expect.objectContaining({
          seaZoneId: seaId,
          seaZoneName: SEA,
          alreadyOnChecklist: false,
          nearRegionId: countryId,
        }),
      ]);
      const byZone = (await call("GET", `/api/sea-zones/${seaId}/checklist-additions`)).json();
      expect(byZone.items).toEqual([expect.objectContaining({ speciesId: LISTED, alreadyOnChecklist: false })]);
    });

    it("removes only your addition", async () => {
      await call("PUT", seaAddition(bightId, LISTED));
      const removed = await call("DELETE", seaAddition(bightId, LISTED));
      expect([removed.statusCode, removed.json()]).toEqual([200, { ok: true }]);
      // The zone's catalog entry is untouched.
      expect(await ids(countryId, zoneQuery([bightId], false))).toContain(LISTED);
      const twice = await call("DELETE", seaAddition(bightId, LISTED));
      expect([twice.statusCode, twice.json()]).toEqual([
        404,
        { error: "You haven't added that species to this sea zone's checklist", code: "not_added" },
      ]);
    });

    it("refuses bad input", async () => {
      expect((await call("PUT", `/api/sea-zones/nope/checklist-additions/${HAND}`)).statusCode).toBe(400);
      const unknownZone = await call("PUT", seaAddition(UNKNOWN, HAND));
      expect([unknownZone.statusCode, unknownZone.json()]).toEqual([404, { error: "Sea zone not found" }]);
      const unknownSpecies = await call("PUT", seaAddition(seaId, UNKNOWN));
      expect([unknownSpecies.statusCode, unknownSpecies.json()]).toEqual([404, { error: "Species not found" }]);
      expect((await call("GET", `/api/sea-zones/${UNKNOWN}/checklist-additions`)).statusCode).toBe(404);
    });
  });
});
