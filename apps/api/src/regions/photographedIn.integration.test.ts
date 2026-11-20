// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// "Count photos from": a species counts as photographed on a region's checklist only with a live
// photo in the viewed region's country or province. Also each row's photographedWhere, for the
// Photos taken filter.
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
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
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
