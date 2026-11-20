// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55432/lifer npx vitest run captures/suggestions
// "Correct the ID" offers the other species a photo already in the library most likely shows.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000901";
const OTHER_USER = "eeeeeeee-0000-4000-8000-000000000902";
const REGION = "eeeeeeee-0000-4000-8000-0000000009a0";
const SPECIES = {
  current: "eeeeeeee-0000-4000-8000-0000000009a1",
  close: "eeeeeeee-0000-4000-8000-0000000009a2",
  far: "eeeeeeee-0000-4000-8000-0000000009a3",
  // Nearly as close as `close`, in the same genus: a toss-up between the two species.
  twin: "eeeeeeee-0000-4000-8000-0000000009a4",
};
const TOKEN = "lifer_test_capture_suggestions_901";

// A unit vector along axis 0, tilted toward axis 1 by `tilt`.
const vector = (tilt: number) =>
  Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : i === 1 ? tilt : 0) / Math.hypot(1, tilt));

describe.skipIf(!url)("photo suggestions", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName: string;
  const capture = { withVector: "", withoutVector: "", others: "" };

  const get = (id: string) =>
    app.inject({ method: "GET", url: `/api/captures/${id}/suggestions`, cookies: { [cookieName]: TOKEN } });

  async function cleanup() {
    await db.query(`DELETE FROM captures_all WHERE user_id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`DELETE FROM users WHERE id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`DELETE FROM region_species WHERE region_id = $1`, [REGION]);
    await db.query(`DELETE FROM regions WHERE id = $1`, [REGION]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [Object.values(SPECIES)]);
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-capture-suggestions-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    const { EMBEDDING_MODEL_VERSION, SESSION_COOKIE_NAME } = await import("@lifer/core/config.js");
    cookieName = SESSION_COOKIE_NAME;
    const { clipModel } = await import("@lifer/core/species/clipModel.js");
    vi.spyOn(clipModel, "isDownloaded").mockReturnValue(true);
    const { captureRoutes } = await import("./routes.js");

    await cleanup();
    await db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'suggest-a@test', 'x'), ($2, 'suggest-b@test', 'x')`,
      [USER, OTHER_USER],
    );
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    await db.query(
      `INSERT INTO regions (id, name, parent_id, external_codes) VALUES ($1, 'Suggestland', NULL, '{ZZ-SG}')`,
      [REGION],
    );
    const refs: Record<keyof typeof SPECIES, number[]> = {
      current: vector(0.1),
      close: vector(0.2),
      far: vector(0.4),
      twin: vector(0.201),
    };
    let gbif = 920901;
    for (const key of Object.keys(SPECIES) as Array<keyof typeof SPECIES>) {
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class, reference_photo, reference_credit, reference_license)
         VALUES ($1, $2, $3, $4, 'aves', 'https://example.com/ref.jpg', 'Test', 'CC0')`,
        [SPECIES[key], gbif++, `Testus ${key}`, `Suggest ${key}`],
      );
      await db.query(
        `INSERT INTO species_reference_embeddings (species_id, embedding, model_version) VALUES ($1, $2, $3)`,
        [SPECIES[key], refs[key], EMBEDDING_MODEL_VERSION],
      );
      await db.query(`INSERT INTO region_species (region_id, species_id) VALUES ($1, $2)`, [REGION, SPECIES[key]]);
    }
    const insertCapture = async (userId: string, fingerprint: string) =>
      (
        await db.query<{ id: string }>(
          `INSERT INTO captures (user_id, species_id, region_id, fingerprint) VALUES ($1, $2, $3, $4) RETURNING id`,
          [userId, SPECIES.current, REGION, fingerprint],
        )
      ).rows[0].id;
    capture.withVector = await insertCapture(USER, "suggest-with");
    capture.withoutVector = await insertCapture(USER, "suggest-without");
    capture.others = await insertCapture(OTHER_USER, "suggest-others");
    for (const id of [capture.withVector, capture.others])
      await db.query(`INSERT INTO capture_embeddings (capture_id, embedding, model_version) VALUES ($1, $2, $3)`, [
        id,
        vector(0.1),
        EMBEDDING_MODEL_VERSION,
      ]);

    app = Fastify();
    await app.register(cookie);
    await app.register(captureRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
    if (db) {
      await cleanup();
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("ranks the region's other species from the stored vector, leaving out the current one", async () => {
    const res = await get(capture.withVector);
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { suggestions: Array<{ id: string }> }).suggestions.map((s) => s.id);
    expect(ids).toEqual([SPECIES.close, SPECIES.twin, SPECIES.far]);
  });

  it("offers the genus the near-tied top species share, since neither is a confident pick", async () => {
    const [top, ...rest] = (
      (await get(capture.withVector)).json() as { suggestions: Array<{ confident?: boolean; probably?: unknown }> }
    ).suggestions;
    expect(top.confident).toBe(false);
    expect(top.probably).toEqual({ rank: "genus", name: "Testus", taxonClass: "aves" });
    expect(rest.every((s) => s.probably === undefined)).toBe(true);
  });

  it("is empty for a photo with no stored vector", async () => {
    expect((await get(capture.withoutVector)).json()).toStrictEqual({ suggestions: [] });
  });

  it("refuses someone else's photo", async () => {
    expect((await get(capture.others)).statusCode).toBe(404);
  });
});
