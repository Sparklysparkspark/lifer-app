// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run space
// A nearly full drive during an import: the space check answers in tiers, new work stops below
// the floor (507 disk_full) with what was imported kept, and resumes once there is room. A drive
// that fills while previews are written answers the same way, leaving nothing half-made.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import pg from "pg";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "dddddddd-0000-4000-8000-000000000507";
const SPECIES = "dddddddd-0000-4000-8000-00000000050a";
const TOKEN = "lifer_test_space_token_507";
const GB = 1e9;

const fake = vi.hoisted(() => ({ fullWhileWritingPreviews: false }));
vi.mock("@lifer/core/uploads/image.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("@lifer/core/uploads/image.js")>();
  return {
    ...real,
    generateDerivatives: async (...args: Parameters<typeof real.generateDerivatives>) => {
      if (fake.fullWhileWritingPreviews)
        throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
      return real.generateDerivatives(...args);
    },
  };
});

async function form(fields: Record<string, string>, name: string, shade: number) {
  const bytes = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: shade, g: 90, b: 40 } } })
    .jpeg()
    .toBuffer();
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  f.append("file", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), name);
  const res = new Response(f);
  return { payload: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type")! };
}

describe.skipIf(!url)("imports on a nearly full drive", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let space: typeof import("../lib/importSpace.js");

  /** Every drive Lifer writes to with this much free, out of 1 TB. */
  const drive = (free: number) => space.setVolumeProbe(async () => ({ free, total: 1e12, dev: 1 }));
  const post = async (route: string, fields: Record<string, string>, name: string, shade: number) => {
    const { payload, contentType } = await form(fields, name, shade);
    return app.inject({
      method: "POST",
      url: `/api${route}`,
      headers: { "x-api-key": TOKEN, "content-type": contentType },
      payload,
    });
  };
  const captures = async () =>
    (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM captures WHERE user_id = $1`, [USER])).rows[0].n;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-space-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashApiKey } = await import("../auth/apiKeys.js");
    const { uploadRoutes } = await import("./routes.js");
    space = await import("../lib/importSpace.js");
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'space@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 950701, 'Spatium plenum', 'Full Disk Wren', 'aves') ON CONFLICT (id) DO NOTHING`,
      [SPECIES],
    );
    await db.query(`INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, 'test', $2, $3)`, [
      USER,
      hashApiKey(TOKEN),
      ["photos.write"],
    ]);
    app = Fastify();
    // The app's own answer for a full drive (index.ts).
    app.setErrorHandler((err, _request, reply) => {
      const full = space.diskFullBody(err);
      return full ? reply.code(507).send(full) : reply.code(500).send({ error: String(err) });
    });
    await app.register(cookie);
    await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
    await app.register(uploadRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterEach(() => {
    space.setVolumeProbe(null);
    fake.fullWhileWritingPreviews = false;
  });

  afterAll(async () => {
    await app?.close();
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM api_keys WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.end();
    const { closeExiftool } = await import("./exif.js");
    await closeExiftool();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("the space check answers ok, tight or critical, with how much to free", async () => {
    const check = () =>
      app.inject({
        method: "POST",
        url: "/api/uploads/space",
        headers: { "x-api-key": TOKEN },
        payload: { files: 50, bytes: 2 * GB },
      });
    drive(400 * GB);
    expect((await check()).json()).toMatchObject({ tier: "ok", free: 400 * GB, toFree: 0 });
    drive(20 * GB);
    expect((await check()).json()).toMatchObject({ tier: "tight", toFree: 0 });
    drive(2.1 * GB);
    const critical = (await check()).json();
    expect(critical.tier).toBe("critical");
    expect(critical.toFree).toBeGreaterThan(2 * GB + 0.9 * GB);
  });

  it("pauses an import below the floor, keeping what was imported, and resumes with room", async () => {
    drive(400 * GB);
    expect((await post("/uploads", { speciesId: SPECIES }, "A.jpg", 20)).statusCode).toBe(201);

    drive(2.1 * GB);
    const paused = await post("/uploads", { speciesId: SPECIES }, "B.jpg", 40);
    expect(paused.statusCode).toBe(507);
    expect(paused.json()).toMatchObject({ code: "disk_full", free: 2.1 * GB });
    expect(await captures()).toBe(1);
    // A new upload or check is refused the same way.
    const tus = await app.inject({
      method: "POST",
      url: "/api/uploads/tus",
      headers: { "x-api-key": TOKEN, "tus-resumable": "1.0.0", "upload-length": "1000" },
    });
    expect(tus.statusCode).toBe(507);
    expect((await post("/uploads/inspect", {}, "C.jpg", 50)).statusCode).toBe(507);

    // Continue: room again, the rest goes in.
    drive(400 * GB);
    expect((await post("/uploads", { speciesId: SPECIES }, "B.jpg", 40)).statusCode).toBe(201);
    expect(await captures()).toBe(2);
  }, 30_000);

  it("a tight drive keeps no copy of a checked photo; a roomy one does", async () => {
    drive(20 * GB);
    await app.inject({
      method: "POST",
      url: "/api/uploads/space",
      headers: { "x-api-key": TOKEN },
      payload: { files: 2000, bytes: 60 * GB },
    });
    const tight = await post("/uploads/inspect", {}, "T.jpg", 70);
    expect(tight.statusCode, tight.body).toBe(200);
    expect(tight.json().stagedId).toBeNull();

    drive(400 * GB);
    const roomy = await post("/uploads/inspect", {}, "R.jpg", 90);
    expect(roomy.json().stagedId).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it("a drive that fills while previews are written answers disk_full and leaves nothing behind", async () => {
    drive(400 * GB);
    const before = await captures();
    fake.fullWhileWritingPreviews = true;
    const res = await post("/uploads", { speciesId: SPECIES }, "D.jpg", 110);
    expect(res.statusCode).toBe(507);
    expect(res.json().code).toBe("disk_full");
    expect(await captures()).toBe(before);
    const adjusted = path.join(dataDir, "Birds", "Full Disk Wren", "Adjusted");
    expect(readdirSync(adjusted).some((f) => f.startsWith("D"))).toBe(false);
  }, 30_000);
});
