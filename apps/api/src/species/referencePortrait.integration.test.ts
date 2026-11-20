// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run referencePortrait.integration
// Reference photos that aren't of the animal (eggs, nests...) go last, and never stay the cover
// while a portrait exists.
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});
vi.mock("../auth/session.js", () => {
  const allow = async () => {};
  return { requireAuth: allow, requireScope: () => allow };
});

const url = process.env.TEST_DATABASE_URL;
const SWAPPED = "eeeeeeee-0000-4000-8000-000000000189";
const KEPT = "eeeeeeee-0000-4000-8000-000000000190";
const photo = (n: string) => `https://inaturalist-open-data.s3.amazonaws.com/photos/${n}/medium.jpg`;

describe.skipIf(!url)("reference photo kinds (integration)", async () => {
  const db = new pg.Pool({ connectionString: url });
  const { scorePendingReferencePhotos, promptVectors, classifyReferencePhoto } =
    await import("@lifer/core/species/referencePortrait.js");
  const { PROMPTS } = await import("@lifer/core/species/portraitPromptVectors.js");
  const { EMBEDDING_MODEL_VERSION } = await import("@lifer/core/config.js");
  const { pool } = await import("@lifer/core/db.js");
  const vec = (text: string) => Array.from(promptVectors()[PROMPTS.findIndex(([, t]) => t === text)]);
  let app: FastifyInstance;

  async function addMain(speciesId: string, gbif: number, url: string, prompt: string) {
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class, reference_photo, reference_credit, reference_license,
         reference_display_path, reference_thumb_path)
       VALUES ($1, $2, $3, 'aves', $4, 'main credit', 'cc-by', '/cache/main.webp', '/cache/main-thumb.webp')`,
      [speciesId, gbif, `Testus portraitus ${gbif}`, url],
    );
    await db.query(
      `INSERT INTO species_reference_embeddings (species_id, embedding, model_version) VALUES ($1, $2, $3)`,
      [speciesId, vec(prompt), EMBEDDING_MODEL_VERSION],
    );
    await db.query(
      `INSERT INTO id_model_reference_embeddings (species_id, embedding, model_version) VALUES ($1, '{1,0}', 'id-test')`,
      [speciesId],
    );
  }
  async function addGallery(speciesId: string, sort: number, url: string, prompt: string) {
    const res = await db.query<{ id: string }>(
      `INSERT INTO species_reference_photos (species_id, photo_url, credit, license, sort_order, display_path, thumb_path)
       VALUES ($1, $2, $3, 'cc-by-nc', $4, $5, $6) RETURNING id`,
      [speciesId, url, `credit ${sort}`, sort, `/cache/g${sort}.webp`, `/cache/g${sort}-thumb.webp`],
    );
    await db.query(
      `INSERT INTO species_reference_gallery_embeddings (reference_photo_id, species_id, embedding, model_version) VALUES ($1, $2, $3, $4)`,
      [res.rows[0].id, speciesId, vec(prompt), EMBEDDING_MODEL_VERSION],
    );
    return res.rows[0].id;
  }
  const cleanUp = () => db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SWAPPED, KEPT]]);

  // The higher-scoring of the two portraits (gallery sort 1 or 2) becomes the main photo.
  const best =
    classifyReferencePhoto(vec("a photo of a bird")).score >= classifyReferencePhoto(vec("a wildlife photograph")).score
      ? 1
      : 2;
  beforeAll(async () => {
    await cleanUp();
    // The Pauraque case: the main photo is eggs, the gallery has a nest and two portraits.
    await addMain(SWAPPED, 918901, photo("1"), "a clutch of eggs in a nest");
    await addGallery(SWAPPED, 0, photo("2"), "a photo of an empty bird nest");
    await addGallery(SWAPPED, 1, photo("3"), "a photo of a bird");
    await addGallery(SWAPPED, 2, photo("4"), "a wildlife photograph");
    // Nothing usable to swap in: the main photo stays.
    await addMain(KEPT, 918902, photo("5"), "a range map");
    await addGallery(KEPT, 0, photo("6"), "animal footprints in mud");

    const { referencePhotoRoutes } = await import("./referencePhotos.js");
    app = Fastify();
    await app.register(async (api) => api.register(referencePhotoRoutes), { prefix: "/api" });
    await app.ready();
    await scorePendingReferencePhotos(2); // several batches
  });

  afterAll(async () => {
    await app?.close();
    await cleanUp();
    await db.end();
    await pool.end();
  });

  it("swaps a main photo that isn't a portrait with the best portrait, file, credit and vectors included", async () => {
    const main = (
      await db.query(
        `SELECT reference_photo, reference_credit, reference_license, reference_display_path, reference_portrait_kind
           FROM species WHERE id = $1`,
        [SWAPPED],
      )
    ).rows[0];
    expect(main).toEqual({
      reference_photo: photo(String(best + 2)),
      reference_credit: `credit ${best}`,
      reference_license: "cc-by-nc",
      reference_display_path: `/cache/g${best}.webp`,
      reference_portrait_kind: "portrait",
    });

    const demoted = (
      await db.query(`SELECT * FROM species_reference_photos WHERE species_id = $1 AND photo_url = $2`, [
        SWAPPED,
        photo("1"),
      ])
    ).rows[0];
    expect(demoted).toMatchObject({
      credit: "main credit",
      license: "cc-by",
      display_path: "/cache/main.webp",
      portrait_kind: "egg",
    });

    const mainVec = await db.query(`SELECT embedding FROM species_reference_embeddings WHERE species_id = $1`, [
      SWAPPED,
    ]);
    expect(mainVec.rows[0].embedding[0]).toBeCloseTo(
      vec(best === 1 ? "a photo of a bird" : "a wildlife photograph")[0],
      5,
    );
    const idVec = await db.query(`SELECT 1 FROM id_model_gallery_embeddings WHERE reference_photo_id = $1`, [
      demoted.id,
    ]);
    expect(idVec.rowCount).toBe(1);
    expect(
      await db.query(`SELECT 1 FROM id_model_reference_embeddings WHERE species_id = $1`, [SWAPPED]),
    ).toMatchObject({
      rowCount: 0,
    });
  });

  it("lists portraits first and the rest last, in their own order", async () => {
    const res = await app.inject({ method: "GET", url: `/api/species/${SWAPPED}/reference-photos` });
    expect(res.statusCode).toBe(200);
    const credits = res.json().photos.map((p: { credit: string }) => p.credit);
    expect(credits.slice(0, 2)).toEqual([`credit ${best}`, `credit ${3 - best}`]); // new main, other portrait
    expect(credits.slice(2)).toEqual(["credit 0", "main credit"]); // nest, then eggs (sort 0, then 1)
  });

  it("keeps the main photo when no gallery photo is a portrait", async () => {
    const kept = (await db.query(`SELECT reference_photo, reference_portrait_kind FROM species WHERE id = $1`, [KEPT]))
      .rows[0];
    expect(kept).toEqual({ reference_photo: photo("5"), reference_portrait_kind: "map" });
  });

  it("never rescores a scored photo, and rescores a main photo whose URL changed", async () => {
    expect(await scorePendingReferencePhotos()).toEqual({ scored: 0, swapped: 0 });
    await db.query(`UPDATE species SET reference_photo = $2 WHERE id = $1`, [KEPT, photo("7")]);
    expect((await db.query(`SELECT reference_portrait_kind FROM species WHERE id = $1`, [KEPT])).rows[0]).toEqual({
      reference_portrait_kind: null,
    });
    expect(await scorePendingReferencePhotos()).toEqual({ scored: 1, swapped: 0 });
  });
});
