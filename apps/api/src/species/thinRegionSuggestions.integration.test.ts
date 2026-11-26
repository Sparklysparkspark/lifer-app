// Runs only with TEST_DATABASE_URL pointing at a migrated test database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test npx vitest run thinRegionSuggestions
// A place whose checklist lacks a whole group (only the nearby sea, say) borrows that group from
// the region above, so a bird photo there can still be named; groups it lists stay its own.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "ffffffff-0000-4000-8000-000000000130";
const COUNTRY = "ffffffff-0000-4000-8000-0000000000e1";
const SEA_PLACE = "ffffffff-0000-4000-8000-0000000000e2";
const BIRD_PLACE = "ffffffff-0000-4000-8000-0000000000e3";
const BIRD = "ffffffff-0000-4000-8000-0000000000e4";
const OTHER_BIRD = "ffffffff-0000-4000-8000-0000000000e5";
const FISH = "ffffffff-0000-4000-8000-0000000000e6";
const ALL_SPECIES = [BIRD, OTHER_BIRD, FISH];
const ALL_REGIONS = [SEA_PLACE, BIRD_PLACE, COUNTRY];

// One-hot vectors: a photo "of" a species matches only that species.
const vec = (i: number) => Array.from({ length: 768 }, (_, k) => (k === i ? 1 : 0));

describe.skipIf(!url)("suggestions in a place whose checklist lacks a group", () => {
  let db: pg.Pool;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    db = new pg.Pool({ connectionString: url });
    const { EMBEDDING_MODEL_VERSION } = await import("@lifer/core/config.js");
    const species: [string, number, string, string, string][] = [
      [BIRD, 910901, "Testus avis", "Thin Test Motmot", "aves"],
      [OTHER_BIRD, 910902, "Testus alter", "Thin Test Toucan", "aves"],
      [FISH, 910903, "Testus piscis", "Thin Test Octopus", "cephalopoda"],
    ];
    for (const [id, key, sci, common, cls] of species) {
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class, reference_photo, reference_credit, reference_license)
         VALUES ($1, $2, $3, $4, $5, 'https://example.com/thin.jpg', 'Test', 'CC0') ON CONFLICT (id) DO NOTHING`,
        [id, key, sci, common, cls],
      );
    }
    for (const [i, id] of ALL_SPECIES.entries()) {
      await db.query(
        `INSERT INTO species_reference_embeddings (species_id, embedding, model_version) VALUES ($1, $2, $3)
         ON CONFLICT (species_id) DO UPDATE SET embedding = EXCLUDED.embedding, model_version = EXCLUDED.model_version`,
        [id, vec(i), EMBEDDING_MODEL_VERSION],
      );
    }
    await db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'thin@test', 'x') ON CONFLICT (id) DO NOTHING`,
      [USER],
    );
    await db.query(
      `INSERT INTO regions (id, name, parent_id, external_codes) VALUES ($1, 'Thintestland', NULL, '{ZZ-TT}')`,
      [COUNTRY],
    );
    await db.query(
      `INSERT INTO regions (id, name, parent_id, external_codes) VALUES ($1, 'Thin Sea Place', $3, '{ZZ-TT-S}'), ($2, 'Thin Bird Place', $3, '{ZZ-TT-B}')`,
      [SEA_PLACE, BIRD_PLACE, COUNTRY],
    );
    await db.query(
      `INSERT INTO region_species (region_id, species_id) VALUES ($1, $3), ($1, $4), ($1, $5), ($2, $5), ($6, $3), ($6, $5)`,
      [COUNTRY, SEA_PLACE, BIRD, OTHER_BIRD, FISH, BIRD_PLACE],
    );
  });

  afterAll(async () => {
    await db.query(`DELETE FROM region_species WHERE region_id = ANY($1)`, [ALL_REGIONS]);
    await db.query(`DELETE FROM regions WHERE id = ANY($1)`, [ALL_REGIONS]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species_reference_embeddings WHERE species_id = ANY($1)`, [ALL_SPECIES]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [ALL_SPECIES]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  async function rank(photo: number, region: string) {
    const { rankSpeciesByEmbeddings, CLIP_SPACE, invalidateSuggestionCache } =
      await import("@lifer/core/species/embeddings.js");
    invalidateSuggestionCache();
    const { pool } = await import("@lifer/core/db.js");
    return rankSpeciesByEmbeddings(pool, USER, [vec(photo)], region, 5, null, CLIP_SPACE);
  }

  it("names a bird in a place that lists only sea life, from the country's birds", async () => {
    const ids = (await rank(0, SEA_PLACE)).map((s) => s.id);
    expect(ids[0]).toBe(BIRD);
  });

  it("keeps a place's own bird list narrow: the country's other birds aren't added", async () => {
    const ids = (await rank(1, BIRD_PLACE)).map((s) => s.id);
    expect(ids).not.toContain(OTHER_BIRD);
  });
});
