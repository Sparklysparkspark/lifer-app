// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55470/lifer npx vitest run storageMove
// The relink after a library move, against real rows: every stored path under the old folder is
// rewritten, and nothing else (a sibling folder with the same prefix, linked or S3 originals).
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});
// Never touch the real local settings file.
const settings = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("@lifer/core/localSettings.js", () => ({
  readLocalSettings: () => settings.current,
  writeLocalSettings: () => {},
}));

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000301";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000030a";

describe.skipIf(!url)("storage move relink", () => {
  let db: pg.Pool;
  // Never created on disk: the recovery below only rewrites rows for these paths.
  const oldDir = path.join(os.tmpdir(), `lifer-relink-${process.pid}`, "Library");
  const newDir = path.join(os.tmpdir(), `lifer-relink-${process.pid}`, "Moved Library");
  const sibling = `${oldDir} 2`;
  let photoInside: string;
  let photoSibling: string;
  let refPhoto: string;

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM species_reference_photos WHERE species_id = $1`, [SPECIES]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'relink@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class, reference_display_path, reference_thumb_path)
       VALUES ($1, 920301, 'Testus relinkus', 'Relink Bird', 'aves', $2, $3)`,
      [SPECIES, `${oldDir}/ref/display.webp`, `${sibling}/ref/thumb.webp`],
    );
    refPhoto = (
      await db.query<{ id: string }>(
        `INSERT INTO species_reference_photos (species_id, photo_url, credit, license, display_path, thumb_path)
         VALUES ($1, 'https://example.org/p.jpg', 'someone', 'cc-by', $2, NULL) RETURNING id`,
        [SPECIES, `${oldDir}/reference/a.webp`],
      )
    ).rows[0].id;
    const capture = async (n: number) =>
      (
        await db.query<{ id: string }>(
          `INSERT INTO captures (user_id, species_id, fingerprint) VALUES ($1, $2, $3) RETURNING id`,
          [USER, SPECIES, `relink-${n}`],
        )
      ).rows[0].id;
    const c1 = await capture(1);
    const c2 = await capture(2);
    photoInside = (
      await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, $2, $3) RETURNING id`,
        [c1, `${oldDir}/display/1.webp`, `${oldDir}/thumb/1.webp`],
      )
    ).rows[0].id;
    photoSibling = (
      await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, $2, $3) RETURNING id`,
        [c2, `${sibling}/display/2.webp`, "/elsewhere/thumb/2.webp"],
      )
    ).rows[0].id;
    await db.query(
      `INSERT INTO originals (capture_id, user_id, kind, ref_type, ref, managed, content_hash, file_size) VALUES
         ($1, $3, 'jpeg', 'path', $4, true, 'h1', 1),
         ($1, $3, 'raw', 'path', $5, false, 'h2', 1),
         ($2, $3, 'jpeg', 's3', $6, true, 'h3', 1),
         ($2, $3, 'raw', 'path', $7, true, 'h4', 1)`,
      [
        c1,
        c2,
        USER,
        `${oldDir}/Birds/Osprey/a.jpg`,
        `${oldDir}/linked/b.cr3`,
        `${oldDir}/s3-key.jpg`,
        `${sibling}/Birds/c.cr3`,
      ],
    );

    settings.current = { migration: { from: oldDir, to: newDir, copied: true } };
    const { recoverInterruptedStorageMigration } = await import("./storageMove.js");
    await recoverInterruptedStorageMigration();
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM species_reference_photos WHERE species_id = $1`, [SPECIES]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("rewrites a photo's display and thumbnail paths under the old folder", async () => {
    const { rows } = await db.query(`SELECT display_path, thumb_path FROM photos WHERE id = $1`, [photoInside]);
    expect(rows[0]).toEqual({ display_path: `${newDir}/display/1.webp`, thumb_path: `${newDir}/thumb/1.webp` });
  });

  it("leaves a sibling folder that only shares the old folder's name as a prefix", async () => {
    const { rows } = await db.query(`SELECT display_path, thumb_path FROM photos WHERE id = $1`, [photoSibling]);
    expect(rows[0]).toEqual({ display_path: `${sibling}/display/2.webp`, thumb_path: "/elsewhere/thumb/2.webp" });
  });

  it("rewrites species and reference photo paths", async () => {
    const species = await db.query(`SELECT reference_display_path, reference_thumb_path FROM species WHERE id = $1`, [
      SPECIES,
    ]);
    expect(species.rows[0]).toEqual({
      reference_display_path: `${newDir}/ref/display.webp`,
      reference_thumb_path: `${sibling}/ref/thumb.webp`,
    });
    const ref = await db.query(`SELECT display_path, thumb_path FROM species_reference_photos WHERE id = $1`, [
      refPhoto,
    ]);
    expect(ref.rows[0]).toEqual({ display_path: `${newDir}/reference/a.webp`, thumb_path: null });
  });

  it("rewrites only managed path originals, never linked files or S3 keys", async () => {
    const { rows } = await db.query<{ kind: string; ref: string }>(
      `SELECT o.kind, o.ref FROM originals o JOIN captures_all c ON c.id = o.capture_id WHERE c.user_id = $1 ORDER BY o.content_hash`,
      [USER],
    );
    expect(rows.map((r) => r.ref)).toEqual([
      `${newDir}/Birds/Osprey/a.jpg`,
      `${oldDir}/linked/b.cr3`,
      `${oldDir}/s3-key.jpg`,
      `${sibling}/Birds/c.cr3`,
    ]);
  });
});
