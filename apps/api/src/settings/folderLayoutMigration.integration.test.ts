// Runs only with TEST_DATABASE_URL pointing at a disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test npx vitest run folderLayoutMigration
// Migration 155 keeps each account's folders: it runs here on a scratch copy of the old columns.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const migration = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/data-pipeline/migrations/155_folder_layout.sql",
);

describe.skipIf(!url)("migration 155: folder layout", () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS mig155 CASCADE; CREATE SCHEMA mig155; SET search_path = mig155`);
    await client.query(
      `CREATE TABLE users (id int PRIMARY KEY, organize_originals_by_year boolean NOT NULL DEFAULT false,
                           organize_originals_by_location boolean NOT NULL DEFAULT false)`,
    );
    await client.query(
      `INSERT INTO users VALUES (1, false, false), (2, true, false), (3, false, true), (4, true, true)`,
    );
    await client.query(readFileSync(migration, "utf8"));
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS mig155 CASCADE`);
    await client?.end();
  });

  it("maps the two switches to the matching layout and drops them", async () => {
    const rows = (await client.query<{ id: number; folder_layout: string[] }>(`SELECT * FROM users ORDER BY id`)).rows;
    expect(rows).toEqual([
      { id: 1, folder_layout: ["group", "species"] },
      { id: 2, folder_layout: ["wildlifeYear", "group", "species"] },
      { id: 3, folder_layout: ["country", "province", "place", "group", "species"] },
      { id: 4, folder_layout: ["country", "province", "place", "wildlifeYear", "group", "species"] },
    ]);
    // New accounts start on the Species layout.
    await client.query(`INSERT INTO users (id) VALUES (5)`);
    expect((await client.query(`SELECT folder_layout FROM users WHERE id = 5`)).rows[0].folder_layout).toEqual([
      "group",
      "species",
    ]);
  });
});
