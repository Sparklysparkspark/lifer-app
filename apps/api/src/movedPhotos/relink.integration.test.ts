// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test npx vitest run movedPhotos
// Quiet relinking: a file moved within the places photos live is found and relinked, Undo puts it
// back, a renamed folder is found by inode, copies and edited files go to review, a trip whose
// folder moved gets the offer, a file moved outside the places stays missing, and an unchanged
// folder isn't listed again.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000b71";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000b72";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "moved-photos@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});
vi.mock("../lib/libraryRecords.js", () => ({ scheduleTripRecordsSave: () => {} }));

describe.skipIf(!url)("finding moved photos", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dir: string;
  let lib: string;
  let place: string;
  let n = 0;

  async function clearRows() {
    for (const sql of [
      `DELETE FROM relink_batches WHERE user_id = $1`,
      `DELETE FROM moved_photo_reviews WHERE user_id = $1`,
      `DELETE FROM trip_folder_proposals WHERE user_id = $1`,
      `DELETE FROM photo_places WHERE user_id = $1`,
      `DELETE FROM originals WHERE user_id = $1`,
      `DELETE FROM captures_all WHERE user_id = $1`,
      `DELETE FROM trips WHERE user_id = $1`,
    ])
      await db.query(sql, [USER]);
    await db.query(`DELETE FROM seen_files`);
    await db.query(`DELETE FROM seen_folders`);
  }

  /** A photo whose file is at `file`, fingerprinted the way an import does. */
  async function photo(file: string, opts: { bytes?: string | Buffer; tripId?: string; exif?: string | null } = {}) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, opts.bytes ?? `photo ${n} ${file}`);
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, trip_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [USER, SPECIES, `mp-${n++}`, opts.tripId ?? null],
    );
    const { fingerprintFile } = await import("./fingerprint.js");
    const fp = await fingerprintFile(file);
    const o = await db.query<{ id: string }>(
      `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size, user_id,
                              exif_fingerprint, fp_quick_hash, fp_size, fp_mtime, fp_file_id)
       VALUES ($1, 'jpeg', 'path', $2, true, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        c.rows[0].id,
        file,
        `mp-hash-${n}`,
        fp.size,
        USER,
        opts.exif ?? null,
        fp.quickHash,
        fp.size,
        fp.mtime,
        fp.fileId,
      ],
    );
    return o.rows[0].id;
  }

  const refOf = async (id: string) =>
    (await db.query<{ ref: string }>(`SELECT ref FROM originals WHERE id = $1`, [id])).rows[0].ref;
  const post = (route: string, payload: object = {}) => app.inject({ method: "POST", url: `/api${route}`, payload });
  const get = (route: string) => app.inject({ method: "GET", url: `/api${route}` });

  async function look(body: object = { manual: true }) {
    const { movedPhotosJob } = await import("./relink.js");
    const res = await post("/moved-photos/look", body);
    expect(res.json()).toEqual({ started: true });
    await movedPhotosJob.settled();
    expect(movedPhotosJob.status.error).toBeNull();
    return movedPhotosJob.status.result!;
  }

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "lifer-moved-photos-")));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = path.join(dir, "lib");
    process.env.APP_DATA_DIR = path.join(dir, "app");
    mkdirSync(process.env.APP_DATA_DIR, { recursive: true });
    db = new pg.Pool({ connectionString: url });
    await clearRows();
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'moved-photos@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 918972, 'Movea photis', 'Mp Tern', 'aves')`,
      [SPECIES],
    );
    const { movedPhotosRoutes } = await import("./routes.js");
    app = Fastify();
    await app.register(movedPhotosRoutes, { prefix: "/api" });
    await app.ready();
  });

  beforeEach(async () => {
    await clearRows();
    rmSync(path.join(dir, "lib"), { recursive: true, force: true });
    rmSync(path.join(dir, "places"), { recursive: true, force: true });
    rmSync(path.join(dir, "outside"), { recursive: true, force: true });
    lib = path.join(dir, "lib");
    place = path.join(dir, "places", "Photos");
    mkdirSync(lib, { recursive: true });
    mkdirSync(place, { recursive: true });
    const res = await post("/moved-photos/places", { path: place });
    expect(res.statusCode).toBe(200);
  });

  afterAll(async () => {
    await app?.close();
    await clearRows();
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.end();
    const { closeExiftool } = await import("../uploads/exif.js");
    await closeExiftool();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("relinks a file moved within a place, quietly, and Undo puts the old path back", async () => {
    const old = path.join(place, "2025", "a.jpg");
    const id = await photo(old);
    const kept = await photo(path.join(place, "2025", "b.jpg"));
    mkdirSync(path.join(place, "Sorted"));
    const moved = path.join(place, "Sorted", "a.jpg");
    renameSync(old, moved);

    const result = await look();
    expect(result).toMatchObject({ missing: 1, relinked: 1, review: 0 });
    expect(await refOf(id)).toBe(moved);
    expect(await refOf(kept)).toBe(path.join(place, "2025", "b.jpg"));

    const status = (await get("/moved-photos/status")).json();
    expect(status.notice).toEqual({ batchId: result.batchId, count: 1 });
    await post("/moved-photos/ack", { batchIds: [result.batchId] });
    expect((await get("/moved-photos/status")).json().notice).toBeNull();

    expect((await post(`/moved-photos/batches/${result.batchId}/undo`)).json()).toEqual({ undone: true });
    expect(await refOf(id)).toBe(old);
    const log = (await get("/moved-photos/batches")).json();
    expect(log.batches[0]).toMatchObject({ id: result.batchId, count: 1, undone: true });
    // Undone, so the same file isn't taken again by the next look.
    expect((await look()).relinked).toBe(0);
    expect(await refOf(id)).toBe(old);
  });

  it("finds a renamed folder by inode, without reading the files", async () => {
    const a = await photo(path.join(lib, "Birds", "Tern", "a.jpg"));
    // Fingerprinted before the hash existed: only the inode, size and mtime can match it.
    await db.query(`UPDATE originals SET fp_quick_hash = NULL WHERE id = $1`, [a]);
    renameSync(path.join(lib, "Birds", "Tern"), path.join(lib, "Birds", "Common Tern"));

    const result = await look();
    expect(result.relinked).toBe(1);
    expect(await refOf(a)).toBe(path.join(lib, "Birds", "Common Tern", "a.jpg"));
    // No candidate was read.
    const read = await db.query(`SELECT count(*)::int AS n FROM seen_files WHERE quick_hash IS NOT NULL`);
    expect(read.rows[0].n).toBe(0);
  });

  it("sends exact copies to review instead of guessing", async () => {
    const old = path.join(place, "a.jpg");
    const id = await photo(old, { bytes: "the same bytes" });
    mkdirSync(path.join(place, "One"));
    mkdirSync(path.join(place, "Two"));
    copyFileSync(old, path.join(place, "One", "a.jpg"));
    copyFileSync(old, path.join(place, "Two", "a.jpg"));
    rmSync(old);

    const result = await look();
    expect(result).toMatchObject({ relinked: 0, review: 1 });
    expect(await refOf(id)).toBe(old);
    const reviews = (await get("/moved-photos/reviews")).json();
    expect(reviews.total).toBe(1);
    expect(reviews.items[0]).toMatchObject({ originalId: id, reason: "several" });
    expect(reviews.items[0].candidates.map((c: { path: string }) => c.path).sort()).toEqual([
      path.join(place, "One", "a.jpg"),
      path.join(place, "Two", "a.jpg"),
    ]);

    // Picking one relinks it, as a batch Undo can reverse; the review is done.
    const pick = await post(`/moved-photos/reviews/${id}/use`, { path: path.join(place, "Two", "a.jpg") });
    expect(pick.statusCode).toBe(200);
    expect(await refOf(id)).toBe(path.join(place, "Two", "a.jpg"));
    expect((await get("/moved-photos/reviews")).json().total).toBe(0);
    // A file that wasn't offered is refused.
    const other = await photo(path.join(place, "c.jpg"));
    await db.query(
      `INSERT INTO moved_photo_reviews (original_id, user_id, candidates, reason) VALUES ($1, $2, $3, 'several')`,
      [other, USER, [path.join(place, "One", "a.jpg")]],
    );
    expect((await post(`/moved-photos/reviews/${other}/use`, { path: "/etc/hosts" })).statusCode).toBe(400);
  });

  it("offers a photo edited in place for review, as probably the same", async () => {
    const original = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#456" } })
      .withExif({ IFD0: { Model: "TestCam", Make: "Lifer" }, IFD2: { DateTimeOriginal: "2025:06:14 10:11:12" } })
      .jpeg({ quality: 90 })
      .toBuffer();
    const old = path.join(place, "IMG_0001.jpg");
    const { computeExifFingerprint } = await import("../uploads/exif.js");
    mkdirSync(place, { recursive: true });
    writeFileSync(old, original);
    const exif = (await computeExifFingerprint(old)).strict;
    expect(exif).toBeTruthy();
    const id = await photo(old, { bytes: original, exif });
    // Re-saved by an editor somewhere else in the place: new bytes, same capture.
    const edited = await sharp(original).withMetadata().jpeg({ quality: 60 }).toBuffer();
    mkdirSync(path.join(place, "Edited"));
    writeFileSync(path.join(place, "Edited", "IMG_0001.jpg"), edited);
    rmSync(old);

    const result = await look();
    expect(result).toMatchObject({ relinked: 0, review: 1 });
    expect(await refOf(id)).toBe(old);
    const reviews = (await get("/moved-photos/reviews")).json();
    expect(reviews.items[0]).toMatchObject({ reason: "probably" });
  });

  it("offers a trip's moved folder, and using it points the trip there", async () => {
    const tripFolder = path.join(place, "Belize");
    const wildlife = path.join(tripFolder, "Wildlife");
    const tripId = (
      await db.query<{ id: string }>(
        `INSERT INTO trips (user_id, name, source_folder, destination_folder) VALUES ($1, 'Belize', $2, $3) RETURNING id`,
        [USER, tripFolder, wildlife],
      )
    ).rows[0].id;
    const ids = [];
    for (const name of ["a", "b", "c"]) ids.push(await photo(path.join(wildlife, "Birds", `${name}.jpg`), { tripId }));
    const renamed = path.join(place, "Belize 2026");
    renameSync(tripFolder, renamed);

    const result = await look();
    expect(result).toMatchObject({ relinked: 3, proposals: 1 });
    const status = (await get("/moved-photos/status")).json();
    expect(status.proposals).toEqual([
      { tripId, tripName: "Belize", folder: renamed, found: 3, total: 3, announced: false },
    ]);

    const used = await post(`/moved-photos/trip-folders/${tripId}/use`);
    expect(used.statusCode).toBe(200);
    const trip = await db.query(`SELECT source_folder, destination_folder FROM trips WHERE id = $1`, [tripId]);
    expect(trip.rows[0]).toEqual({ source_folder: renamed, destination_folder: path.join(renamed, "Wildlife") });
    expect((await get("/moved-photos/status")).json().proposals).toEqual([]);

    // Undo puts the trip's folders back.
    await post(`/moved-photos/batches/${used.json().batchId}/undo`);
    const back = await db.query(`SELECT source_folder, destination_folder FROM trips WHERE id = $1`, [tripId]);
    expect(back.rows[0]).toEqual({ source_folder: tripFolder, destination_folder: wildlife });
  });

  it("leaves a photo missing when it moved somewhere Lifer doesn't look", async () => {
    const old = path.join(place, "a.jpg");
    const id = await photo(old);
    mkdirSync(path.join(dir, "outside"), { recursive: true });
    renameSync(old, path.join(dir, "outside", "a.jpg"));

    const result = await look();
    expect(result).toMatchObject({ missing: 1, relinked: 0, review: 0 });
    expect(await refOf(id)).toBe(old);
  });

  it("does nothing more than stat when nothing is missing, and skips folders unchanged since the last walk", async () => {
    const id = await photo(path.join(place, "x", "a.jpg"));
    const fpOf = async () =>
      (await db.query<{ fp_quick_hash: string | null }>(`SELECT fp_quick_hash FROM originals WHERE id = $1`, [id]))
        .rows[0].fp_quick_hash;
    const before = await fpOf();
    const nothing = await look();
    expect(nothing).toMatchObject({ missing: 0, walk: null });
    // Unchanged, so its fingerprint stays; changed, it's cleared and read again by the fingerprint pass.
    expect(await fpOf()).toBe(before);
    writeFileSync(path.join(place, "x", "a.jpg"), "edited elsewhere, now longer");
    await look();
    expect(await fpOf()).toBeNull();
    const { startFingerprints } = await import("./relink.js");
    await startFingerprints(USER);
    expect(await fpOf()).toMatch(/^[0-9a-f]{40}$/);

    const { walkPlaces } = await import("./walk.js");
    const exts = new Set([".jpg"]);
    const first = await walkPlaces([place], exts, new AbortController().signal);
    expect(first.filesStatted).toBe(1);
    const second = await walkPlaces([place], exts, new AbortController().signal);
    expect(second).toMatchObject({ filesStatted: 0, foldersSkipped: second.folders });
    // A new file changes its folder's mtime, so only that folder is listed again.
    writeFileSync(path.join(place, "x", "b.jpg"), "new");
    const third = await walkPlaces([place], exts, new AbortController().signal);
    expect(third).toMatchObject({ filesStatted: 2, foldersSkipped: third.folders - 1 });
  });

  it("walks 5,000 files within budget and keeps the event loop responsive", async () => {
    const big = path.join(place, "Big");
    for (let f = 0; f < 50; f++) {
      const sub = path.join(big, `folder ${f}`);
      mkdirSync(sub, { recursive: true });
      for (let i = 0; i < 100; i++) writeFileSync(path.join(sub, `IMG_${i}.jpg`), `${f}-${i}`);
    }
    const { walkPlaces } = await import("./walk.js");
    const { monitorEventLoopDelay } = await import("node:perf_hooks");
    const lag = monitorEventLoopDelay({ resolution: 5 });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    lag.enable();
    const started = performance.now();
    const stats = await walkPlaces([big], new Set([".jpg"]), new AbortController().signal);
    const ms = performance.now() - started;
    lag.disable();
    clearInterval(timer);
    const maxLagMs = lag.max / 1e6;
    console.log(`[moved-photos] 5,000-file walk: ${Math.round(ms)} ms, max event-loop lag ${maxLagMs.toFixed(1)} ms`);
    expect(stats.filesStatted).toBe(5000);
    expect(ms).toBeLessThan(20_000);
    expect(maxLagMs).toBeLessThan(250);
    expect(ticks).toBeGreaterThan(0);
    expect(statSync(big).isDirectory()).toBe(true);
  });
});
