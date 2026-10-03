// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run reimport
// Reimporting a folder with an edited TIFF next to a sensor-data TIFF (a RAW) and a HEIC: each
// is sorted by content, matched by its keywords, and gets derivatives.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExifTool, type WriteTags } from "exiftool-vendored";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setTiffPhotometric } from "../uploads/testImages.js";

const url = process.env.TEST_DATABASE_URL;
const USER = "dddddddd-0000-4000-8000-000000000130";
const SPECIES = "dddddddd-0000-4000-8000-00000000000d";
const COMMON = "Reimport Test Plover";
const TAKEN = "2024:06:01 08:30:00";
const hasHeicEncoder = process.platform === "darwin" ? existsSync("/usr/bin/sips") : existsSync("/usr/bin/heif-enc") || existsSync("/opt/homebrew/bin/heif-enc");

describe.skipIf(!url)("library reimport of TIFF, RAW and HEIC", () => {
  let db: pg.Pool;
  let dataDir: string;
  let exiftool: ExifTool;
  let reimport: typeof import("./reimport.js");
  let editedTiff: string;
  let rawTiff: string;
  let heic: string;
  let strayUpload: string;

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM originals WHERE capture_id IN (SELECT id FROM captures_all WHERE user_id = $1)`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-reimport-formats-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    // Inside the library on purpose: the walk must skip its derivatives and upload scratch files.
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    exiftool = new ExifTool();
    reimport = await import("./reimport.js");
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'reimport-formats@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 910804, 'Testus reimportensis', $2, 'aves') ON CONFLICT (id) DO NOTHING`,
      [SPECIES, COMMON],
    );

    const species = path.join(dataDir, "Birds", COMMON);
    mkdirSync(path.join(species, "Adjusted"), { recursive: true });
    mkdirSync(path.join(species, "RAW"), { recursive: true });
    const img = (shade: number) => sharp({ create: { width: 96, height: 64, channels: 3, background: { r: shade, g: 120, b: 60 } } });

    // Same name in both folders: only the content tells the edit from the sensor data.
    editedTiff = path.join(species, "Adjusted", "IMG_0001.tif");
    await img(40).tiff().toFile(editedTiff);
    // sharp writes no DateTimeOriginal into a TIFF, and RAW pairing needs the capture time.
    await exiftool.write(editedTiff, { "XMP-dc:Subject": [COMMON], DateTimeOriginal: TAKEN } as WriteTags, { writeArgs: ["-overwrite_original"] });
    rawTiff = path.join(species, "RAW", "IMG_0001.tif");
    writeFileSync(rawTiff, setTiffPhotometric(await img(41).tiff().toBuffer(), 32803));
    await exiftool.write(rawTiff, { DateTimeOriginal: TAKEN } as WriteTags, { writeArgs: ["-overwrite_original"] });

    heic = path.join(species, "Adjusted", "IMG_0002.HEIC");
    if (hasHeicEncoder) {
      const src = path.join(dataDir, "..", `${path.basename(dataDir)}-heic-src.jpg`);
      await img(200).jpeg().toFile(src);
      if (process.platform === "darwin") execFileSync("/usr/bin/sips", ["-s", "format", "heic", src, "--out", heic], { stdio: "ignore" });
      else execFileSync(existsSync("/usr/bin/heif-enc") ? "/usr/bin/heif-enc" : "/opt/homebrew/bin/heif-enc", [src, "-o", heic], { stdio: "ignore" });
      rmSync(src, { force: true });
      await exiftool.write(heic, { "XMP-dc:Subject": [COMMON], DateTimeOriginal: "2024:06:01 09:00:00" } as WriteTags, { writeArgs: ["-overwrite_original"] });
    }

    const { uploadTempDir } = await import("../lib/uploadWorkDir.js");
    mkdirSync(uploadTempDir(), { recursive: true });
    strayUpload = path.join(uploadTempDir(), "stray.jpg");
    await img(90).jpeg().toFile(strayUpload);
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.end();
    await exiftool.end();
    const { closeExiftool } = await import("../uploads/exif.js");
    await closeExiftool();
    const { pool } = await import("../db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("sorts files by content and recovers each with derivatives", async () => {
    const { jpegs, raws } = await reimport.listManagedFiles(dataDir);
    expect(raws).toEqual([rawTiff]);
    expect(jpegs.sort()).toEqual((hasHeicEncoder ? [editedTiff, heic] : [editedTiff]).sort());
    expect([...jpegs, ...raws]).not.toContain(strayUpload);

    const tiffOutcome = await reimport.recoverJpeg(USER, editedTiff);
    expect(tiffOutcome).toMatchObject({ status: "recovered", scientificName: "Testus reimportensis" });
    if (tiffOutcome.status !== "recovered") return;
    const photo = await db.query<{ width: number; height: number; display_path: string }>(`SELECT width, height, display_path FROM photos WHERE id = $1`, [tiffOutcome.photoId]);
    expect(photo.rows[0]).toMatchObject({ width: 96, height: 64 });
    expect(existsSync(photo.rows[0].display_path)).toBe(true);
    const original = await db.query<{ kind: string; ref: string; file_size: string }>(`SELECT kind, ref, file_size FROM originals WHERE capture_id = $1`, [tiffOutcome.captureId]);
    expect(original.rows[0]).toMatchObject({ kind: "jpeg", ref: editedTiff });
    expect(Number(original.rows[0].file_size)).toBe(statSync(editedTiff).size);

    // Derivatives landed under app-data inside the library; a second walk still ignores them.
    const again = await reimport.listManagedFiles(dataDir);
    expect(again.jpegs.length + again.raws.length).toBe(jpegs.length + raws.length);

    const rawOutcome = await reimport.recoverRaw(USER, rawTiff);
    expect(rawOutcome).toEqual({ status: "recovered", captureId: tiffOutcome.captureId });
  }, 60_000);

  it.skipIf(!hasHeicEncoder)("recovers a HEIC from its keywords with upright derivatives", async () => {
    const outcome = await reimport.recoverJpeg(USER, heic);
    expect(outcome).toMatchObject({ status: "recovered", scientificName: "Testus reimportensis" });
    if (outcome.status !== "recovered") return;
    const photo = await db.query<{ width: number; height: number; display_path: string }>(`SELECT width, height, display_path FROM photos WHERE id = $1`, [outcome.photoId]);
    expect(photo.rows[0]).toMatchObject({ width: 96, height: 64 });
    const display = await sharp(photo.rows[0].display_path).metadata();
    expect(display.format).toBe("webp");
    const capture = await db.query<{ taken_at: Date | null }>(`SELECT taken_at FROM captures WHERE id = $1`, [outcome.captureId]);
    expect(capture.rows[0].taken_at).toBeTruthy();
  }, 60_000);
});
