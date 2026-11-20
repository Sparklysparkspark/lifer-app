// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// What /uploads/inspect tells the import screen about where a photo was taken and where its
// animal sits: the camera's GPS point with its region, and the subject box in percent.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import pg from "pg";
import sharp from "sharp";
import { ExifTool } from "exiftool-vendored";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { subjectPercent } from "./inspect.js";

describe("subjectPercent", () => {
  it("turns a centred detector box into a centred percent box", () => {
    expect(subjectPercent([0.25, 0.3, 0.75, 0.7])).toEqual({ x: 25, y: 30, w: 50, h: 40 });
  });

  it("clamps a box running off the photo and drops an empty one", () => {
    expect(subjectPercent([-0.1, 0.5, 1.2, 1])).toEqual({ x: 0, y: 50, w: 100, h: 50 });
    expect(subjectPercent([0.4, 0.4, 0.4, 0.6])).toBeNull();
    expect(subjectPercent(null)).toBeNull();
  });
});

const url = process.env.TEST_DATABASE_URL;
const USER = "dddddddd-0000-4000-8000-000000000a14";
const REGION = "dddddddd-0000-4000-8000-000000000a15";
const TOKEN = "lifer_test_inspect_framing_token_a14";
// A made-up region in the open South Pacific, so no real outline overlaps it.
const square = (w: number, s: number, e: number, n: number) =>
  JSON.stringify({
    type: "Polygon",
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  });

describe.skipIf(!url)("inspect framing and GPS", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  const writer = new ExifTool();

  async function jpeg(shade: number, gps?: { lat: number; lon: number }): Promise<Buffer> {
    const file = path.join(dataDir, `src-${shade}.jpg`);
    writeFileSync(
      file,
      await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: shade, g: 90, b: 40 } } })
        .jpeg()
        .toBuffer(),
    );
    if (gps)
      await writer.write(
        file,
        {
          "EXIF:DateTimeOriginal": "2018:06:01 07:00:00",
          "EXIF:GPSLatitude": Math.abs(gps.lat),
          "EXIF:GPSLatitudeRef": gps.lat < 0 ? "S" : "N",
          "EXIF:GPSLongitude": Math.abs(gps.lon),
          "EXIF:GPSLongitudeRef": gps.lon < 0 ? "W" : "E",
        } as never,
        { writeArgs: ["-overwrite_original"] },
      );
    return readFileSync(file);
  }

  async function inspect(name: string, bytes: Buffer) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), name);
    const res = new Response(form);
    return app.inject({
      method: "POST",
      url: "/api/uploads/inspect",
      headers: { "x-api-key": TOKEN, "content-type": res.headers.get("content-type")! },
      payload: Buffer.from(await res.arrayBuffer()),
    });
  }

  async function cleanup() {
    await db.query(`DELETE FROM api_keys WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM regions WHERE id = $1`, [REGION]);
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-inspect-framing-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashApiKey } = await import("../auth/apiKeys.js");
    const { uploadRoutes } = await import("./routes.js");
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'inspect-framing@test', 'x')`, [USER]);
    await db.query(`INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, 'test', $2, $3)`, [
      USER,
      hashApiKey(TOKEN),
      ["photos.write"],
    ]);
    await db.query(`INSERT INTO regions (id, name, boundary_geojson) VALUES ($1, 'Framingland', $2)`, [
      REGION,
      square(-140, -50, -130, -40),
    ]);
    app = Fastify();
    await app.register(cookie);
    await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
    await app.register(uploadRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await writer.end();
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

  it("returns the camera's point and the region holding it", async () => {
    const res = await inspect("IMG_GPS.jpg", await jpeg(10, { lat: -45.5, lon: -135.25 }));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().gps).toEqual({ lat: -45.5, lon: -135.25, regionId: REGION, town: null });
    // The camera's own clock, whatever zone the point puts the instant in.
    expect(res.json().cameraTime).toBe("2018-06-01T07:00:00");
    // No region sent, so no matching ran and there's no subject box.
    expect(res.json().subject).toBeNull();
  }, 60_000);

  it("returns no point for a photo without GPS", async () => {
    const res = await inspect("IMG_NOGPS.jpg", await jpeg(60));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().gps).toBeNull();
    expect(res.json().subject).toBeNull();
    expect(res.json().cameraTime).toBeNull();
  }, 60_000);
});
