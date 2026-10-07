// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55473/lifer npx vitest run tagsMetadata
// A photo's tags travel with its file as keywords: setting, renaming and deleting a tag in Lifer
// rewrites the keywords of the managed files, and never touches a linked file.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000761";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000762";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "tags-meta@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

describe.skipIf(!url)("photo tags in file metadata", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dir: string;
  let managedCapture: string;
  let managedFile: string;
  let linkedFile: string;

  async function cleanup() {
    await db.query(`DELETE FROM originals WHERE capture_id IN (SELECT id FROM captures_all WHERE user_id = $1)`, [
      USER,
    ]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
  }

  async function addCapture(file: string, managed: boolean, fingerprint: string): Promise<string> {
    await sharp({ create: { width: 16, height: 16, channels: 3, background: "#753" } })
      .jpeg()
      .toFile(file);
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint) VALUES ($1, $2, $3) RETURNING id`,
      [USER, SPECIES, fingerprint],
    );
    await db.query(
      `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size) VALUES ($1, 'jpeg', 'path', $2, $3, $4, 1)`,
      [c.rows[0].id, file, managed, fingerprint],
    );
    return c.rows[0].id;
  }

  async function keywordsOf(file: string): Promise<{ subject: unknown; hierarchical: unknown }> {
    const { readExifTags } = await import("../uploads/exif.js");
    const tags = (await readExifTags(file)) as unknown as Record<string, unknown>;
    return { subject: tags.Subject ?? [], hierarchical: tags.HierarchicalSubject ?? [] };
  }

  async function eventually(check: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < 60 && !(await check()); i++) await new Promise((r) => setTimeout(r, 50));
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    dir = mkdtempSync(path.join(tmpdir(), "lifer-tags-meta-"));
    process.env.DATA_DIR = dir;
    process.env.APP_DATA_DIR = path.join(dir, "app");
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'tags-meta@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 915761, 'Taggia metadata', 'Tagged Tern', 'aves')`,
      [SPECIES],
    );
    managedFile = path.join(dir, "managed.jpg");
    linkedFile = path.join(dir, "linked.jpg");
    managedCapture = await addCapture(managedFile, true, "tags-meta-1");
    await addCapture(linkedFile, false, "tags-meta-2");
    const { captureTagRoutes } = await import("./tags.js");
    app = Fastify();
    await app.register(captureTagRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.end();
    const { closeExiftool } = await import("../uploads/exif.js");
    await closeExiftool();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes, renames and removes tags in the managed file only", async () => {
    const linkedBytes = readFileSync(linkedFile);
    const set = await app.inject({
      method: "PATCH",
      url: `/api/captures/${managedCapture}/tags`,
      payload: { tags: ["flight shot", "courtship"] },
    });
    expect(set.statusCode).toBe(200);
    expect(await keywordsOf(managedFile)).toEqual({
      subject: ["Tagged Tern", "Taggia metadata", "flight shot", "courtship"],
      hierarchical: ["Species|Birds|Tagged Tern", "Lifer Tags|flight shot", "Lifer Tags|courtship"],
    });

    const renamed = await app.inject({
      method: "PATCH",
      url: "/api/captures/tags/rename",
      payload: { from: "flight shot", to: "in flight" },
    });
    expect(renamed.json()).toEqual({ ok: true, updated: 1 });
    await eventually(async () => JSON.stringify((await keywordsOf(managedFile)).subject).includes("in flight"));
    expect((await keywordsOf(managedFile)).subject).toEqual([
      "Tagged Tern",
      "Taggia metadata",
      "courtship",
      "in flight",
    ]);

    const deleted = await app.inject({ method: "DELETE", url: "/api/captures/tags", payload: { tag: "courtship" } });
    expect(deleted.json()).toEqual({ ok: true, updated: 1 });
    await eventually(async () => !JSON.stringify((await keywordsOf(managedFile)).subject).includes("courtship"));
    expect(await keywordsOf(managedFile)).toEqual({
      subject: ["Tagged Tern", "Taggia metadata", "in flight"],
      hierarchical: ["Species|Birds|Tagged Tern", "Lifer Tags|in flight"],
    });

    // Bulk tagging reaches linked photos' rows, never their files.
    await app.inject({
      method: "PATCH",
      url: "/api/captures/tags",
      payload: { captureIds: [managedCapture], tags: ["dawn"] },
    });
    expect(readFileSync(linkedFile).equals(linkedBytes)).toBe(true);
  }, 30_000);
});
