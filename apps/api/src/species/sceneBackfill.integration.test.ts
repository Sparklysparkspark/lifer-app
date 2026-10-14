// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55434/lifer_test npx vitest run sceneBackfill
// The scene backfill picks up captures with no scene from the current model, an older model's
// scene, or a scene of a photo the capture no longer shows.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});

const url = process.env.TEST_DATABASE_URL;
const USER = "abcdabcd-0000-4000-8000-000000000d01";
const SPECIES = "abcdabcd-0000-4000-8000-000000000d0a";

describe.skipIf(!url)("capturesNeedingScene", () => {
  let db: pg.Pool;
  const capture: Record<"none" | "current" | "oldModel" | "oldPhoto", { id: string; photo: string }> = {
    none: { id: "", photo: "" },
    current: { id: "", photo: "" },
    oldModel: { id: "", photo: "" },
    oldPhoto: { id: "", photo: "" },
  };

  async function cleanup() {
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
  }

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'scene-backfill@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 920801, 'Testus scenicus', 'Scene Bird', 'aves')`,
      [SPECIES],
    );
    const { SCENE_MODEL_VERSION } = await import("@lifer/core/config.js");
    for (const key of Object.keys(capture) as Array<keyof typeof capture>) {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures (user_id, species_id, fingerprint) VALUES ($1, $2, $3) RETURNING id`,
        [USER, SPECIES, `scene-backfill-${key}`],
      );
      const p = await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
        [c.rows[0].id],
      );
      await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
      capture[key] = { id: c.rows[0].id, photo: p.rows[0].id };
    }
    const scene = (captureId: string, photoId: string, version: string) =>
      db.query(
        `INSERT INTO capture_scenes (capture_id, photo_id, model_version, labels, colors) VALUES ($1, $2, $3, '{}', '{}')`,
        [captureId, photoId, version],
      );
    await scene(capture.current.id, capture.current.photo, SCENE_MODEL_VERSION);
    await scene(capture.oldModel.id, capture.oldModel.photo, "an-older-scene-model");
    await scene(capture.oldPhoto.id, capture.current.photo, SCENE_MODEL_VERSION);
  });

  afterAll(async () => {
    if (db) {
      await cleanup();
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("lists captures without a current scene of their current photo", async () => {
    const { capturesNeedingScene } = await import("./embeddingBackfill.js");
    const ours = new Set(Object.values(capture).map((c) => c.id));
    const rows = (await capturesNeedingScene(db)).filter((r) => ours.has(r.id));
    expect(rows.map((r) => r.id).sort()).toEqual([capture.none.id, capture.oldModel.id, capture.oldPhoto.id].sort());
    expect(rows.find((r) => r.id === capture.oldPhoto.id)).toEqual({
      id: capture.oldPhoto.id,
      photo_id: capture.oldPhoto.photo,
      display_path: "/nowhere/d.webp",
    });
  });
});
