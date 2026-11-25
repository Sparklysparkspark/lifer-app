// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Coordinates typed in Lifer: saved on the photo, written into the JPEG and the RAW's sidecar
// (replacing the camera's GPS), cleared again, and a region suggested from the point.
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000881";
const OTHER_USER = "eeeeeeee-0000-4000-8000-000000000882";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000883";
const COUNTRY = "eeeeeeee-0000-4000-8000-000000000884";
const PROVINCE = "eeeeeeee-0000-4000-8000-000000000885";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "coords@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

const square = (minLon: number, minLat: number, maxLon: number, maxLat: number) => ({
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [minLon, minLat],
        [maxLon, minLat],
        [maxLon, maxLat],
        [minLon, maxLat],
        [minLon, minLat],
      ],
    ],
  },
});

describe.skipIf(!url)("photo coordinates", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dir: string;
  let n = 0;

  async function cleanup() {
    await db.query(`DELETE FROM originals WHERE capture_id IN (SELECT id FROM captures_all WHERE user_id = ANY($1))`, [
      [USER, OTHER_USER],
    ]);
    await db.query(`DELETE FROM captures_all WHERE user_id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`DELETE FROM users WHERE id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`DELETE FROM regions WHERE id = ANY($1)`, [[PROVINCE, COUNTRY]]);
  }

  async function writeJpeg(file: string, gps?: { lat: number; lon: number }) {
    await sharp({ create: { width: 16, height: 16, channels: 3, background: "#357" } })
      .jpeg()
      .toFile(file);
    if (gps) {
      const { ExifTool } = await import("exiftool-vendored");
      const et = new ExifTool();
      await et.write(
        file,
        {
          GPSLatitude: Math.abs(gps.lat),
          GPSLatitudeRef: gps.lat < 0 ? "S" : "N",
          GPSLongitude: Math.abs(gps.lon),
          GPSLongitudeRef: gps.lon < 0 ? "W" : "E",
        },
        { writeArgs: ["-overwrite_original"] },
      );
      await et.end();
    }
  }

  async function addCapture(userId: string, files: Array<{ file: string; kind: "jpeg" | "raw" }> = []) {
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, lat, lon, location_source, location_accuracy_m)
       VALUES ($1, $2, $3, 1, 2, 'inaturalist', 50) RETURNING id`,
      [userId, SPECIES, `coords-${++n}`],
    );
    for (const f of files) {
      await db.query(
        `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size)
         VALUES ($1, $2, 'path', $3, true, $4, 1)`,
        [c.rows[0].id, f.kind, f.file, `coords-hash-${n}-${f.kind}`],
      );
    }
    return c.rows[0].id;
  }

  async function gpsOf(file: string): Promise<{ lat: unknown; lon: unknown }> {
    const { readExifTags } = await import("../uploads/exif.js");
    const tags = await readExifTags(file);
    return { lat: tags.GPSLatitude, lon: tags.GPSLongitude };
  }

  const post = (payload: object) => app.inject({ method: "POST", url: "/api/captures/coordinates", payload });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    dir = mkdtempSync(path.join(tmpdir(), "lifer-coords-"));
    process.env.DATA_DIR = dir;
    process.env.APP_DATA_DIR = path.join(dir, "app");
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'coords@test', 'x'), ($2, 'coords2@test', 'x')`,
      [USER, OTHER_USER],
    );
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 915881, 'Locus placatus', 'Placed Pipit', 'aves')`,
      [SPECIES],
    );
    await db.query(`INSERT INTO regions (id, name, boundary_geojson) VALUES ($1, 'Coordland', $2)`, [
      COUNTRY,
      square(-130, 40, -110, 60),
    ]);
    await db.query(
      `INSERT INTO regions (id, name, parent_id, boundary_geojson) VALUES ($1, 'West Coordland', $2, $3)`,
      [PROVINCE, COUNTRY, square(-130, 45, -120, 55)],
    );
    const { captureRoutes } = await import("./routes.js");
    const { regionAtRoutes } = await import("../regions/regionAt.js");
    app = Fastify();
    await app.register(captureRoutes, { prefix: "/api" });
    await app.register(regionAtRoutes, { prefix: "/api" });
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

  it("writes typed coordinates into the photo, the JPEG and the RAW's sidecar, then clears them", async () => {
    const jpeg = path.join(dir, "camera.jpg");
    // A RAW stand-in: its metadata goes in a sidecar, and the file itself is never written.
    const raw = path.join(dir, "pair.orf");
    await writeJpeg(jpeg, { lat: 10, lon: 20 });
    await writeJpeg(`${raw}.jpg`);
    renameSync(`${raw}.jpg`, raw);
    const rawBytes = readFileSync(raw);
    expect(await gpsOf(jpeg)).toEqual({ lat: 10, lon: 20 });
    const mine = await addCapture(USER, [
      { file: jpeg, kind: "jpeg" },
      { file: raw, kind: "raw" },
    ]);
    const theirs = await addCapture(OTHER_USER);

    const res = await post({ captureIds: [mine, theirs], lat: -33.8568, lon: 151.2153 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updated: 1, background: false });

    const row = await db.query(
      `SELECT id, lat, lon, location_source, location_accuracy_m FROM captures_all WHERE id = ANY($1)`,
      [[mine, theirs]],
    );
    const byId = new Map(row.rows.map((r) => [r.id, r]));
    expect(byId.get(mine)).toMatchObject({
      lat: "-33.8568",
      lon: "151.2153",
      // Typed points are 'map', so they are never mistaken for camera GPS.
      location_source: "map",
      location_accuracy_m: null,
    });
    // Another user's photo is never touched.
    expect(byId.get(theirs)).toMatchObject({ lat: "1", lon: "2", location_source: "inaturalist" });

    const sidecar = raw.replace(/\.orf$/, ".xmp");
    await vi.waitFor(
      async () => {
        const inJpeg = await gpsOf(jpeg);
        expect(Number(inJpeg.lat)).toBeCloseTo(-33.8568, 4);
        expect(Number(inJpeg.lon)).toBeCloseTo(151.2153, 4);
        const inSidecar = await gpsOf(sidecar);
        expect(Number(inSidecar.lat)).toBeCloseTo(-33.8568, 4);
        expect(Number(inSidecar.lon)).toBeCloseTo(151.2153, 4);
      },
      { timeout: 15_000, interval: 200 },
    );
    expect(readFileSync(raw).equals(rawBytes)).toBe(true);

    expect((await post({ captureIds: [mine], lat: null, lon: null })).json()).toEqual({
      updated: 1,
      background: false,
    });
    const cleared = await db.query(`SELECT lat, lon FROM captures_all WHERE id = $1`, [mine]);
    expect(cleared.rows[0]).toEqual({ lat: null, lon: null });
    await vi.waitFor(
      async () => {
        expect(await gpsOf(jpeg)).toEqual({ lat: undefined, lon: undefined });
        expect(await gpsOf(sidecar)).toEqual({ lat: undefined, lon: undefined });
      },
      { timeout: 15_000, interval: 200 },
    );
  });

  it("rejects out-of-range or half-given coordinates", async () => {
    const id = await addCapture(USER);
    expect((await post({ captureIds: [id], lat: 91, lon: 0 })).statusCode).toBe(400);
    expect((await post({ captureIds: [id], lat: 0, lon: -181 })).statusCode).toBe(400);
    expect((await post({ captureIds: [id], lat: 10, lon: null })).statusCode).toBe(400);
  });

  it("undoes the latest change, putting back each photo's own point and source", async () => {
    const placed = await addCapture(USER);
    const blank = await addCapture(USER);
    await db.query(`UPDATE captures_all SET lat = NULL, lon = NULL, location_source = NULL WHERE id = $1`, [blank]);
    expect((await post({ captureIds: [placed, blank], lat: 5, lon: 6 })).json()).toEqual({
      updated: 2,
      background: false,
    });
    const undo = await app.inject({ method: "POST", url: "/api/captures/location/undo" });
    expect(undo.json()).toMatchObject({ restored: 2 });
    const rows = await db.query(
      `SELECT id, lat, lon, location_source, location_accuracy_m FROM captures_all WHERE id = ANY($1)`,
      [[placed, blank]],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    expect(byId.get(placed)).toMatchObject({ lat: "1", lon: "2", location_source: "inaturalist" });
    expect(byId.get(blank)).toMatchObject({ lat: null, lon: null });
  });

  it("changes only the place name and region when asked to keep the point, as one undo step", async () => {
    const id = await addCapture(USER);
    await db.query(`UPDATE captures_all SET location_label = 'Old name' WHERE id = $1`, [id]);
    const res = await post({
      captureIds: [id],
      lat: null,
      lon: null,
      keepPoint: true,
      locationLabel: " Burnaby Lake ",
      regionId: PROVINCE,
    });
    expect(res.json()).toEqual({ updated: 1, background: false });
    const after = await db.query(`SELECT lat, lon, location_label, region_id FROM captures_all WHERE id = $1`, [id]);
    expect(after.rows[0]).toEqual({ lat: "1", lon: "2", location_label: "Burnaby Lake", region_id: PROVINCE });
    await app.inject({ method: "POST", url: "/api/captures/location/undo" });
    const undone = await db.query(`SELECT location_label, region_id FROM captures_all WHERE id = $1`, [id]);
    expect(undone.rows[0]).toEqual({ location_label: "Old name", region_id: null });
  });

  it("refiles a photo with only a region under another region, still without a point", async () => {
    const id = await addCapture(USER);
    await db.query(
      `UPDATE captures_all SET lat = NULL, lon = NULL, location_source = NULL, region_id = $2 WHERE id = $1`,
      [id, COUNTRY],
    );
    await post({ captureIds: [id], lat: null, lon: null, keepPoint: true, regionId: PROVINCE });
    const after = await db.query(`SELECT lat, lon, region_id FROM captures_all WHERE id = $1`, [id]);
    expect(after.rows[0]).toEqual({ lat: null, lon: null, region_id: PROVINCE });
    await app.inject({ method: "POST", url: "/api/captures/location/undo" });
    const undone = await db.query(`SELECT region_id FROM captures_all WHERE id = $1`, [id]);
    expect(undone.rows[0].region_id).toBe(COUNTRY);
  });

  it("leaves the place name alone unless it is sent", async () => {
    const id = await addCapture(USER);
    await db.query(`UPDATE captures_all SET location_label = 'Kept' WHERE id = $1`, [id]);
    await post({ captureIds: [id], lat: 3, lon: 4 });
    const row = await db.query(`SELECT location_label FROM captures_all WHERE id = $1`, [id]);
    expect(row.rows[0].location_label).toBe("Kept");
  });

  it("says whether a region holds a point", async () => {
    const url = `/api/regions/at?lat=50&lon=-115&within=${PROVINCE}&within=${COUNTRY}`;
    expect((await app.inject({ method: "GET", url })).json()).toEqual({
      region: { id: COUNTRY, name: "Coordland" },
      outside: [PROVINCE],
    });
  });

  it("suggests the most specific region holding the point", async () => {
    const at = async (lat: number, lon: number) =>
      (await app.inject({ method: "GET", url: `/api/regions/at?lat=${lat}&lon=${lon}` })).json().region;
    expect(await at(50, -125)).toEqual({ id: PROVINCE, name: "West Coordland" });
    expect(await at(50, -115)).toEqual({ id: COUNTRY, name: "Coordland" });
    expect(await at(0, 0)).toBeNull();
    expect((await app.inject({ method: "GET", url: "/api/regions/at?lat=95&lon=0" })).statusCode).toBe(400);
  });
});
