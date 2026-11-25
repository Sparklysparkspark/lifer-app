// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// "Count photos from": a species counts as photographed on a region's checklist only with a live
// photo in the viewed region's country or province. The list itself never changes with it. Also
// each row's photographedWhere, for the Photos taken filter.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SINGLE_USER_MODE = "0";
});

const url = process.env.TEST_DATABASE_URL;
const USER = "abcdabcd-0000-4000-8000-000000000c01";
// Someone else, whose photos never count for USER.
const OTHER_USER = "abcdabcd-0000-4000-8000-000000000c02";
const TOKEN = "lifer_test_photographed_in_c01";
const sp = (n: number) => `abcdabcd-0000-4000-8000-000000000d0${n}`;
// Photographed in the group's province only.
const IN_GROUP_PROVINCE = sp(1);
// Photographed only in another country.
const ELSEWHERE = sp(2);
// Photographed in Alberta, but that photo is in the Trash.
const TRASHED = sp(3);
// Photographed in Alberta, but that photo is hidden.
const HIDDEN = sp(4);
// A second species on a photo taken on the island shown under the continent.
const SECONDARY = sp(5);
// Photographed in Alberta.
const IN_ALBERTA = sp(6);
// Photographed, but its only photo has no place (no GPS).
const NO_PLACE = sp(7);
const ALL_SPECIES = [IN_GROUP_PROVINCE, ELSEWHERE, TRASHED, HIDDEN, SECONDARY, IN_ALBERTA, NO_PLACE];
const NAMES = {
  hub: "Zzscope Continent",
  country: "Zzscopeland",
  group: "Zzscope West",
  groupProvince: "Zzscope Columbia",
  alberta: "Zzscope Alberta",
  island: "Zzscope Isle",
  other: "Zzscope Otherland",
};

describe.skipIf(!url)("photographedIn on a region's checklist", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;
  const id: Record<keyof typeof NAMES, string> = {} as never;

  const get = async (route: string) => app.inject({ method: "GET", url: route, cookies: { [cookieName]: TOKEN } });
  async function collected(regionId: string, query = "") {
    const res = await get(`/api/regions/${regionId}/species${query}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      stats: { collected: number; total: number };
      items: Array<{ speciesId: string; state: string }>;
    };
    const ids = body.items.filter((i) => i.state === "collected").map((i) => i.speciesId);
    // The header count and the list agree.
    expect(body.stats.collected).toBe(ids.length);
    const count = (await get(`/api/regions/${regionId}/species/count${query}`)).json();
    expect(count).toMatchObject({ total: body.stats.total, collected: ids.length });
    return ids.sort();
  }

  async function cleanup() {
    await db.query(`DELETE FROM captures_all WHERE user_id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`DELETE FROM user_species WHERE user_id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`DELETE FROM users WHERE id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`DELETE FROM regions WHERE name = ANY($1) AND parent_id IS NOT NULL`, [Object.values(NAMES)]);
    await db.query(`DELETE FROM regions WHERE name = $1`, [NAMES.hub]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [ALL_SPECIES]);
    await db.query(`DELETE FROM downloaded_packs WHERE region = $1`, [NAMES.country]);
  }

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { regionRoutes } = await import("./routes.js");

    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'photographed-in@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    const region = async (
      name: string,
      parentId: string | null,
      codes: string[],
      homeCountryId: string | null = null,
    ) =>
      (
        await db.query<{ id: string }>(
          `INSERT INTO regions (name, parent_id, external_codes, occurrence_computed_at, home_country_id)
           VALUES ($1, $2, $3, now(), $4) RETURNING id`,
          [name, parentId, codes, homeCountryId],
        )
      ).rows[0].id;
    id.hub = await region(NAMES.hub, null, []);
    id.country = await region(NAMES.country, id.hub, ["ZZS"]);
    id.group = await region(NAMES.group, id.country, ["ZZS-W"]);
    id.groupProvince = await region(NAMES.groupProvince, id.group, ["ZZS-BC"]);
    id.alberta = await region(NAMES.alberta, id.country, ["ZZS-AB"]);
    id.island = await region(NAMES.island, id.hub, ["ZZS-IS"], id.country);
    id.other = await region(NAMES.other, id.hub, ["ZZO"]);
    await db.query(`INSERT INTO downloaded_packs (pack_id, region, taxon) VALUES ('zzscope-aves', $1, 'aves')`, [
      NAMES.country,
    ]);

    for (const [i, speciesId] of ALL_SPECIES.entries()) {
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, $2, $3, $4, 'aves')`,
        [speciesId, 940001 + i, `Zzscopus s${i}`, `Scope Bird ${i}`],
      );
      await db.query(
        `INSERT INTO species_traits (species_id, occurrence_count, last_occurrence_year, source_attribution)
         VALUES ($1, 5000, 2025, 'test')`,
        [speciesId],
      );
      // On the checklists of Alberta, the country, the group and the group's province.
      await db.query(
        `INSERT INTO region_species (region_id, species_id) VALUES ($1, $5), ($2, $5), ($3, $5), ($4, $5)`,
        [id.alberta, id.country, id.group, id.groupProvince, speciesId],
      );
      // Stored as photographed (anywhere) for every one.
      await db.query(`INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'collected')`, [
        USER,
        speciesId,
      ]);
    }
    const capture = async (speciesId: string, regionId: string | null, extra = "", userId = USER) =>
      (
        await db.query<{ id: string }>(
          `INSERT INTO captures_all (user_id, species_id, fingerprint, region_id${extra ? `, ${extra}` : ""})
           VALUES ($1, $2, $3, $4${extra ? ", now()" : ""}) RETURNING id`,
          [userId, speciesId, `zzscope-${userId}-${speciesId}-${regionId}`, regionId],
        )
      ).rows[0].id;
    await capture(IN_GROUP_PROVINCE, id.groupProvince);
    await capture(ELSEWHERE, id.other);
    await capture(TRASHED, id.alberta, "deleted_at");
    await capture(HIDDEN, id.alberta, "hidden_at");
    await capture(IN_ALBERTA, id.alberta);
    const islandCapture = await capture(IN_ALBERTA, id.island);
    await db.query(`INSERT INTO capture_species (capture_id, species_id) VALUES ($1, $2)`, [islandCapture, SECONDARY]);
    await capture(NO_PLACE, null);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'photographed-in-2@test', 'x')`, [
      OTHER_USER,
    ]);
    await capture(ELSEWHERE, id.alberta, "", OTHER_USER);

    app = Fastify();
    await app.register(cookie);
    await app.register(regionRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.end();
  });

  it("names the viewed region's country, and the province when it is one", async () => {
    const region = async (regionId: string) => (await get(`/api/regions/${regionId}/species`)).json().region;
    expect(await region(id.alberta)).toMatchObject({ countryName: NAMES.country, provinceName: NAMES.alberta });
    expect(await region(id.country)).toMatchObject({ countryName: NAMES.country, provinceName: null });
    // A vernacular group isn't a level of its own.
    expect(await region(id.group)).toMatchObject({ countryName: NAMES.country, provinceName: null });
    // Shown under its continent, but its country's.
    expect(await region(id.island)).toMatchObject({ countryName: NAMES.country, provinceName: NAMES.island });
  });

  it("counts every stored photographed species anywhere by default", async () => {
    expect(await collected(id.alberta)).toEqual([...ALL_SPECIES].sort());
  });

  it("counts only live photos in the country, groups and continent-shown provinces included", async () => {
    const inCountry = [IN_GROUP_PROVINCE, SECONDARY, IN_ALBERTA].sort();
    expect(await collected(id.alberta, "?photographedIn=country")).toEqual(inCountry);
    // A province-level choice on a country page uses the country.
    expect(await collected(id.country, "?photographedIn=province")).toEqual(inCountry);
    expect(await collected(id.group, "?photographedIn=province")).toEqual(inCountry);
  });

  it("counts only photos in the province itself at province level", async () => {
    expect(await collected(id.alberta, "?photographedIn=province")).toEqual([IN_ALBERTA]);
    expect(await collected(id.groupProvince, "?photographedIn=province")).toEqual([IN_GROUP_PROVINCE]);
  });

  it("leaves seen marks and targets alone, and the list itself unchanged", async () => {
    await db.query(`UPDATE user_species SET is_target = true WHERE user_id = $1 AND species_id = $2`, [
      USER,
      ELSEWHERE,
    ]);
    const res = await get(`/api/regions/${id.alberta}/species?photographedIn=province`);
    const item = res.json().items.find((i: { speciesId: string }) => i.speciesId === ELSEWHERE);
    expect(item).toMatchObject({ state: "unseen", isTarget: true });
    expect(res.json().stats.total).toBe(ALL_SPECIES.length);
    const missing = await get(`/api/regions/${id.alberta}/species?photographedIn=province&filter=missing`);
    expect(missing.json().items).toHaveLength(ALL_SPECIES.length - 1);
  });

  it("rejects an unknown level", async () => {
    expect((await get(`/api/regions/${id.alberta}/species?photographedIn=planet`)).statusCode).toBe(400);
    expect((await get(`/api/regions/${id.alberta}/species/count?photographedIn=planet`)).statusCode).toBe(400);
  });

  describe("photographedWhere", () => {
    async function where(route: string) {
      const res = await get(route);
      expect(res.statusCode).toBe(200);
      const items = res.json().items as Array<{ speciesId: string; photographedWhere?: string | null }>;
      return Object.fromEntries(items.map((i) => [i.speciesId, i.photographedWhere]));
    }

    it("marks live photos in a province as here, located ones outside as elsewhere, unlocated as neither", async () => {
      expect(await where(`/api/regions/${id.alberta}/species`)).toEqual({
        [IN_ALBERTA]: "here",
        // Its other photo, on the island, doesn't make it elsewhere.
        [IN_GROUP_PROVINCE]: "elsewhere",
        [SECONDARY]: "elsewhere",
        // Another user's photo in Alberta doesn't count.
        [ELSEWHERE]: "elsewhere",
        // Trashed and hidden photos don't count; with no other photo, nothing is located.
        [TRASHED]: null,
        [HIDDEN]: null,
        [NO_PLACE]: null,
      });
    });

    it("counts provinces inside a country or group, and provinces shown under the continent", async () => {
      expect(await where(`/api/regions/${id.country}/species`)).toMatchObject({
        [IN_GROUP_PROVINCE]: "here",
        [SECONDARY]: "here",
        [IN_ALBERTA]: "here",
        [ELSEWHERE]: "elsewhere",
        [NO_PLACE]: null,
      });
      expect(await where(`/api/regions/${id.group}/species`)).toMatchObject({
        [IN_GROUP_PROVINCE]: "here",
        [IN_ALBERTA]: "elsewhere",
      });
    });

    it("is independent of the Count photos from choice", async () => {
      expect(await where(`/api/regions/${id.alberta}/species?photographedIn=province`)).toMatchObject({
        [IN_ALBERTA]: "here",
        [ELSEWHERE]: "elsewhere",
      });
    });

    it("isn't on a continent's combined list", async () => {
      const res = await get(`/api/regions/${id.hub}/aggregate-species`);
      expect(res.statusCode).toBe(200);
      const items = res.json().items as Array<Record<string, unknown>>;
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i) => !("photographedWhere" in i))).toBe(true);
    });
  });
});

// The scope changes only the photographed state and counts: the list is always the region's
// checklist, and a vagrant listing shows only when photographed in the region itself.
describe.skipIf(!url)("photographedIn keeps the checklist", () => {
  const USER3 = "abcdabcd-0000-4000-8000-000000000a01";
  const TOKEN3 = "lifer_test_photographed_in_a01";
  const vs = (n: number) => `abcdabcd-0000-4000-8000-000000000b0${n}`;
  // Listed in Zzcanada, photographed only in Zzbelize.
  const LISTED_AWAY = vs(1);
  // A vagrant in Zzcanada, photographed only in Zzbelize.
  const VAGRANT_AWAY = vs(2);
  // Listed in Zzcanada and photographed there.
  const LISTED_HERE = vs(3);
  // A vagrant in Zzcanada, photographed there.
  const VAGRANT_HERE = vs(4);
  // Listed in Zzcanada, never photographed.
  const MISSING = vs(5);
  const SPECIES = [LISTED_AWAY, VAGRANT_AWAY, LISTED_HERE, VAGRANT_HERE, MISSING];
  const NAMES3 = { hub: "Zzkeep Continent", canada: "Zzkeep Canada", belize: "Zzkeep Belize" };
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;
  const id: Record<keyof typeof NAMES3, string> = {} as never;

  async function view(query: string) {
    const get = (route: string) =>
      app.inject({ method: "GET", url: `/api/regions/${id.canada}${route}`, cookies: { [cookieName]: TOKEN3 } });
    const res = await get(`/species${query}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      stats: { total: number; collected: number };
      items: Array<{ speciesId: string; state: string } & Record<string, unknown>>;
    };
    expect((await get(`/species/count${query}`)).json()).toMatchObject(body.stats);
    return {
      stats: body.stats,
      states: Object.fromEntries(body.items.map((i) => [i.speciesId, i.state])),
      items: body.items,
    };
  }

  async function cleanup() {
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER3]);
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER3]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER3]);
    await db.query(`DELETE FROM regions WHERE name = ANY($1) AND parent_id IS NOT NULL`, [Object.values(NAMES3)]);
    await db.query(`DELETE FROM regions WHERE name = $1`, [NAMES3.hub]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [SPECIES]);
    await db.query(`DELETE FROM downloaded_packs WHERE region = $1`, [NAMES3.canada]);
  }

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { regionRoutes } = await import("./routes.js");
    await cleanup();
    // Hiding obscure species is what hides vagrant listings.
    await db.query(
      `INSERT INTO users (id, email, password_hash, hide_obscure_species) VALUES ($1, 'photographed-in-keep@test', 'x', true)`,
      [USER3],
    );
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN3),
      USER3,
    ]);
    const region = async (name: string, parentId: string | null, codes: string[]) =>
      (
        await db.query<{ id: string }>(
          `INSERT INTO regions (name, parent_id, external_codes, occurrence_computed_at) VALUES ($1, $2, $3, now()) RETURNING id`,
          [name, parentId, codes],
        )
      ).rows[0].id;
    id.hub = await region(NAMES3.hub, null, []);
    id.canada = await region(NAMES3.canada, id.hub, ["ZZK"]);
    id.belize = await region(NAMES3.belize, id.hub, ["ZZB"]);
    await db.query(`INSERT INTO downloaded_packs (pack_id, region, taxon) VALUES ('zzkeep-aves', $1, 'aves')`, [
      NAMES3.canada,
    ]);
    for (const [i, speciesId] of SPECIES.entries()) {
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, $2, $3, $4, 'aves')`,
        [speciesId, 942001 + i, `Zzkeepus s${i}`, `Keep Bird ${i}`],
      );
      await db.query(
        `INSERT INTO species_traits (species_id, occurrence_count, last_occurrence_year, source_attribution)
         VALUES ($1, 5000, 2025, 'test')`,
        [speciesId],
      );
      const vagrant = speciesId === VAGRANT_AWAY || speciesId === VAGRANT_HERE;
      await db.query(`INSERT INTO region_species (region_id, species_id, is_vagrant) VALUES ($1, $2, $3)`, [
        id.canada,
        speciesId,
        vagrant,
      ]);
      if (speciesId === MISSING) continue;
      await db.query(`INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'collected')`, [
        USER3,
        speciesId,
      ]);
      const where = speciesId === LISTED_HERE || speciesId === VAGRANT_HERE ? id.canada : id.belize;
      await db.query(`INSERT INTO captures_all (user_id, species_id, fingerprint, region_id) VALUES ($1, $2, $3, $4)`, [
        USER3,
        speciesId,
        `zzkeep-${speciesId}`,
        where,
      ]);
    }
    app = Fastify();
    await app.register(cookie);
    await app.register(regionRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.end();
  });

  it("counts every species photographed anywhere, out of the whole checklist", async () => {
    const { stats, states } = await view("");
    expect(states).toEqual({
      [LISTED_AWAY]: "collected",
      [LISTED_HERE]: "collected",
      [VAGRANT_HERE]: "collected",
      [MISSING]: "unseen",
    });
    expect(stats).toMatchObject({ total: 4, collected: 3 });
  });

  it("lists the same species with only photos from the country counting", async () => {
    const { stats, states } = await view("?photographedIn=country");
    expect(states).toEqual({
      // Photographed only in Belize: still on the checklist, as not photographed here.
      [LISTED_AWAY]: "unseen",
      [LISTED_HERE]: "collected",
      [VAGRANT_HERE]: "collected",
      [MISSING]: "unseen",
    });
    expect(stats).toMatchObject({ total: 4, collected: 2 });
  });
});

// Where a photo was taken beats where it's filed: an import files every photo under the batch's
// region, so a trip abroad can sit under home.
describe.skipIf(!url)("photographedIn by a photo's position", () => {
  const USER2 = "abcdabcd-0000-4000-8000-000000000e01";
  const TOKEN2 = "lifer_test_photographed_in_e01";
  const ps = (n: number) => `abcdabcd-0000-4000-8000-000000000f0${n}`;
  // Filed under the country, taken in the other one.
  const FILED_HERE_TAKEN_AWAY = ps(1);
  // Filed under the other country, taken in this one.
  const FILED_AWAY_TAKEN_HERE = ps(2);
  // Filed under the country, taken from a boat 5 km off its coast.
  const OFFSHORE_FILED_HERE = ps(3);
  // The same spot, filed under the other country.
  const OFFSHORE_FILED_AWAY = ps(4);
  // Filed under the country's province, no position.
  const NO_POSITION = ps(5);
  // Filed and taken in the other country.
  const AWAY = ps(6);
  const SPECIES = [
    FILED_HERE_TAKEN_AWAY,
    FILED_AWAY_TAKEN_HERE,
    OFFSHORE_FILED_HERE,
    OFFSHORE_FILED_AWAY,
    NO_POSITION,
    AWAY,
  ];
  const NAMES2 = {
    hub: "Zzplace Continent",
    country: "Zzplaceland",
    province: "Zzplace North",
    other: "Zzplace Otherland",
  };
  const box = (w: number, e: number) => ({
    type: "Polygon",
    coordinates: [
      [
        [w, 0],
        [e, 0],
        [e, 10],
        [w, 10],
        [w, 0],
      ],
    ],
  });
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;
  const id: Record<keyof typeof NAMES2, string> = {} as never;

  async function scoped(query: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/regions/${id.country}/species${query}`,
      cookies: { [cookieName]: TOKEN2 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { stats: { collected: number }; items: Array<{ speciesId: string; state: string }> };
    const ids = body.items.filter((i) => i.state === "collected").map((i) => i.speciesId);
    expect(body.stats.collected).toBe(ids.length);
    const count = await app.inject({
      method: "GET",
      url: `/api/regions/${id.country}/species/count${query}`,
      cookies: { [cookieName]: TOKEN2 },
    });
    expect(count.json().collected).toBe(ids.length);
    return { ids: ids.sort(), state: (s: string) => body.items.find((i) => i.speciesId === s)?.state };
  }

  async function cleanup() {
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER2]);
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER2]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER2]);
    await db.query(`DELETE FROM regions WHERE name = ANY($1) AND parent_id IS NOT NULL`, [Object.values(NAMES2)]);
    await db.query(`DELETE FROM regions WHERE name = $1`, [NAMES2.hub]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [SPECIES]);
    await db.query(`DELETE FROM downloaded_packs WHERE region = $1`, [NAMES2.country]);
  }

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { regionRoutes } = await import("./routes.js");
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'photographed-in-place@test', 'x')`, [
      USER2,
    ]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN2),
      USER2,
    ]);
    const region = async (name: string, parentId: string | null, codes: string[], outline: unknown = null) =>
      (
        await db.query<{ id: string }>(
          `INSERT INTO regions (name, parent_id, external_codes, occurrence_computed_at, boundary_geojson)
           VALUES ($1, $2, $3, now(), $4) RETURNING id`,
          [name, parentId, codes, outline && JSON.stringify(outline)],
        )
      ).rows[0].id;
    id.hub = await region(NAMES2.hub, null, []);
    id.country = await region(NAMES2.country, id.hub, ["ZZP"], box(0, 10));
    id.province = await region(NAMES2.province, id.country, ["ZZP-N"], box(0, 10));
    id.other = await region(NAMES2.other, id.hub, ["ZZQ"], box(20, 30));
    await db.query(`INSERT INTO downloaded_packs (pack_id, region, taxon) VALUES ('zzplace-aves', $1, 'aves')`, [
      NAMES2.country,
    ]);
    for (const [i, speciesId] of SPECIES.entries()) {
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, $2, $3, $4, 'aves')`,
        [speciesId, 941001 + i, `Zzplacus s${i}`, `Place Bird ${i}`],
      );
      await db.query(`INSERT INTO region_species (region_id, species_id) VALUES ($1, $2)`, [id.country, speciesId]);
      await db.query(`INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'collected')`, [
        USER2,
        speciesId,
      ]);
    }
    const capture = (speciesId: string, regionId: string, at: [number, number] | null) =>
      db.query(
        `INSERT INTO captures_all (user_id, species_id, fingerprint, region_id, lon, lat) VALUES ($1, $2, $3, $4, $5, $6)`,
        [USER2, speciesId, `zzplace-${speciesId}`, regionId, at?.[0] ?? null, at?.[1] ?? null],
      );
    await capture(FILED_HERE_TAKEN_AWAY, id.province, [25, 5]);
    await capture(FILED_AWAY_TAKEN_HERE, id.other, [5, 5]);
    // About 5 km east of the coast at 10 degrees east.
    await capture(OFFSHORE_FILED_HERE, id.province, [10.045, 5]);
    await capture(OFFSHORE_FILED_AWAY, id.other, [10.045, 5]);
    await capture(NO_POSITION, id.province, null);
    await capture(AWAY, id.other, [25, 5]);

    app = Fastify();
    await app.register(cookie);
    await app.register(regionRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.end();
    // The last block in this file closes the app's shared pool.
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("counts a photo by where it was taken, by its filing only without a position", async () => {
    const inCountry = await scoped("?photographedIn=country");
    expect(inCountry.ids).toEqual([FILED_AWAY_TAKEN_HERE, OFFSHORE_FILED_HERE, NO_POSITION].sort());
    // Not photographed there, on the card as in the header.
    expect(inCountry.state(FILED_HERE_TAKEN_AWAY)).toBe("unseen");
    expect(inCountry.state(AWAY)).toBe("unseen");
    // Province level on a country page is the country.
    expect((await scoped("?photographedIn=province")).ids).toEqual(inCountry.ids);
  });

  it("counts every one anywhere", async () => {
    expect((await scoped("")).ids).toEqual([...SPECIES].sort());
  });
});
