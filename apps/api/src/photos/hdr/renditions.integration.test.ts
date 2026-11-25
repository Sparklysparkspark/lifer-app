// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test npx vitest run hdr/renditions
// The background pass looks at each photo once, and the viewer's routes serve only what it made.
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hdrPng } from "./__fixtures__/images.js";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000003201";
const OTHER = "eeeeeeee-0000-4000-8000-000000003202";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000320a";
const TOKEN = "lifer_test_hdr_renditions_3201";
const OTHER_TOKEN = "lifer_test_hdr_renditions_3202";

describe.skipIf(!url)("HDR renditions", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lifer-hdr-int-"));
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;
  let renditions: typeof import("./renditions.js");
  const photos: Record<string, string> = {};

  async function addPhoto(key: string, original: { kind: string; file: string } | null, user = USER) {
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures (user_id, species_id, fingerprint, taken_at) VALUES ($1, $2, $3, now()) RETURNING id`,
      [user, SPECIES, `hdr-${key}`],
    );
    if (original) {
      await db.query(
        `INSERT INTO originals (user_id, capture_id, kind, ref_type, ref, managed, content_hash, file_size)
         VALUES ($1, $2, $3, 'path', $4, false, $5, 1000)`,
        [user, c.rows[0]!.id, original.kind, original.file, `hdr-hash-${key}`],
      );
    }
    const p = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path, width, height)
       VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp', 64, 16) RETURNING id`,
      [c.rows[0]!.id],
    );
    photos[key] = p.rows[0]!.id;
  }
  const state = async (key: string) =>
    (await db.query(`SELECT hdr_rendition FROM photos WHERE id = $1`, [photos[key]])).rows[0].hdr_rendition;
  const get = (route: string, token = TOKEN) =>
    app.inject({ method: "GET", url: route, cookies: { [cookieName]: token } });

  async function cleanup() {
    await db.query(`DELETE FROM captures_all WHERE user_id = ANY($1::uuid[])`, [[USER, OTHER]]);
    await db.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[USER, OTHER]]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    process.env.APP_DATA_DIR = path.join(dir, "app");
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { photoRoutes } = await import("../routes.js");
    renditions = await import("./renditions.js");

    await cleanup();
    await db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'hdr@test', 'x'), ($2, 'hdr2@test', 'x')`,
      [USER, OTHER],
    );
    await db.query(
      `INSERT INTO sessions (id, user_id, expires_at)
       VALUES ($1, $2, now() + interval '1 day'), ($3, $4, now() + interval '1 day')`,
      [hashToken(TOKEN), USER, hashToken(OTHER_TOKEN), OTHER],
    );
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 923201, 'Alces lucidus', 'Bright Moose', 'mammalia')`,
      [SPECIES],
    );

    const save = (name: string, bytes: Buffer) => {
      writeFileSync(path.join(dir, name), bytes);
      return path.join(dir, name);
    };
    await addPhoto("pq", { kind: "jpeg", file: save("pq.png", await hdrPng("pq")) });
    await addPhoto("sdr", {
      kind: "jpeg",
      file: save(
        "sdr.jpg",
        await sharp(await hdrPng("pq"))
          .jpeg()
          .toBuffer(),
      ),
    });
    await addPhoto("rawOnly", { kind: "raw", file: save("a.cr3", Buffer.from("raw")) });
    await addPhoto("away", { kind: "jpeg", file: path.join(dir, "unplugged", "x.png") });
    await addPhoto("theirs", { kind: "jpeg", file: save("theirs.png", await hdrPng("hlg")) }, OTHER);

    app = Fastify();
    await app.register(cookie);
    await app.register(photoRoutes, { prefix: "/api" });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("records each photo once; a file it can't reach is left for later", async () => {
    expect(renditions.startHdrRenditionPass()).toBe(true);
    await renditions.hdrRenditionJob.settled();
    expect(await state("pq")).toBe("ready");
    expect(await state("theirs")).toBe("ready");
    expect(await state("sdr")).toBe("none");
    expect(await state("rawOnly")).toBe("none");
    expect(await state("away")).toBeNull();

    // A second pass has nothing new to look at in this test's photos.
    renditions.startHdrRenditionPass();
    await renditions.hdrRenditionJob.settled();
    expect(await state("away")).toBeNull();
  });

  it("lists and serves only the user's own renditions", async () => {
    const list = await get("/api/photos/hdr-renditions");
    expect(list.json().photoIds).toContain(photos.pq);
    expect(list.json().photoIds).not.toContain(photos.theirs);
    expect(list.json().photoIds).not.toContain(photos.sdr);

    const served = await get(`/api/photos/${photos.pq}/hdr`);
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/jpeg");
    expect((await sharp(served.rawPayload).metadata()).gainMap).toBeTruthy();

    expect((await get(`/api/photos/${photos.sdr}/hdr`)).statusCode).toBe(404);
    expect((await get(`/api/photos/${photos.theirs}/hdr`)).statusCode).toBe(404);
    expect((await get(`/api/photos/${photos.theirs}/hdr`, OTHER_TOKEN)).statusCode).toBe(200);
  });

  it("makes the rendition again when the original changes, and drops it when it's no longer HDR", async () => {
    const file = path.join(dir, "pq.png");
    writeFileSync(
      file,
      await sharp(await hdrPng("pq"))
        .png()
        .toBuffer(),
    );
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    expect((await get(`/api/photos/${photos.pq}/hdr`)).statusCode).toBe(404);
    expect(await state("pq")).toBe("none");
  });
});
