// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Adjust date and time: shifts the selected photos' dates in Lifer and in their managed files
// (in the JPEG, in the RAW's sidecar), skips undated ones, and a reverse shift undoes it.
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000771";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000772";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "shift-time@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

const HOUR = 60;

describe.skipIf(!url)("adjust date and time", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dir: string;
  let fingerprint = 0;

  async function cleanup() {
    await db.query(`DELETE FROM originals WHERE capture_id IN (SELECT id FROM captures_all WHERE user_id = $1)`, [
      USER,
    ]);
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
  }

  async function writeJpeg(file: string, dateTimeOriginal?: string) {
    await sharp({ create: { width: 16, height: 16, channels: 3, background: "#357" } })
      .jpeg()
      .toFile(file);
    if (dateTimeOriginal) {
      const { ExifTool } = await import("exiftool-vendored");
      const et = new ExifTool();
      await et.write(
        file,
        { "EXIF:DateTimeOriginal": dateTimeOriginal, "EXIF:CreateDate": dateTimeOriginal },
        { writeArgs: ["-overwrite_original"] },
      );
      await et.end();
    }
  }

  async function addCapture(
    takenAt: string | null,
    files: Array<{ file: string; kind: "jpeg" | "raw"; managed?: boolean }> = [],
  ) {
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at) VALUES ($1, $2, $3, $4) RETURNING id`,
      [USER, SPECIES, `shift-${++fingerprint}`, takenAt],
    );
    for (const f of files) {
      await db.query(
        `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size)
         VALUES ($1, $2, 'path', $3, $4, $5, 1)`,
        [c.rows[0].id, f.kind, f.file, f.managed ?? true, `shift-hash-${fingerprint}-${f.kind}`],
      );
    }
    return c.rows[0].id;
  }

  async function takenAt(id: string): Promise<string | null> {
    const r = await db.query<{ taken_at: Date | null }>(`SELECT taken_at FROM captures_all WHERE id = $1`, [id]);
    return r.rows[0].taken_at?.toISOString() ?? null;
  }

  async function fileTime(file: string): Promise<string | undefined> {
    const { readExifTags } = await import("../uploads/exif.js");
    const dt = (await readExifTags(file)).DateTimeOriginal;
    return dt == null ? undefined : String(dt);
  }

  async function shift(captureIds: string[], minutes: number) {
    const res = await app.inject({
      method: "POST",
      url: "/api/captures/taken-at/shift",
      payload: { captureIds, minutes },
    });
    expect(res.statusCode).toBe(202);
    const { takenAtShiftJob } = await import("./takenAtShift.js");
    await takenAtShiftJob.settled();
    const status = (await app.inject({ method: "GET", url: "/api/captures/taken-at/shift/status" })).json();
    expect(status.error).toBeNull();
    return status;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    dir = mkdtempSync(path.join(tmpdir(), "lifer-shift-time-"));
    process.env.DATA_DIR = dir;
    process.env.APP_DATA_DIR = path.join(dir, "app");
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'shift-time@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 915771, 'Tempus shiftus', 'Shifted Shrike', 'aves')`,
      [SPECIES],
    );
    const { takenAtShiftRoutes } = await import("./takenAtShift.js");
    app = Fastify();
    await app.register(takenAtShiftRoutes, { prefix: "/api" });
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

  it("shifts dates and files forward, skips undated photos, and a reverse shift undoes it", async () => {
    const jpeg = path.join(dir, "jpeg.jpg");
    const companionJpeg = path.join(dir, "pair.jpg");
    // A RAW stand-in: its metadata goes in a sidecar, and the file itself is never written.
    const raw = path.join(dir, "pair.orf");
    const linked = path.join(dir, "linked.jpg");
    await writeJpeg(jpeg, "2026:05:03 06:12:00");
    await writeJpeg(companionJpeg, "2026:05:03 07:00:00");
    await writeJpeg(`${raw}.jpg`, "2026:05:03 07:00:00");
    renameSync(`${raw}.jpg`, raw);
    await writeJpeg(linked, "2026:05:03 08:00:00");
    const rawBytes = readFileSync(raw);
    const linkedBytes = readFileSync(linked);

    const single = await addCapture("2026-05-03T06:12:00Z", [{ file: jpeg, kind: "jpeg" }]);
    const pair = await addCapture("2026-05-03T07:00:00Z", [
      { file: companionJpeg, kind: "jpeg" },
      { file: raw, kind: "raw" },
    ]);
    const linkedCapture = await addCapture("2026-05-03T08:00:00Z", [{ file: linked, kind: "jpeg", managed: false }]);
    const undated = await addCapture(null);
    const notSelected = await addCapture("2026-05-03T09:00:00Z");
    await db.query(
      `INSERT INTO user_species (user_id, species_id, state, first_collected) VALUES ($1, $2, 'collected', '2026-05-03')`,
      [USER, SPECIES],
    );
    const selected = [single, pair, linkedCapture, undated];

    const preview = (
      await app.inject({ method: "POST", url: "/api/captures/taken-at/preview", payload: { captureIds: selected } })
    ).json();
    expect(preview).toMatchObject({
      dated: 3,
      undated: 1,
      earliest: "2026-05-03T06:12:00.000Z",
      latest: "2026-05-03T08:00:00.000Z",
      first: { captureId: single, takenAt: "2026-05-03T06:12:00.000Z" },
    });

    // A day and eight hours later, as a trip's time zone forgotten.
    const forward = 24 * HOUR + 8 * HOUR;
    const done = await shift(selected, forward);
    expect(done.result).toEqual({ shifted: 3, undated: 1, filesFailed: 0 });
    expect(done.processed).toBe(4);
    expect(await takenAt(single)).toBe("2026-05-04T14:12:00.000Z");
    expect(await takenAt(pair)).toBe("2026-05-04T15:00:00.000Z");
    expect(await takenAt(undated)).toBeNull();
    expect(await takenAt(notSelected)).toBe("2026-05-03T09:00:00.000Z");
    expect(await fileTime(jpeg)).toBe("2026-05-04T14:12:00");
    expect(await fileTime(companionJpeg)).toBe("2026-05-04T15:00:00");
    expect(await fileTime(raw.replace(/\.orf$/, ".xmp"))).toBe("2026-05-04T15:00:00");
    expect(readFileSync(raw).equals(rawBytes)).toBe(true);
    expect(readFileSync(linked).equals(linkedBytes)).toBe(true);
    // The first photo date was the shifted day; the photo left behind still holds it.
    const first = await db.query(`SELECT first_collected::text AS d FROM user_species WHERE user_id = $1`, [USER]);
    expect(first.rows[0].d).toBe("2026-05-03");

    // Undo: the same photos, the opposite shift.
    const undone = await shift(selected, -forward);
    expect(undone.result).toEqual({ shifted: 3, undated: 1, filesFailed: 0 });
    expect(await takenAt(single)).toBe("2026-05-03T06:12:00.000Z");
    expect(await takenAt(pair)).toBe("2026-05-03T07:00:00.000Z");
    expect(await fileTime(jpeg)).toBe("2026-05-03T06:12:00");
    expect(await fileTime(raw.replace(/\.orf$/, ".xmp"))).toBe("2026-05-03T07:00:00");
    expect(readFileSync(raw).equals(rawBytes)).toBe(true);
  });

  it("set-time mode: one photo's corrected time moves the rest by the same difference", async () => {
    const a = await addCapture("2026-06-01T10:00:00Z");
    const b = await addCapture("2026-06-01T11:30:00Z");
    const preview = (
      await app.inject({ method: "POST", url: "/api/captures/taken-at/preview", payload: { captureIds: [b, a] } })
    ).json();
    // Selection order decides the photo shown, not time order.
    expect(preview.first.captureId).toBe(b);
    const minutes = (Date.parse("2026-06-01T09:15:00Z") - Date.parse(preview.first.takenAt)) / 60_000;
    await shift([b, a], minutes);
    expect(await takenAt(b)).toBe("2026-06-01T09:15:00.000Z");
    expect(await takenAt(a)).toBe("2026-06-01T07:45:00.000Z");
  });

  it("moves first_collected with the species' earliest photo", async () => {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    const only = await addCapture("2026-07-10T12:00:00Z");
    await db.query(
      `INSERT INTO user_species (user_id, species_id, state, first_collected)
       SELECT $1, $2, 'collected', min(taken_at)::date FROM captures WHERE user_id = $1`,
      [USER, SPECIES],
    );
    await shift([only], -3 * 24 * HOUR);
    const first = await db.query(
      `SELECT (first_collected = (SELECT taken_at::date FROM captures WHERE id = $2)) AS follows FROM user_species WHERE user_id = $1`,
      [USER, only],
    );
    expect(first.rows[0].follows).toBe(true);
  });

  it("pages through a large selection and rejects a zero shift or a second run", async () => {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    const { SHIFT_PAGE_SIZE } = await import("./takenAtShift.js");
    const count = SHIFT_PAGE_SIZE * 2 + 37;
    const ids = (
      await db.query<{ id: string }>(
        `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at)
         SELECT $1, $2, 'shift-bulk-' || g, timestamptz '2026-01-01T00:00:00Z' + g * interval '1 minute'
         FROM generate_series(1, $3) g RETURNING id`,
        [USER, SPECIES, count],
      )
    ).rows.map((r) => r.id);
    const outside = await addCapture("2026-01-01T00:00:00Z");

    const zero = await app.inject({
      method: "POST",
      url: "/api/captures/taken-at/shift",
      payload: { captureIds: ids, minutes: 0 },
    });
    expect(zero.statusCode).toBe(400);

    const started = await app.inject({
      method: "POST",
      url: "/api/captures/taken-at/shift",
      payload: { captureIds: ids, minutes: 90 },
    });
    expect(started.statusCode).toBe(202);
    const again = await app.inject({
      method: "POST",
      url: "/api/captures/taken-at/shift",
      payload: { captureIds: ids, minutes: 90 },
    });
    expect(again.statusCode).toBe(409);
    const { takenAtShiftJob } = await import("./takenAtShift.js");
    await takenAtShiftJob.settled();
    expect(takenAtShiftJob.status.result).toEqual({ shifted: count, undated: 0, filesFailed: 0 });
    expect(takenAtShiftJob.status.processed).toBe(count);
    expect(takenAtShiftJob.status.total).toBe(count);

    // Each was 1..count minutes past midnight; all of them are now 90 minutes later.
    const range = await db.query<{ n: number; earliest: Date; latest: Date }>(
      `SELECT count(*)::int AS n, min(taken_at) AS earliest, max(taken_at) AS latest
       FROM captures_all WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    expect(range.rows[0].earliest.toISOString()).toBe("2026-01-01T01:31:00.000Z");
    expect(range.rows[0].latest.getTime()).toBe(Date.parse("2026-01-01T01:30:00Z") + count * 60_000);
    expect(await takenAt(outside)).toBe("2026-01-01T00:00:00.000Z");
  });
});
