// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test npx vitest run startTrip
// Starting a trip ahead of its photos, its dates and active choice, the photos suggested for it,
// and a photo's files following it into and out of a trip folder on another root.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000991";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000992";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "start-trip@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

describe.skipIf(!url)("starting a trip", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dir: string;
  let lib: string;
  let nas: string;
  let n = 0;
  const speciesFolder = (root: string) => path.join(root, "Birds", "St Plover", "Adjusted");

  const call = async (method: "GET" | "POST" | "PATCH", route: string, payload?: object) => {
    const res = await app.inject({ method, url: `/api${route}`, payload });
    const { refileJob } = await import("../uploads/reorganizeOriginals.js");
    await refileJob.settled();
    return res;
  };
  const start = async (body: object) =>
    (await call("POST", "/trips/start", body)).json() as { id: string; folder: string };
  const refOf = async (captureId: string) =>
    (await db.query<{ ref: string }>(`SELECT ref FROM originals WHERE capture_id = $1`, [captureId])).rows[0].ref;

  async function photo(file: string, takenAt: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#579" } })
      .jpeg()
      .toFile(file);
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at) VALUES ($1, $2, $3, $4) RETURNING id`,
      [USER, SPECIES, `st-${n++}`, takenAt],
    );
    await db.query(
      `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size, user_id)
       VALUES ($1, 'jpeg', 'path', $2, true, $3, 1, $4)`,
      [c.rows[0].id, file, `st-hash-${n}`, USER],
    );
    return c.rows[0].id;
  }

  async function cleanup() {
    await db.query(`DELETE FROM originals WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM trips WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
  }

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "lifer-start-trip-")));
    lib = path.join(dir, "lib");
    nas = path.join(dir, "nas");
    mkdirSync(lib, { recursive: true });
    mkdirSync(nas, { recursive: true });
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = lib;
    process.env.APP_DATA_DIR = path.join(dir, "app");
    process.env.LIFER_LIBRARY_ROOTS = `NAS=${nas}`;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(
      `INSERT INTO users (id, email, password_hash, folder_layout) VALUES ($1, 'start-trip@test', 'x', '{group,species}')`,
      [USER],
    );
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 918991, 'Startia tripis', 'St Plover', 'aves')`,
      [SPECIES],
    );
    const { tripsRoutes } = await import("./routes.js");
    app = Fastify();
    await app.register(tripsRoutes, { prefix: "/api" });
    await app.ready();
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM originals WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM trips WHERE user_id = $1`, [USER]);
    rmSync(path.join(lib, "Birds"), { recursive: true, force: true });
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

  it("starts a trip in the library's Trips folder, or in a folder on another root Lifer may use", async () => {
    const own = await start({ name: "Costa Rica 2026", startDate: "2026-05-03" });
    expect(own.folder).toBe(path.join(lib, "Trips", "Costa Rica 2026"));
    expect(existsSync(own.folder)).toBe(true);

    const onNas = await start({
      name: "Peru",
      startDate: "2026-07-01",
      endDate: "2026-07-14",
      folder: path.join(nas, "Peru"),
    });
    expect(onNas.folder).toBe(path.join(nas, "Peru"));
    expect(existsSync(onNas.folder)).toBe(true);

    const outside = await call("POST", "/trips/start", {
      name: "X",
      startDate: "2026-01-01",
      folder: path.join(dir, "elsewhere", "X"),
    });
    expect(outside.statusCode).toBe(403);
    const backwards = await call("POST", "/trips/start", { name: "Y", startDate: "2026-05-03", endDate: "2026-05-01" });
    expect([backwards.statusCode, backwards.json().error]).toEqual([
      400,
      "The end date can't be before the start date",
    ]);

    const listed = (await call("GET", "/trips")).json().trips;
    expect(listed.find((t: { id: string }) => t.id === onNas.id)).toMatchObject({
      startDate: "2026-07-01",
      endDate: "2026-07-14",
      regionId: null,
      activeOverride: null,
    });
  });

  it("ends a trip or marks it inactive", async () => {
    const { id } = await start({ name: "Alberta", startDate: "2026-05-03" });
    expect((await call("PATCH", `/trips/${id}`, { endDate: "2026-05-10", activeOverride: false })).statusCode).toBe(
      200,
    );
    expect((await call("GET", `/trips/${id}`)).json()).toMatchObject({ endDate: "2026-05-10", activeOverride: false });
    // A field left out stays as it was.
    await call("PATCH", `/trips/${id}`, { activeOverride: null });
    expect((await call("GET", `/trips/${id}`)).json()).toMatchObject({ endDate: "2026-05-10", activeOverride: null });
  });

  it("suggests photos taken during the trip, never adds them, and keeps dismissed ones dismissed", async () => {
    const { id } = await start({ name: "Osa", startDate: "2026-05-03", endDate: "2026-05-10" });
    const during = await photo(path.join(speciesFolder(lib), "a.jpg"), "2026-05-04T12:00:00Z");
    const dismissed = await photo(path.join(speciesFolder(lib), "b.jpg"), "2026-05-09T12:00:00Z");
    const after = await photo(path.join(speciesFolder(lib), "c.jpg"), "2026-06-01T12:00:00Z");

    const ids = async () =>
      (await call("GET", `/trips/${id}/suggestions`)).json().items.map((i: { captureId: string }) => i.captureId);
    expect(await ids()).toEqual([during, dismissed]);
    expect((await db.query(`SELECT count(*)::int AS n FROM captures WHERE trip_id = $1`, [id])).rows[0].n).toBe(0);

    await call("POST", `/trips/${id}/suggestions/dismiss`, { captureIds: [dismissed] });
    expect(await ids()).toEqual([during]);
    expect((await call("POST", "/trips/matching", { captureIds: [during, dismissed, after] })).json()).toEqual({
      trips: [{ id, name: "Osa", count: 1 }],
    });
  });

  it("suggests photos whose day falls within the trip's dates in some time zone", async () => {
    const { id } = await start({ name: "Kauai", startDate: "2026-08-03", endDate: "2026-08-10" });
    // Aug 3 at 1am in UTC+13, and Aug 10 at 7pm in Hawaii.
    const earlyLocal = await photo(path.join(speciesFolder(lib), "d.jpg"), "2026-08-02T12:00:00Z");
    const lateLocal = await photo(path.join(speciesFolder(lib), "e.jpg"), "2026-08-11T05:00:00Z");
    await photo(path.join(speciesFolder(lib), "f.jpg"), "2026-08-01T12:00:00Z");
    await photo(path.join(speciesFolder(lib), "g.jpg"), "2026-08-12T00:00:00Z");
    const items = (await call("GET", `/trips/${id}/suggestions`)).json().items;
    expect(items.map((i: { captureId: string }) => i.captureId)).toEqual([earlyLocal, lateLocal]);
  });

  it("moves a photo's files into its trip's folder on another root, and back out when it leaves", async () => {
    const { id, folder } = await start({ name: "Peru", startDate: "2026-07-01", folder: path.join(nas, "Peru") });
    const a = await photo(path.join(speciesFolder(lib), "a.jpg"), "2026-07-02T12:00:00Z");

    expect((await call("POST", `/trips/${id}/captures`, { captureIds: [a] })).json()).toEqual({
      changed: 1,
      movingFiles: true,
    });
    expect(await refOf(a)).toBe(path.join(speciesFolder(folder), "a.jpg"));
    expect(existsSync(path.join(speciesFolder(folder), "a.jpg"))).toBe(true);
    // The emptied library folders are tidied away.
    expect(existsSync(path.join(lib, "Birds"))).toBe(false);

    expect((await call("POST", `/trips/${id}/captures/remove`, { captureIds: [a] })).json()).toEqual({
      changed: 1,
      movingFiles: true,
    });
    expect(await refOf(a)).toBe(path.join(speciesFolder(lib), "a.jpg"));
    expect(existsSync(path.join(speciesFolder(lib), "a.jpg"))).toBe(true);
    expect(existsSync(path.join(folder, "Birds"))).toBe(false);
  });

  it("never moves a file over another one already in the trip's folder", async () => {
    const { id, folder } = await start({ name: "Chile", startDate: "2026-07-01", folder: path.join(nas, "Chile") });
    const a = await photo(path.join(speciesFolder(lib), "a.jpg"), "2026-07-02T12:00:00Z");
    mkdirSync(speciesFolder(folder), { recursive: true });
    writeFileSync(path.join(speciesFolder(folder), "a.jpg"), "someone else's");

    await call("POST", `/trips/${id}/captures`, { captureIds: [a] });
    expect(await refOf(a)).toBe(path.join(speciesFolder(lib), "a.jpg"));
    expect(readFileSync(path.join(speciesFolder(folder), "a.jpg"), "utf8")).toBe("someone else's");
  });
});
