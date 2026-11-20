// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// A region set later re-weighs suggestions Lifer filed; a confirmed photo is never changed.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const OWNER = "eeeeeeee-0000-4000-8000-000000000a01";
const SP_OLD = "eeeeeeee-0000-4000-8000-000000000a0a";
const SP_NEW = "eeeeeeee-0000-4000-8000-000000000a0b";

vi.mock("@lifer/core/species/embeddings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lifer/core/species/embeddings.js")>()),
  suggestionVectorKind: async () => ({
    kind: "clip-crop",
    space: { captureTable: "capture_embeddings", modelVersion: "recheck-test" },
  }),
}));
vi.mock("./identification.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./identification.js")>()),
  proposeIdentification: async () => ({ speciesId: "eeeeeeee-0000-4000-8000-000000000a0b", matchPercent: 91 }),
}));

describe.skipIf(!url)("recheck suggestions", () => {
  let db: pg.Pool;
  const ids: Record<string, string> = {};

  async function cleanup() {
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [OWNER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [OWNER]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SP_OLD, SP_NEW]]);
  }
  async function capture(key: string, state: "suggested" | "confirmed", withVector = true) {
    const res = await db.query<{ id: string }>(
      `INSERT INTO captures (user_id, species_id, fingerprint, identification_state, suggestion_percent)
       VALUES ($1, $2, $3, $4, 60) RETURNING id`,
      [OWNER, SP_OLD, `recheck-${key}`, state],
    );
    ids[key] = res.rows[0].id;
    if (withVector)
      await db.query(
        `INSERT INTO capture_embeddings (capture_id, embedding, model_version) VALUES ($1, $2, 'recheck-test')`,
        [ids[key], [0.1, 0.2]],
      );
  }
  const speciesOf = async (key: string) =>
    (await db.query(`SELECT species_id FROM captures_all WHERE id = $1`, [ids[key]])).rows[0].species_id;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'recheck@test', 'x')`, [OWNER]);
    for (const [id, n, g] of [
      [SP_OLD, "Zzrecheck oldus", 980501],
      [SP_NEW, "Zzrecheck newus", 980502],
    ] as const)
      await db.query(
        `INSERT INTO species (id, scientific_name, common_name, taxon_class, gbif_key) VALUES ($1, $2, $2, 'aves', $3)`,
        [id, n, g],
      );
    await capture("suggested", "suggested");
    await capture("confirmed", "confirmed");
    await capture("novector", "suggested", false);
  });
  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  it("refiles a waiting suggestion, and leaves confirmed photos and photos without a vector alone", async () => {
    const { recheckSuggestions } = await import("./recheck.js");
    const changed = await recheckSuggestions(OWNER, Object.values(ids));
    expect(changed).toBe(1);
    expect(await speciesOf("suggested")).toBe(SP_NEW);
    expect(await speciesOf("confirmed")).toBe(SP_OLD);
    expect(await speciesOf("novector")).toBe(SP_OLD);
  });
});
