// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// The search frames job reads only what's missing or changed, stores frames and background vectors
// against the photo they came from, and Gallery search filters on them.
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "ffffffff-0000-4000-8000-000000000611";
const SPECIES = "ffffffff-0000-4000-8000-0000000006a1";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "frames@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

// The detector and CLIP are stood in for: each display path says what the photo holds.
const seen = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("@lifer/core/species/inference.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("@lifer/core/species/inference.js")>();
  const light = { luma: 0.2, warmth: -0.05, highlights: 0, shadows: 0.2, saturation: 0.3 };
  return {
    ...real,
    analyzeImage: async (image: { path: string }, opts: { targets: Array<{ maskSubject?: boolean }> }) => {
      seen.paths.push(image.path);
      // "phi": a small animal on a golden ratio point; "fill": one filling the frame; else nothing found.
      const box = image.path.includes("phi")
        ? [0.57, 0.33, 0.67, 0.43]
        : image.path.includes("fill")
          ? [0.05, 0.05, 0.95, 0.95]
          : null;
      const leavesBackground = box && (box[2] - box[0]) * (box[3] - box[1]) <= 0.6;
      return {
        vectors: opts.targets.map(() =>
          leavesBackground ? new Float32Array([1, 0, 0]) : { error: "No background to read" },
        ),
        presence: null,
        cardCrop: null,
        subjectUnsure: !box,
        frame: { box, unsure: !box, aspect: 1.5, light },
      };
    },
  };
});
vi.mock("@lifer/core/species/embeddings.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("@lifer/core/species/embeddings.js")>();
  return {
    ...real,
    clipModel: {
      ...real.clipModel,
      isDownloaded: () => true,
      target: () => ({ modelPath: "x", missingMessage: "x", crop: false }),
    },
    isInferenceStuck: () => false,
  };
});

describe.skipIf(!url)("search frames job and search", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  const ids: Record<string, string> = {};

  async function addCapture(name: string, displayPath: string): Promise<string> {
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at, lat, lon, taken_at_zoned)
       VALUES ($1, $2, $3, '2024-03-20T00:00:00Z', 51.48, 0, true) RETURNING id`,
      [USER, SPECIES, `frames-${name}`],
    );
    const p = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path, width, height) VALUES ($1, $2, '/nowhere/t.webp', 1500, 1000) RETURNING id`,
      [c.rows[0].id, displayPath],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
    return c.rows[0].id;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    db = new pg.Pool({ connectionString: url });
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'frames@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class, taxon_order, family)
       VALUES ($1, 912601, 'Canis framus', 'Frame Wolf', 'mammalia', 'Carnivora', 'Canidae')
       ON CONFLICT (id) DO NOTHING`,
      [SPECIES],
    );
    ids.phi = await addCapture("phi", "/nowhere/phi.webp");
    ids.fill = await addCapture("fill", "/nowhere/fill.webp");
    ids.none = await addCapture("none", "/nowhere/none.webp");
    const { galleryRoutes, clearGallerySearchCaches } = await import("../gallery/routes.js");
    clearGallerySearchCaches();
    app = Fastify();
    await app.register(galleryRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  const run = async () => {
    seen.paths = [];
    const { runFrameBackfill } = await import("./frames.js");
    await runFrameBackfill();
    return seen.paths.filter((p) => /\/(phi|fill|none)/.test(p)).sort();
  };

  it("reads each photo once, and a background only where the animal leaves one", async () => {
    expect(await run()).toEqual(["/nowhere/fill.webp", "/nowhere/none.webp", "/nowhere/phi.webp"]);
    const frames = await db.query(
      `SELECT capture_id, box, aspect FROM capture_frames WHERE capture_id = ANY($1::uuid[])`,
      [Object.values(ids)],
    );
    expect(frames.rows).toHaveLength(3);
    const bg = await db.query(
      `SELECT capture_id FROM capture_background_embeddings WHERE capture_id = ANY($1::uuid[])`,
      [Object.values(ids)],
    );
    expect(bg.rows.map((r) => r.capture_id)).toEqual([ids.phi]);
    // Finished photos are never read again.
    expect(await run()).toEqual([]);
  });

  it("reads a photo again when it changes, or when its background is missing", async () => {
    const p = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path, width, height) VALUES ($1, '/nowhere/phi-2.webp', '/nowhere/t.webp', 1500, 1000) RETURNING id`,
      [ids.phi],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, ids.phi]);
    expect(await run()).toEqual(["/nowhere/phi-2.webp"]);
    const bg = await db.query(`SELECT photo_id FROM capture_background_embeddings WHERE capture_id = $1`, [ids.phi]);
    expect(bg.rows[0].photo_id).toBe(p.rows[0].id);

    await db.query(`DELETE FROM capture_background_embeddings WHERE capture_id = $1`, [ids.phi]);
    expect(await run()).toEqual(["/nowhere/phi-2.webp"]);
  });

  it("filters search by composition and returns each photo's frame", async () => {
    const res = await app.inject({ method: "GET", url: "/api/gallery/search?q=golden%20ratio" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((i: { captureId: string }) => i.captureId)).toEqual([ids.phi]);
    const item = body.items[0];
    expect(item.frame).toMatchObject({
      box: [0.57, 0.33, 0.67, 0.43],
      orientation: "horizontal",
      composition: { size: "tiny", goldenRatio: true },
    });
    // Taken at midnight in London, and the stand-in light is dim: nothing wrong with the time.
    expect(item.timeMaybeWrong).toBe(false);
    expect(body.interpretation.parts).toEqual([
      { kind: "composition", label: "golden ratio", text: "golden ratio", exact: true },
    ]);

    const filling = await app.inject({ method: "GET", url: "/api/gallery/search?q=frame%20filling%20wolf" });
    expect(filling.json().items.map((i: { captureId: string }) => i.captureId)).toEqual([ids.fill]);
  });

  it("flags a daylit photo taken when the sun was well down", async () => {
    await db.query(
      `UPDATE capture_frames SET light = '{"luma":0.5,"warmth":0.02,"highlights":0.05,"shadows":0.03,"saturation":0.35}',
         computed_at = now() WHERE capture_id = $1`,
      [ids.fill],
    );
    (await import("../gallery/routes.js")).clearGallerySearchCaches();
    const res = await app.inject({ method: "GET", url: "/api/gallery/search?q=frame%20filling%20wolf" });
    expect(res.json().items[0].timeMaybeWrong).toBe(true);
  });
});
