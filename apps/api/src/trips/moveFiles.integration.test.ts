// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test npx vitest run moveFiles
// "Move trip files": every managed file lands under the chosen folder (sidecars too), its stored
// path follows, and the original goes only after that. Never overwrites, reports missing files,
// copies and checks across drives, stops cleanly when cancelled, refuses a read-only folder
// before touching anything, and picks up a move cut short. "Point to where I moved them" only
// relinks files that are really there.
import {
  chmodSync,
  existsSync,
  linkSync,
  symlinkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000a71";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000a72";

// Lets a test make every hard link fail as across drives, or cancel after the Nth link.
const fsControl = vi.hoisted(() => ({ crossDrive: false, onLink: null as null | (() => void) }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    link: async (from: string, to: string) => {
      fsControl.onLink?.();
      if (fsControl.crossDrive) throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
      return real.link(from, to);
    },
  };
});
vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "trip-move@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});
vi.mock("../lib/libraryRecords.js", () => ({ scheduleTripRecordsSave: () => {} }));

describe.skipIf(!url)("moving a trip's files", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dir: string;
  let oldRoot: string;
  let target: string;
  let tripId: string;
  let n = 0;

  async function cleanup() {
    await db.query(`DELETE FROM originals WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM trips WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
  }

  /** A trip photo with one file at `rel` under the trip's folder. */
  async function photo(rel: string, opts: { managed?: boolean; bytes?: string; kind?: string } = {}) {
    const file = path.join(oldRoot, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    const bytes = opts.bytes ?? `photo ${rel}`;
    writeFileSync(file, bytes);
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, trip_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [USER, SPECIES, `tm-${n++}`, tripId],
    );
    await db.query(
      `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size, user_id)
       VALUES ($1, $2, 'path', $3, $4, $5, $6, $7)`,
      [c.rows[0].id, opts.kind ?? "jpeg", file, opts.managed ?? true, `tm-hash-${n}`, Buffer.byteLength(bytes), USER],
    );
    return c.rows[0].id;
  }

  const refOf = async (captureId: string) =>
    (await db.query<{ ref: string }>(`SELECT ref FROM originals WHERE capture_id = $1`, [captureId])).rows[0].ref;
  const tripFolders = async () =>
    (
      await db.query<{ source_folder: string; destination_folder: string }>(
        `SELECT source_folder, destination_folder FROM trips WHERE id = $1`,
        [tripId],
      )
    ).rows[0];
  const post = (route: string, payload: object) => app.inject({ method: "POST", url: `/api${route}`, payload });
  async function move(folder = target) {
    const res = await post(`/trips/${tripId}/move-files`, { folder });
    const { tripFileMoveJob } = await import("./moveFiles.js");
    await tripFileMoveJob.settled();
    return { res, status: tripFileMoveJob.status };
  }

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "lifer-trip-move-")));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = path.join(dir, "lib");
    process.env.APP_DATA_DIR = path.join(dir, "app");
    process.env.SINGLE_USER_MODE = "1";
    mkdirSync(process.env.APP_DATA_DIR, { recursive: true });
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'trip-move@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 918971, 'Movea tripis', 'Tm Tern', 'aves')`,
      [SPECIES],
    );
    const { tripFileMoveRoutes } = await import("./moveFiles.js");
    app = Fastify();
    await app.register(tripFileMoveRoutes, { prefix: "/api" });
    await app.ready();
  });

  beforeEach(async () => {
    fsControl.crossDrive = false;
    fsControl.onLink = null;
    await db.query(`DELETE FROM originals WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM trips WHERE user_id = $1`, [USER]);
    rmSync(path.join(dir, "trip"), { recursive: true, force: true });
    rmSync(path.join(dir, "elsewhere"), { recursive: true, force: true });
    oldRoot = path.join(dir, "trip", "Wildlife");
    target = path.join(dir, "elsewhere", "Costa Rica");
    mkdirSync(oldRoot, { recursive: true });
    tripId = (
      await db.query<{ id: string }>(
        `INSERT INTO trips (user_id, name, source_folder, destination_folder) VALUES ($1, 'Costa Rica', $2, $3) RETURNING id`,
        [USER, path.join(dir, "trip"), oldRoot],
      )
    ).rows[0].id;
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

  it("checks first: counts, size, and what stays put", async () => {
    await photo("Birds/Tern/Adjusted/a.jpg", { bytes: "12345" });
    await photo("Birds/Tern/Adjusted/b.jpg", { bytes: "123" });
    await photo("Birds/Tern/Adjusted/c.jpg", { managed: false });
    const gone = await photo("Birds/Tern/Adjusted/d.jpg");
    rmSync(await refOf(gone));
    const res = await post(`/trips/${tripId}/move-files/check`, { folder: target });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      folder: target,
      files: 2,
      bytes: 8,
      neededBytes: 0,
      notManaged: 1,
      missing: 1,
      problem: null,
    });
    // Nothing touched.
    expect(existsSync(target)).toBe(false);
  });

  it("moves every managed file with its sidecar, then points the trip at the new folder", async () => {
    const a = await photo("Birds/Tern/Adjusted/a.jpg");
    const raw = await photo("Birds/Tern/RAW/a.NEF", { kind: "raw" });
    writeFileSync(path.join(oldRoot, "Birds/Tern/RAW/a.xmp"), "<x/>");
    const linked = await photo("Birds/Tern/Adjusted/mine.jpg", { managed: false });
    mkdirSync(path.join(oldRoot, ".lifer"));
    writeFileSync(path.join(oldRoot, ".lifer", "index.json"), "{}");

    const { res, status } = await move();
    expect(res.json()).toEqual({ started: true });
    expect(status.result).toMatchObject({ moved: 2, skipped: 1, missing: 0, failed: 0, folderUpdated: true });
    expect(await refOf(a)).toBe(path.join(target, "Birds/Tern/Adjusted/a.jpg"));
    expect(await refOf(raw)).toBe(path.join(target, "Birds/Tern/RAW/a.NEF"));
    expect(readFileSync(path.join(target, "Birds/Tern/Adjusted/a.jpg"), "utf8")).toBe(
      "photo Birds/Tern/Adjusted/a.jpg",
    );
    expect(existsSync(path.join(target, "Birds/Tern/RAW/a.xmp"))).toBe(true);
    expect(existsSync(path.join(target, ".lifer", "index.json"))).toBe(true);
    expect(existsSync(path.join(oldRoot, "Birds/Tern/Adjusted/a.jpg"))).toBe(false);
    expect(existsSync(path.join(oldRoot, "Birds/Tern/RAW"))).toBe(false);
    // The user's own file stays where it is.
    expect(await refOf(linked)).toBe(path.join(oldRoot, "Birds/Tern/Adjusted/mine.jpg"));
    expect(existsSync(await refOf(linked))).toBe(true);
    expect(await tripFolders()).toEqual({ source_folder: path.join(dir, "trip"), destination_folder: target });
  });

  it("moves the user's own linked files only when asked, keeping their place in the trip", async () => {
    const managed = await photo("Birds/a.jpg");
    const linked = await photo("Birds/mine.jpg", { managed: false });
    // A linked file in the trip's own folder, outside the wildlife folder.
    const sourceFile = path.join(dir, "trip", "Day 1", "own.jpg");
    mkdirSync(path.dirname(sourceFile), { recursive: true });
    writeFileSync(sourceFile, "own");
    const own = await photo("unused.jpg", { managed: false });
    await db.query(`UPDATE originals SET ref = $1 WHERE capture_id = $2`, [sourceFile, own]);

    const check = await post(`/trips/${tripId}/move-files/check`, { folder: target, includeLinked: true });
    expect(check.json()).toMatchObject({ files: 3, notManaged: 2 });

    const res = await post(`/trips/${tripId}/move-files`, { folder: target, includeLinked: true });
    expect(res.json()).toEqual({ started: true });
    const { tripFileMoveJob } = await import("./moveFiles.js");
    await tripFileMoveJob.settled();
    expect(tripFileMoveJob.status.result).toMatchObject({ moved: 3, linkedMoved: 2, skipped: 0, folderUpdated: true });
    expect(await refOf(managed)).toBe(path.join(target, "Birds/a.jpg"));
    expect(await refOf(linked)).toBe(path.join(target, "Birds/mine.jpg"));
    expect(await refOf(own)).toBe(path.join(target, "Day 1/own.jpg"));
    expect(readFileSync(path.join(target, "Day 1/own.jpg"), "utf8")).toBe("own");
    expect(existsSync(sourceFile)).toBe(false);
    // Still the user's own file, so Lifer won't delete it with the photo.
    const flags = await db.query(`SELECT managed FROM originals WHERE capture_id = ANY($1)`, [[linked, own]]);
    expect(flags.rows.every((r) => r.managed === false)).toBe(true);
  });

  it("never overwrites a file already there: the moved one takes a free name", async () => {
    const a = await photo("Birds/a.jpg", { bytes: "mine" });
    mkdirSync(path.join(target, "Birds"), { recursive: true });
    writeFileSync(path.join(target, "Birds/a.jpg"), "someone else's");
    const { status } = await move();
    expect(status.result).toMatchObject({ moved: 1, failed: 0 });
    expect(readFileSync(path.join(target, "Birds/a.jpg"), "utf8")).toBe("someone else's");
    expect(await refOf(a)).toBe(path.join(target, "Birds/a-2.jpg"));
    expect(readFileSync(path.join(target, "Birds/a-2.jpg"), "utf8")).toBe("mine");
  });

  it("reports a missing file and still moves the rest", async () => {
    const a = await photo("a.jpg");
    const gone = await photo("gone.jpg");
    rmSync(await refOf(gone));
    const { status } = await move();
    expect(status.result).toMatchObject({ moved: 1, missing: 1, folderUpdated: true });
    expect(status.result!.details).toEqual([{ file: path.join(oldRoot, "gone.jpg"), reason: "missing" }]);
    expect(await refOf(a)).toBe(path.join(target, "a.jpg"));
    expect(await refOf(gone)).toBe(path.join(oldRoot, "gone.jpg"));
  });

  it("copies across drives, keeps the file's dates, and leaves no partial files", async () => {
    fsControl.crossDrive = true;
    const a = await photo("Birds/a.jpg", { bytes: "x".repeat(70_000) });
    const old = new Date("2020-01-02T03:04:05Z");
    utimesSync(await refOf(a), old, old);
    const { status } = await move();
    expect(status.result).toMatchObject({ moved: 1, failed: 0 });
    const moved = path.join(target, "Birds/a.jpg");
    expect(await refOf(a)).toBe(moved);
    expect(statSync(moved).size).toBe(70_000);
    expect(statSync(moved).mtime.getTime()).toBe(old.getTime());
    expect(existsSync(path.join(oldRoot, "Birds/a.jpg"))).toBe(false);
    expect(existsSync(`${moved}.lifer-partial`)).toBe(false);
  });

  it("stops between files when cancelled: every file is either moved and recorded or untouched", async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await photo(`p${i}.jpg`));
    const { tripFileMoveJob } = await import("./moveFiles.js");
    let links = 0;
    fsControl.onLink = () => {
      if (++links === 2) tripFileMoveJob.cancel();
    };
    const { status } = await move();
    expect(status.cancelled).toBe(true);
    const refs = await Promise.all(ids.map(refOf));
    const movedCount = refs.filter((r) => r.startsWith(target)).length;
    expect(movedCount).toBe(2);
    for (const ref of refs) expect(existsSync(ref)).toBe(true);
    // Not every file moved, so the trip keeps its folder until the move is run again.
    expect((await tripFolders()).destination_folder).toBe(oldRoot);
    expect(existsSync(path.join(dir, "app", "trip-file-move.json"))).toBe(false);

    fsControl.onLink = null;
    const again = await move();
    expect(again.status.result).toMatchObject({ moved: 5, failed: 0, folderUpdated: true });
    for (const ref of await Promise.all(ids.map(refOf))) expect(ref.startsWith(target) && existsSync(ref)).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)("refuses a read-only folder before touching anything", async () => {
    const a = await photo("a.jpg");
    mkdirSync(target, { recursive: true });
    chmodSync(target, 0o555);
    try {
      const check = await post(`/trips/${tripId}/move-files/check`, { folder: target });
      expect(check.json()).toMatchObject({ problem: "read_only" });
      const { res } = await move();
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/can't save files in that folder/);
      expect(await refOf(a)).toBe(path.join(oldRoot, "a.jpg"));
      expect(existsSync(path.join(oldRoot, "a.jpg"))).toBe(true);
    } finally {
      chmodSync(target, 0o755);
    }
  });

  it("refuses a folder holding the trip's folder, and has nothing to do when all is already there", async () => {
    await photo("a.jpg");
    const own = await move(oldRoot);
    expect(own.res.statusCode).toBe(400);
    expect(own.res.json().error).toMatch(/^All of this trip's files are already in that folder/);
    const holder = await move(dir);
    expect(holder.res.statusCode).toBe(400);
    expect(holder.res.json().error).toBe(
      `That folder contains the trip's folder. You chose ${dir}. The trip's folder is ${path.join(dir, "trip")}.`,
    );
  });

  it("moves into the Wildlife folder Lifer made for a trip from a folder, picked through a symlinked Desktop", async () => {
    // The real layout: "Belize 2026" with its default Wildlife folder, photos elsewhere in it.
    const tripFolder = path.join(dir, "trip");
    const saved = await photo("../Birds/a.jpg");
    const own = await photo("../Day 1/own.jpg", { managed: false });
    const inside = await photo("Birds/c.jpg");
    rmSync(path.join(dir, "Desktop"), { force: true });
    symlinkSync(dir, path.join(dir, "Desktop"));
    const picked = path.join(dir, "Desktop", "trip", "Wildlife");

    const without = await post(`/trips/${tripId}/move-files/check`, { folder: picked });
    expect(without.json()).toMatchObject({ folder: oldRoot, files: 1, alreadyThere: 1, notManaged: 1, problem: null });

    const res = await post(`/trips/${tripId}/move-files`, { folder: picked, includeLinked: true });
    expect(res.statusCode).toBe(200);
    const { tripFileMoveJob } = await import("./moveFiles.js");
    await tripFileMoveJob.settled();
    expect(tripFileMoveJob.status.result).toMatchObject({ moved: 3, linkedMoved: 1, failed: 0, folderUpdated: true });
    expect(await refOf(saved)).toBe(path.join(oldRoot, "Birds/a.jpg"));
    expect(await refOf(own)).toBe(path.join(oldRoot, "Day 1/own.jpg"));
    expect(await refOf(inside)).toBe(path.join(oldRoot, "Birds/c.jpg"));
    expect(existsSync(path.join(tripFolder, "Birds/a.jpg"))).toBe(false);
    expect(await tripFolders()).toEqual({ source_folder: tripFolder, destination_folder: oldRoot });
  });

  it("moves a started trip's files into a Wildlife folder inside it and saves new photos there", async () => {
    const tripFolder = path.join(dir, "trip");
    await db.query(`UPDATE trips SET source_folder = $2, destination_folder = $2 WHERE id = $1`, [tripId, tripFolder]);
    // photo() puts files under <trip>/Wildlife, so "../" puts one at the trip folder's own level.
    const atRoot = await photo("../Birds/a.jpg");
    const inside = await photo("Birds/b.jpg");
    const wildlife = path.join(tripFolder, "Wildlife");
    // Picked in another case on a case-insensitive drive, it's still the same Wildlife folder.
    const picked = existsSync(path.join(tripFolder, "WILDLIFE")) ? path.join(tripFolder, "WILDLIFE") : wildlife;

    const check = await post(`/trips/${tripId}/move-files/check`, { folder: picked });
    expect(check.json()).toMatchObject({ folder: wildlife, files: 1, alreadyThere: 1, problem: null });
    const { status } = await move(picked);
    expect(status.result).toMatchObject({ moved: 2, failed: 0, folderUpdated: true });
    expect(await refOf(atRoot)).toBe(path.join(wildlife, "Birds/a.jpg"));
    expect(await refOf(inside)).toBe(path.join(wildlife, "Birds/b.jpg"));
    expect(existsSync(path.join(tripFolder, "Birds/a.jpg"))).toBe(false);
    expect(existsSync(path.join(wildlife, "Wildlife"))).toBe(false);
    // New photos go to Wildlife; Lifer still looks in the whole trip folder for them.
    expect(await tripFolders()).toEqual({ source_folder: tripFolder, destination_folder: wildlife });
  });

  it("refuses the trip's own folder spelled in another case, and deletes nothing", async () => {
    const a = await photo("a.jpg");
    const otherCase = path.join(path.dirname(oldRoot), "WILDLIFE");
    // Only a case-insensitive drive (macOS and Windows by default) has the alias.
    if (!existsSync(otherCase)) return;
    const { res } = await move(otherCase);
    expect(res.statusCode).toBe(400);
    expect(existsSync(await refOf(a))).toBe(true);
  });

  it("picks up a move cut short, reusing a copy already placed instead of making a duplicate", async () => {
    const a = await photo("Birds/a.jpg");
    const b = await photo("Birds/b.jpg");
    // As if the app quit after placing a.jpg but before recording it.
    mkdirSync(path.join(target, "Birds"), { recursive: true });
    linkSync(path.join(oldRoot, "Birds/a.jpg"), path.join(target, "Birds/a.jpg"));
    writeFileSync(
      path.join(dir, "app", "trip-file-move.json"),
      JSON.stringify({ userId: USER, tripId, folder: target }),
    );
    const { resumeTripFileMove, tripFileMoveJob } = await import("./moveFiles.js");
    await resumeTripFileMove();
    await tripFileMoveJob.settled();
    expect(tripFileMoveJob.status.result).toMatchObject({ moved: 2, failed: 0, folderUpdated: true });
    expect(await refOf(a)).toBe(path.join(target, "Birds/a.jpg"));
    expect(await refOf(b)).toBe(path.join(target, "Birds/b.jpg"));
    expect(existsSync(path.join(target, "Birds/a-2.jpg"))).toBe(false);
    expect(existsSync(path.join(dir, "app", "trip-file-move.json"))).toBe(false);
  });

  it("drops a leftover journal when the trip already uses the new folder", async () => {
    mkdirSync(target, { recursive: true });
    await db.query(`UPDATE trips SET destination_folder = $2 WHERE id = $1`, [tripId, target]);
    const journal = path.join(dir, "app", "trip-file-move.json");
    writeFileSync(journal, JSON.stringify({ userId: USER, tripId, folder: target }));
    const { resumeTripFileMove, tripFileMoveJob } = await import("./moveFiles.js");
    const finishedBefore = tripFileMoveJob.status.finishedAt;
    await resumeTripFileMove();
    expect(tripFileMoveJob.status.running).toBe(false);
    expect(tripFileMoveJob.status.finishedAt).toBe(finishedBefore);
    expect(existsSync(journal)).toBe(false);
  });

  it("points at a folder the user moved, relinking only files that are really there", async () => {
    const a = await photo("Birds/a.jpg", { bytes: "aaaa" });
    const b = await photo("Birds/b.jpg", { bytes: "bbbb" });
    const c = await photo("Birds/c.jpg", { bytes: "cccc" });
    mkdirSync(path.dirname(target), { recursive: true });
    renameSync(oldRoot, target);
    rmSync(path.join(target, "Birds/b.jpg"));
    writeFileSync(path.join(target, "Birds/c.jpg"), "changed size");

    const check = await post(`/trips/${tripId}/relink`, { folder: target });
    expect(check.json()).toMatchObject({ total: 3, found: 1, missing: 1, sizeDiffers: 1, applied: false });
    expect(await refOf(a)).toBe(path.join(oldRoot, "Birds/a.jpg"));

    const applied = await post(`/trips/${tripId}/relink`, { folder: target, apply: true });
    expect(applied.json()).toMatchObject({ found: 1, applied: true });
    expect(await refOf(a)).toBe(path.join(target, "Birds/a.jpg"));
    expect(await refOf(b)).toBe(path.join(oldRoot, "Birds/b.jpg"));
    expect(await refOf(c)).toBe(path.join(oldRoot, "Birds/c.jpg"));
    expect((await tripFolders()).destination_folder).toBe(target);
  });

  it("won't point at a folder holding none of the trip's photos", async () => {
    await photo("a.jpg");
    mkdirSync(target, { recursive: true });
    const res = await post(`/trips/${tripId}/relink`, { folder: target, apply: true });
    expect(res.statusCode).toBe(400);
    expect((await tripFolders()).destination_folder).toBe(oldRoot);
  });
});
