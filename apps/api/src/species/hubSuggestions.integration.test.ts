// Runs only with TEST_DATABASE_URL pointing at a migrated database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run hubSuggestions
// Picking a continent or World for suggestions matches against the downloaded countries under
// it, since those regions have no checklist of their own.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "ffffffff-0000-4000-8000-000000000120";
const WORLD = "ffffffff-0000-4000-8000-0000000000d1";
const CONTINENT = "ffffffff-0000-4000-8000-0000000000d2";
const COUNTRY = "ffffffff-0000-4000-8000-0000000000d3";
const PACK = "zz-hub-test-pack";
const COUNTRY_NAME = "Hubtestland";
const SPECIES = "ffffffff-0000-4000-8000-0000000000d4";

describe.skipIf(!url)("suggestions for a continent or World", () => {
  let db: pg.Pool;
  const speciesId = SPECIES;
  const embedding = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    db = new pg.Pool({ connectionString: url });
    const { EMBEDDING_MODEL_VERSION } = await import("@lifer/core/config.js");
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class, reference_photo, reference_credit, reference_license)
       VALUES ($1, 910899, 'Testus hubensis', 'Hub Test Heron', 'aves', 'https://example.com/hub.jpg', 'Test', 'CC0') ON CONFLICT (id) DO NOTHING`,
      [SPECIES],
    );
    await db.query(
      `INSERT INTO species_reference_embeddings (species_id, embedding, model_version) VALUES ($1, $2, $3)
       ON CONFLICT (species_id) DO UPDATE SET embedding = EXCLUDED.embedding, model_version = EXCLUDED.model_version`,
      [SPECIES, embedding, EMBEDDING_MODEL_VERSION],
    );
    await db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'hubs@test', 'x') ON CONFLICT (id) DO NOTHING`,
      [USER],
    );
    await db.query(
      `INSERT INTO regions (id, name, parent_id) VALUES ($1, 'Hubtest World', NULL), ($2, 'Hubtest Continent', $1)`,
      [WORLD, CONTINENT],
    );
    await db.query(`INSERT INTO regions (id, name, parent_id, external_codes) VALUES ($1, $2, $3, '{ZZ-HT}')`, [
      COUNTRY,
      COUNTRY_NAME,
      CONTINENT,
    ]);
    await db.query(`INSERT INTO region_species (region_id, species_id) VALUES ($1, $2)`, [COUNTRY, speciesId]);
    await db.query(`INSERT INTO downloaded_packs (pack_id, region) VALUES ($1, $2)`, [PACK, COUNTRY_NAME]);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM downloaded_packs WHERE pack_id = $1`, [PACK]);
    await db.query(`DELETE FROM region_species WHERE region_id = $1`, [COUNTRY]);
    await db.query(`DELETE FROM regions WHERE id = ANY($1)`, [[COUNTRY, CONTINENT, WORLD]]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("matches the downloaded countries' species from the country, its continent and World", async () => {
    const { rankSpeciesByEmbeddings, CLIP_SPACE, invalidateSuggestionCache } =
      await import("@lifer/core/species/embeddings.js");
    invalidateSuggestionCache();
    const { pool } = await import("@lifer/core/db.js");
    for (const region of [COUNTRY, CONTINENT, WORLD]) {
      const suggestions = await rankSpeciesByEmbeddings(pool, USER, [embedding], region, 5, null, CLIP_SPACE);
      expect(suggestions[0]?.id, `top suggestion with region ${region}`).toBe(speciesId);
    }
  });
});
