// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55470/lifer npx vitest run speciesFolderName
// The folder-name lookup against real rows: the user's naming styles, the species' codes and
// taxonomy, and which other species count as a common-name collision.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});

const url = process.env.TEST_DATABASE_URL;
const USER_PLAIN = "eeeeeeee-0000-4000-8000-000000000401";
const USER_TREE = "eeeeeeee-0000-4000-8000-000000000402";
const OSPREY = "eeeeeeee-0000-4000-8000-00000000041a";
const KITE = "eeeeeeee-0000-4000-8000-00000000041b";
const KITE_TWIN = "eeeeeeee-0000-4000-8000-00000000041c";
const MOA = "eeeeeeee-0000-4000-8000-00000000041d";
const MOA_FOSSIL = "eeeeeeee-0000-4000-8000-00000000041e";
const ALL = [OSPREY, KITE, KITE_TWIN, MOA, MOA_FOSSIL];

describe.skipIf(!url)("resolveSpeciesFolderName", () => {
  let db: pg.Pool;
  let resolve: (userId: string, speciesId: string) => Promise<string>;

  async function cleanup() {
    await db.query(`DELETE FROM species_traits WHERE species_id = ANY($1)`, [ALL]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [ALL]);
    await db.query(`DELETE FROM users WHERE id = ANY($1)`, [[USER_PLAIN, USER_TREE]]);
  }

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(
      `INSERT INTO users (id, email, password_hash, species_naming_styles) VALUES
         ($1, 'folder-plain@test', 'x', '{}'), ($2, 'folder-tree@test', 'x', '{common,aba_code,tree}')`,
      [USER_PLAIN, USER_TREE],
    );
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class, taxon_order, family, aba_code) VALUES
         ($1, 920401, 'Pandion testus', 'Folder Test Osprey', 'aves', 'Accipitriformes', 'Pandionidae', 'OSPR'),
         ($2, 920402, 'Elanus testus', 'Folder Test Kite', 'aves', NULL, NULL, NULL),
         ($3, 920403, 'Elanus gemellus', 'Folder Test Kite', 'aves', NULL, NULL, NULL),
         ($4, 920404, 'Dinornis testus', 'Folder Test Moa', 'aves', NULL, NULL, NULL),
         ($5, 920405, 'Dinornis fossilis', 'Folder Test Moa', 'aves', NULL, NULL, NULL)`,
      ALL,
    );
    await db.query(
      `INSERT INTO species_traits (species_id, fully_extinct, source_attribution) VALUES ($1, true, 'test')`,
      [MOA_FOSSIL],
    );
    ({ resolveSpeciesFolderName: resolve } = await import("./speciesFolderName.js"));
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("uses the plain common name when no other species shares it", async () => {
    expect(await resolve(USER_PLAIN, OSPREY)).toBe("Folder Test Osprey");
  });

  it("adds the scientific name when another species has the same common name", async () => {
    expect(await resolve(USER_PLAIN, KITE)).toBe("Folder Test Kite (Elanus testus)");
    expect(await resolve(USER_PLAIN, KITE_TWIN)).toBe("Folder Test Kite (Elanus gemellus)");
  });

  it("doesn't count an extinct species as a collision", async () => {
    expect(await resolve(USER_PLAIN, MOA)).toBe("Folder Test Moa");
  });

  it("follows the user's naming styles, with the species' code and taxonomy", async () => {
    expect(await resolve(USER_TREE, OSPREY)).toBe(
      "Folder Test Osprey (OSPR, Aves  Accipitriformes  Pandionidae  Pandion testus)",
    );
  });

  it("says which species it couldn't find", async () => {
    await expect(resolve(USER_PLAIN, "eeeeeeee-0000-4000-8000-0000000004ff")).rejects.toThrow(
      "resolveSpeciesFolderName: no species found for id eeeeeeee-0000-4000-8000-0000000004ff",
    );
  });
});
