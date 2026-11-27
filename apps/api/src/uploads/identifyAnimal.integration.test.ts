// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// POST /uploads/identify-animal with a fake inference: the chosen box is cropped and ranked, the
// burst follows it, and the refusals say why.
import { rmSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Set before anything loads core's config, which reads them once (and the repo .env otherwise).
const scratchDir = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs");
  const os = process.getBuiltinModule("node:os");
  const dir = fs.mkdtempSync(`${os.tmpdir()}/lifer-identify-animal-`);
  process.env.DATA_DIR = dir;
  process.env.APP_DATA_DIR = `${dir}/app-data`;
  process.env.SINGLE_USER_MODE = "0";
  return dir;
});
const fake = vi.hoisted(() => ({
  ready: true,
  views: [] as Array<{ key: string; width: number; height: number }>,
  ranked: [] as number[],
}));
vi.mock("@lifer/core/species/embeddings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lifer/core/species/embeddings.js")>()),
  suggestionVectorKind: async () =>
    fake.ready
      ? { kind: "id-crop", space: { captureTable: "capture_id_embeddings", modelVersion: "identify-test" } }
      : null,
  photoVector: async (_kind: string, image: Buffer, opts: { key: string }) => {
    const { width = 0, height = 0 } = await sharp(image).metadata();
    fake.views.push({ key: opts.key, width, height });
    return new Float32Array([1, 0]);
  },
  rankSpeciesByEmbeddings: async (_pool: unknown, _user: string, vectors: unknown[]) => {
    fake.ranked.push(vectors.length);
    return [
      {
        id: "dddddddd-0000-4000-8000-000000000b19",
        scientific_name: "Chosenus animalis",
        common_name: "Chosen Animal",
        score: 0.8,
        source: "reference_photo",
      },
    ];
  },
}));

describe("squareAround", () => {
  it("pads the box into a square, kept inside the photo", async () => {
    const { squareAround } = await import("./identifyAnimal.js");
    expect(squareAround({ x: 50, y: 25, w: 25, h: 50 }, 1, 400, 200)).toEqual({
      left: 188,
      top: 38,
      width: 125,
      height: 125,
    });
    // A looser view can't be bigger than the photo's short side.
    expect(squareAround({ x: 50, y: 25, w: 25, h: 50 }, 1.6, 400, 200).width).toBe(200);
  });
});

const url = process.env.TEST_DATABASE_URL;
const USER = "dddddddd-0000-4000-8000-000000000b17";
const OTHER = "dddddddd-0000-4000-8000-000000000b18";
const REGION = "dddddddd-0000-4000-8000-000000000b20";
const KEY = "lifer_test_identify_animal_token_b17";
const OTHER_KEY = "lifer_test_identify_animal_token_b18";
const API = { "x-api-key": KEY };

describe.skipIf(!url)("POST /uploads/identify-animal", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;

  const photo = (shade: number) =>
    sharp({ create: { width: 400, height: 200, channels: 3, background: { r: shade, g: 90, b: 40 } } })
      .jpeg()
      .toBuffer();
  // Imported once the environment is set, as config reads it on load.
  const upload = async (shade: number, headers = API) =>
    (
      await (
        await import("@lifer/core/uploads/testImages.js")
      ).tusUpload(app, await photo(shade), { headers, filename: `IMG_${shade}.jpg`, filetype: "image/jpeg" })
    ).id;
  const identify = (body: object, headers = API) =>
    app.inject({ method: "POST", url: "/api/uploads/identify-animal", headers, payload: body });
  const box = { x: 50, y: 25, w: 25, h: 50 };

  async function cleanup() {
    await db.query(`DELETE FROM api_keys WHERE user_id = ANY($1)`, [[USER, OTHER]]);
    await db.query(`DELETE FROM users WHERE id = ANY($1)`, [[USER, OTHER]]);
  }

  beforeAll(async () => {
    dataDir = scratchDir;
    process.env.DATABASE_URL = url;
    db = new pg.Pool({ connectionString: url });
    const { hashApiKey } = await import("../auth/apiKeys.js");
    const { uploadRoutes } = await import("./routes.js");
    await cleanup();
    await db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'identify@test', 'x'), ($2, 'identify-other@test', 'x')`,
      [USER, OTHER],
    );
    await db.query(
      `INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, 't', $2, $3), ($4, 't', $5, $3)`,
      [USER, hashApiKey(KEY), ["photos.write"], OTHER, hashApiKey(OTHER_KEY)],
    );
    app = Fastify();
    await app.register(cookie);
    await app.register(multipart);
    await app.register(uploadRoutes, { prefix: "/api" });
    await app.ready();
  });

  beforeEach(async () => {
    fake.ready = true;
    fake.views = [];
    fake.ranked = [];
    const { clearBursts } = await import("../species/bursts.js");
    clearBursts();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await cleanup();
      await db.end();
    }
    const { closeExiftool } = await import("./exif.js");
    await closeExiftool();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("ranks species on the chosen box, cropped tight and looser, cached by box", async () => {
    const id = await upload(10);
    const res = await identify({ uploadId: id, regionId: REGION, box });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().suggestions[0].common_name).toBe("Chosen Animal");
    expect(res.json().burst).toBeNull();
    // The two crops are embedded at the same time, so either can finish first.
    expect(fake.views.map((v) => [v.width, v.height]).sort((x, y) => x[0] - y[0])).toEqual([
      [125, 125],
      [200, 200],
    ]);
    expect(fake.views.map((v) => v.key)).toContainEqual(
      expect.stringMatching(/:animal:1:50\.00,25\.00,25\.00,50\.00$/),
    );
    expect(fake.ranked).toEqual([2]);
  });

  it("follows the chosen box across the other frames of the burst", async () => {
    const [a, b] = [await upload(20), await upload(21)];
    const { joinBurst } = await import("../species/bursts.js");
    const clip = new Float32Array([1, 0]);
    for (const [uploadId, takenAt] of [
      [a, 0],
      [b, 1000],
    ] as const)
      joinBurst(USER, { uploadId, takenAt, clip, vectors: [clip], context: "r:m" });
    const res = await identify({ uploadId: a, regionId: REGION, box });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().burst).toEqual({ uploadIds: [b] });
    // Both frames, two views each, ranked together.
    expect(fake.ranked).toEqual([4]);
  });

  it("says the models aren't ready, and refuses a gone, foreign or off-photo upload", async () => {
    const id = await upload(30);
    fake.ready = false;
    const notReady = await identify({ uploadId: id, regionId: REGION, box });
    expect(notReady.statusCode).toBe(409);
    expect(notReady.json().code).toBe("models_not_ready");
    fake.ready = true;
    expect((await identify({ uploadId: "missing", regionId: REGION, box })).statusCode).toBe(410);
    expect((await identify({ uploadId: id, regionId: REGION, box }, { "x-api-key": OTHER_KEY })).statusCode).toBe(410);
    expect((await identify({ uploadId: id, regionId: REGION, box: { x: 90, y: 0, w: 20, h: 10 } })).statusCode).toBe(
      400,
    );
    expect(fake.views).toEqual([]);
  });
});
