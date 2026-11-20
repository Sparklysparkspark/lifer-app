// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// The userdata.read routes over HTTP with a real key: paging, since, deletions, other users' data,
// and that no catalog data appears.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CATALOG_FIELD } from "./responses.js";

const url = process.env.TEST_DATABASE_URL;
const USER = "cccccccc-0000-4000-8000-000000000601";
const OTHER = "cccccccc-0000-4000-8000-000000000602";
const REGION = "cccccccc-0000-4000-8000-000000000660";
const SP = ["a", "b", "c", "d", "e"].map((x) => `cccccccc-0000-4000-8000-0000000006${x}0`);
const TOKEN = "lifer_test_userdata_token_601";
const OTHER_TOKEN = "lifer_test_userdata_token_602";
const NARROW = "lifer_test_userdata_token_603";

type Item = Record<string, unknown> & { scientificName: string; updatedAt: string; deletedAt: string | null };

describe.skipIf(!url)("userdata endpoints (API key)", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dir: string;
  let ownPhoto = "";
  let hiddenPhoto = "";
  let otherPhoto = "";

  const get = (p: string, token = TOKEN) => app.inject({ method: "GET", url: p, headers: { "x-api-key": token } });
  async function all(query = "", token = TOKEN, limit = 2): Promise<Item[]> {
    const items: Item[] = [];
    let cursor: string | null = null;
    do {
      const res = await get(
        `/api/userdata/v1/species?limit=${limit}${query}${cursor ? `&cursor=${cursor}` : ""}`,
        token,
      );
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: Item[]; nextCursor: string | null };
      items.push(...body.items);
      cursor = body.nextCursor;
    } while (cursor);
    return items;
  }

  async function capture(user: string, species: string, display: string, hidden = false): Promise<string> {
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at, quality_rating, hidden_at)
       VALUES ($1, $2, gen_random_uuid()::text, now() - interval '1 day', 4, $3) RETURNING id`,
      [user, species, hidden ? new Date() : null],
    );
    const p = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, $2, $2) RETURNING id`,
      [c.rows[0].id, display],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
    return p.rows[0].id;
  }

  async function cleanup() {
    for (const u of [USER, OTHER]) {
      await db.query(`DELETE FROM user_species WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM sync_tombstones WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM api_keys WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM users WHERE id = $1`, [u]);
    }
    await db.query(`DELETE FROM region_species WHERE region_id = $1`, [REGION]);
    await db.query(`DELETE FROM regions WHERE id = $1`, [REGION]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [SP]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    dir = await mkdtemp(path.join(os.tmpdir(), "lifer-userdata-"));
    const file = path.join(dir, "d.webp");
    await sharp({ create: { width: 4, height: 4, channels: 3, background: "#336699" } })
      .webp()
      .toFile(file);
    const { hashApiKey } = await import("../auth/apiKeys.js");
    const { installSchemas } = await import("../lib/schema.js");
    const { apiRoutes } = await import("../apiRoutes.js");
    await cleanup();

    for (const [u, email] of [
      [USER, "userdata@test"],
      [OTHER, "userdata-other@test"],
    ])
      await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`, [u, email]);
    for (const [i, id] of SP.entries())
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, $2, $3, $4, 'aves')`,
        [id, 960600 + i, `Userdatus ${"abcde"[i]}`, `Catalog Name ${i}`],
      );
    // Catalog data that must never appear under userdata.read.
    await db.query(`INSERT INTO regions (id, name, parent_id) VALUES ($1, 'Leakland', NULL)`, [REGION]);
    for (const id of SP)
      await db.query(`INSERT INTO region_species (region_id, species_id) VALUES ($1, $2)`, [REGION, id]);

    ownPhoto = await capture(USER, SP[0], file);
    hiddenPhoto = await capture(USER, SP[0], file, true);
    otherPhoto = await capture(OTHER, SP[0], file);
    const mark = `INSERT INTO user_species (user_id, species_id, state, is_target, cover_photo_id, first_collected, best_quality)
                  VALUES ($1, $2, $3, $4, $5, $6, $7)`;
    await db.query(mark, [USER, SP[0], "collected", false, ownPhoto, "2026-01-02", 4]);
    await db.query(mark, [USER, SP[1], "seen", false, null, null, null]);
    await db.query(mark, [USER, SP[2], null, true, null, null, null]);
    // Someone else's photo as cover: the id must not be handed out.
    await db.query(mark, [USER, SP[3], "seen", true, otherPhoto, null, null]);
    await db.query(mark, [USER, SP[4], "seen", false, null, null, null]);
    await db.query(mark, [OTHER, SP[1], "collected", false, otherPhoto, null, null]);

    const key = `INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, 'k', $2, $3)`;
    await db.query(key, [USER, hashApiKey(TOKEN), ["userdata.read"]]);
    await db.query(key, [OTHER, hashApiKey(OTHER_TOKEN), ["userdata.read"]]);
    await db.query(key, [USER, hashApiKey(NARROW), ["photos.read"]]);

    app = Fastify();
    installSchemas(app);
    await app.register(cookie);
    await app.register(apiRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.end();
    await rm(dir, { recursive: true, force: true });
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("pages through every mark of the user, with only their own data", async () => {
    const items = await all();
    expect(items.map((i) => i.scientificName).sort()).toEqual([
      "Userdatus a",
      "Userdatus b",
      "Userdatus c",
      "Userdatus d",
      "Userdatus e",
    ]);
    const a = items.find((i) => i.scientificName === "Userdatus a")!;
    expect(a).toMatchObject({ speciesId: SP[0], state: "photographed", isTarget: false, photoCount: 1, bestRating: 4 });
    expect(a.coverPhotoId).toBe(ownPhoto);
    expect(items.find((i) => i.scientificName === "Userdatus c")).toMatchObject({ state: null, isTarget: true });
    expect(items.find((i) => i.scientificName === "Userdatus d")!.coverPhotoId).toBeNull();

    const other = await all("", OTHER_TOKEN);
    expect(other.map((i) => i.scientificName)).toEqual(["Userdatus b"]);
  });

  it("returns only changes after since, removed marks included", async () => {
    const before = await all("", TOKEN, 500);
    const since = before
      .map((i) => i.updatedAt)
      .sort()
      .at(-1)!;
    expect(await all(`&since=${encodeURIComponent(since)}`)).toEqual([]);

    await db.query(`UPDATE user_species SET is_target = true WHERE user_id = $1 AND species_id = $2`, [USER, SP[1]]);
    await db.query(`DELETE FROM user_species WHERE user_id = $1 AND species_id = $2`, [USER, SP[4]]);
    const changed = await all(`&since=${encodeURIComponent(since)}`, TOKEN, 1);
    expect(changed.map((i) => [i.scientificName, i.deletedAt !== null])).toEqual([
      ["Userdatus b", false],
      ["Userdatus e", true],
    ]);
    expect(changed[1]).toMatchObject({ speciesId: SP[4], state: null, photoCount: 0 });
    // The other user sees none of it.
    expect((await all("", OTHER_TOKEN)).map((i) => i.scientificName)).toEqual(["Userdatus b"]);
  });

  it("serves display images of the user's own visible photos only", async () => {
    const own = await get(`/api/userdata/v1/photos/${ownPhoto}/display`);
    expect(own.statusCode).toBe(200);
    expect(own.headers["content-type"]).toContain("image/webp");
    expect((await get(`/api/userdata/v1/photos/${otherPhoto}/display`)).statusCode).toBe(404);
    expect((await get(`/api/userdata/v1/photos/${hiddenPhoto}/display`)).statusCode).toBe(404);
    expect((await get(`/api/userdata/v1/photos/${ownPhoto}/display`, NARROW)).statusCode).toBe(401);
  });

  it("leaks no catalog data", async () => {
    const res = await get(`/api/userdata/v1/species?limit=500`);
    const text = res.body;
    expect(text).not.toMatch(/Leakland|Catalog Name/);
    const keys = (res.json() as { items: Item[] }).items.flatMap((i) => Object.keys(i));
    expect(keys.filter((k) => CATALOG_FIELD.test(k))).toEqual([]);
  });

  it("counts additional subjects, hides a hidden cover and rejects forged paging input", async () => {
    await db.query(
      `INSERT INTO capture_species (capture_id, species_id) SELECT capture_id, $2 FROM photos WHERE id = $1`,
      [ownPhoto, SP[1]],
    );
    await db.query(`UPDATE user_species SET cover_photo_id = $1 WHERE user_id = $2 AND species_id = $3`, [
      hiddenPhoto,
      USER,
      SP[2],
    ]);
    const items = await all("", TOKEN, 500);
    expect(items.find((i) => i.scientificName === "Userdatus b")!.photoCount).toBe(1);
    expect(items.find((i) => i.scientificName === "Userdatus c")!.coverPhotoId).toBeNull();

    const forged = Buffer.from(`1|s${SP[0]}`).toString("base64url");
    expect((await get(`/api/userdata/v1/species?cursor=${forged}`)).statusCode).toBe(400);
    expect((await get(`/api/userdata/v1/species?since=1`)).statusCode).toBe(400);
    const trick = await get(`/api/userdata/v1/photos/..%2F..%2Fetc%2Fpasswd/display`);
    expect([400, 404]).toContain(trick.statusCode);
    expect(trick.body).not.toMatch(/passwd|webp|tmp/);
  });

  it("sends photo-only changes after since without touching the mark's sync time", async () => {
    const marks = () =>
      db
        .query<{ species_id: string; updated_at: Date }>(
          `SELECT species_id, updated_at FROM user_species WHERE user_id = $1 ORDER BY species_id`,
          [USER],
        )
        .then((r) => r.rows);
    const before = await marks();
    async function changes(change: () => Promise<unknown>) {
      const since = (await all("", TOKEN, 500))
        .map((i) => i.updatedAt)
        .sort()
        .at(-1)!;
      await change();
      const items = await all(`&since=${encodeURIComponent(since)}`, TOKEN, 500);
      return Object.fromEntries(items.map((i) => [i.scientificName, [i.photoCount, i.lastPhotographed]]));
    }
    const run = (sql: string, params: unknown[]) => () => db.query(sql, params);
    const photo = await capture(USER, SP[0], path.join(dir, "d.webp"));
    let capt = "";

    expect(
      await changes(async () => {
        capt = (await db.query(`SELECT capture_id FROM photos WHERE id = $1`, [photo])).rows[0].capture_id;
        await db.query(`UPDATE captures_all SET species_id = $1 WHERE id = $2`, [SP[3], capt]);
      }),
    ).toEqual({ "Userdatus a": [1, expect.anything()], "Userdatus d": [1, expect.anything()] });
    expect(Object.keys(await changes(() => capture(USER, SP[3], path.join(dir, "d.webp"))))).toEqual(["Userdatus d"]);
    const redated = await changes(run(`UPDATE captures_all SET taken_at = '2030-05-05Z' WHERE id = $1`, [capt]));
    expect(redated).toEqual({ "Userdatus d": [2, "2030-05-05T00:00:00.000Z"] });
    expect(await changes(run(`UPDATE captures_all SET hidden_at = now() WHERE id = $1`, [capt]))).toMatchObject({
      "Userdatus d": [1, expect.anything()],
    });
    expect(Object.keys(await changes(run(`UPDATE captures_all SET hidden_at = NULL WHERE id = $1`, [capt])))).toEqual([
      "Userdatus d",
    ]);
    expect(await changes(run(`UPDATE captures_all SET deleted_at = now() WHERE id = $1`, [capt]))).toMatchObject({
      "Userdatus d": [1, expect.anything()],
    });
    expect(Object.keys(await changes(run(`UPDATE captures_all SET deleted_at = NULL WHERE id = $1`, [capt])))).toEqual([
      "Userdatus d",
    ]);
    const extra = `INSERT INTO capture_species (capture_id, species_id) VALUES ($1, $2)`;
    expect(await changes(run(extra, [capt, SP[2]]))).toEqual({ "Userdatus c": [1, "2030-05-05T00:00:00.000Z"] });
    const unextra = `DELETE FROM capture_species WHERE capture_id = $1 AND species_id = $2`;
    expect(await changes(run(unextra, [capt, SP[2]]))).toEqual({ "Userdatus c": [0, null] });
    // Deleting outright reaches the main and the extra subject.
    await db.query(extra, [capt, SP[2]]);
    expect(await changes(run(`DELETE FROM captures_all WHERE id = $1`, [capt]))).toEqual({
      "Userdatus c": [0, null],
      "Userdatus d": [1, expect.anything()],
    });
    // Photo changes alone never make a mark due for a desktop push.
    expect(await marks()).toEqual(before);
  });

  it("refuses a userdata.read key on every other route", async () => {
    const { routeCatalog } = await import("../lib/schema.js");
    // Routes that also accept userdata.read on purpose (the plugin host routes, for older keys) are not "other".
    const others = [...routeCatalog.values()].filter(
      (r) => r.scope && r.scope !== "userdata.read" && !r.alsoAccepts.includes("userdata.read"),
    );
    expect(others.length).toBeGreaterThan(40);
    const id = "cccccccc-0000-4000-8000-0000000006ff";
    const allowed: string[] = [];
    for (const r of others) {
      const res = await app.inject({
        method: r.method as "GET",
        url: r.url.replace(/:\w+/g, id).replace(/\*$/, ""),
        headers: { "x-api-key": TOKEN },
      });
      if (res.statusCode !== 401) allowed.push(`${r.method} ${r.url} ${res.statusCode}`);
    }
    expect(allowed).toEqual([]);
  });
});
