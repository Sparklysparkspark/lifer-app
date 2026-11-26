// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:5432/lifer_test npx vitest run suggestionPass
// The smart tag pass stores computed suggestions from stored signals, evaluates a photo again only
// when its inputs or the plan's version change, and reads a CLIP vector only when one is stored.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SMART_TAG_VOCAB } from "@lifer/shared";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  // An empty model folder: no text model, so nothing is embedded or cached on disk.
  const empty = `${process.env.TMPDIR ?? "/tmp"}/lifer-smart-tags-test-no-models`;
  process.env.APP_DATA_DIR = empty;
  process.env.LIFER_CACHE_DIR = empty;
});

const url = process.env.TEST_DATABASE_URL;
const USER = "abcdabcd-0000-4000-8000-000000000e01";
const SPECIES = "abcdabcd-0000-4000-8000-000000000e0a";

describe.skipIf(!url)("smart tag suggestion pass", () => {
  let db: pg.Pool;
  const id = { gps: "", bare: "", vector: "" };

  async function cleanup() {
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
  }
  const termsOf = async (captureId: string) =>
    (
      await db.query<{ term_id: string }>(
        `SELECT term_id FROM capture_smart_suggestions WHERE capture_id = $1 ORDER BY term_id`,
        [captureId],
      )
    ).rows.map((r) => r.term_id);

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'smart-tags@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 920901, 'Testus etiquetus', 'Tag Bird', 'aves')`,
      [SPECIES],
    );
    const { EMBEDDING_MODEL_VERSION, SCENE_MODEL_VERSION } = await import("@lifer/core/config.js");
    for (const key of Object.keys(id) as Array<keyof typeof id>) {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures (user_id, species_id, fingerprint, taken_at, lat, lon, taken_at_zoned, subject_count)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7) RETURNING id`,
        key === "gps"
          ? [USER, SPECIES, `smart-tags-${key}`, "2026-06-21T12:00:00Z", 51.5, -0.1, 2]
          : [USER, SPECIES, `smart-tags-${key}`, "2026-06-21T12:00:00Z", null, null, null],
      );
      const p = await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
        [c.rows[0].id],
      );
      await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
      id[key] = c.rows[0].id;
      if (key === "gps")
        await db.query(
          `INSERT INTO capture_scenes (capture_id, photo_id, model_version, labels, colors)
           VALUES ($1, $2, $3, '{"person": 10, "tree": 50}', '{"green": 40, "blue": 10}')`,
          [c.rows[0].id, p.rows[0].id, SCENE_MODEL_VERSION],
        );
    }
    const vector = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
    await db.query(`INSERT INTO capture_embeddings (capture_id, embedding, model_version) VALUES ($1, $2, $3)`, [
      id.vector,
      vector,
      EMBEDDING_MODEL_VERSION,
    ]);
  });

  afterAll(async () => {
    if (db) {
      await cleanup();
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("stores computed suggestions from stored signals and reports none pending", async () => {
    const { smartTagCounts, smartTagJob, startSmartTagPass } = await import("./suggestionPass.js");
    expect((await smartTagCounts(USER)).pending).toBe(3);
    expect(startSmartTagPass()).toBe(true);
    await smartTagJob.settled();
    expect(smartTagJob.status.error).toBeNull();
    expect(await termsOf(id.gps)).toEqual([
      "color.green-tones",
      "composition.pair",
      "people.people-in-photo",
      "season.summer",
      "time-of-day.midday",
    ]);
    // No place: no sun, no season. No scene, no colours.
    expect(await termsOf(id.bare)).toEqual([]);
    expect(await smartTagCounts(USER)).toEqual({ total: 3, pending: 0 });
  });

  it("evaluates a photo again when one of its stored inputs changes", async () => {
    const { smartTagCounts, smartTagJob, startSmartTagPass } = await import("./suggestionPass.js");
    await db.query(`UPDATE capture_scenes SET colors = '{"blue": 90}', computed_at = now() WHERE capture_id = $1`, [
      id.gps,
    ]);
    expect((await smartTagCounts(USER)).pending).toBe(1);
    startSmartTagPass();
    await smartTagJob.settled();
    expect(await termsOf(id.gps)).toContain("color.blue-tones");
    expect(await termsOf(id.gps)).not.toContain("color.green-tones");
    expect((await smartTagCounts(USER)).pending).toBe(0);
  });

  it("re-runs every photo from stored data after a vocabulary bump", async () => {
    const { planSmartTags } = await import("@lifer/core/smartTags/suggest.js");
    const { evaluateSmartTags, smartTagCounts } = await import("./suggestionPass.js");
    const vocab = {
      ...SMART_TAG_VOCAB,
      version: SMART_TAG_VOCAB.version + 1,
      terms: SMART_TAG_VOCAB.terms.map((t) => (t.group === "season" ? { ...t, enabled: false } : t)),
    };
    const plan = planSmartTags({ imageModel: "x", textModel: "y", clip: false, vocab });
    expect((await smartTagCounts(USER, plan)).pending).toBe(3);
    await evaluateSmartTags(Object.values(id), { plan, vectors: null, framing: null });
    expect(await smartTagCounts(USER, plan)).toEqual({ total: 3, pending: 0 });
    expect(await termsOf(id.gps)).not.toContain("season.summer");
    const state = await db.query(`SELECT DISTINCT version FROM capture_smart_tag_state WHERE capture_id = ANY($1)`, [
      Object.values(id),
    ]);
    expect(state.rows).toEqual([{ version: plan.version }]);
  });

  it("reads a vector only where one is stored", async () => {
    const { planSmartTags } = await import("@lifer/core/smartTags/suggest.js");
    const { evaluateSmartTags } = await import("./suggestionPass.js");
    const plan = planSmartTags({ imageModel: "x", textModel: "y", clip: true });
    const seen: number[] = [];
    await evaluateSmartTags([id.vector, id.bare], {
      plan,
      vectors: null,
      framing: (v) => {
        seen.push(v.length);
        return "close";
      },
    });
    expect(seen).toEqual([768]);
    expect(await termsOf(id.vector)).toEqual(["composition.close"]);
    expect(await termsOf(id.bare)).toEqual([]);
  });

  it("drops suggestions and state with the capture", async () => {
    await db.query(`DELETE FROM captures_all WHERE id = $1`, [id.gps]);
    const left = await db.query(
      `SELECT (SELECT count(*) FROM capture_smart_suggestions WHERE capture_id = $1)::int AS s,
              (SELECT count(*) FROM capture_smart_tag_state WHERE capture_id = $1)::int AS st`,
      [id.gps],
    );
    expect(left.rows[0]).toEqual({ s: 0, st: 0 });
  });
});
