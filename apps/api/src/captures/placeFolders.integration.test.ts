// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test npx vitest run placeFolders
// With place folders in the layout, renaming, merging or removing a place name, or changing a
// photo's region, moves its managed files to the matching Country/Province/Place folder, hidden
// photos included, and writes the new name into the files.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000881";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000882";
const as = vi.hoisted(() => ({ id: "" }));

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: as.id, email: "place-folders@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

describe.skipIf(!url)("place name folders", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dir: string;
  let lib: string;
  let country: string;
  let province: string;
  let n = 0;
  const region = { country: "Zzpf Canada", province: "Zzpf Alberta" };
  const folder = (...levels: string[]) => path.join(lib, ...levels, "Birds", "Pf Plover", "Adjusted");

  async function cleanup() {
    await db.query(`DELETE FROM originals WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`DELETE FROM regions WHERE name LIKE 'Zzpf %'`);
  }

  async function photo(file: string, label: string | null, opts: { hidden?: boolean; trashed?: boolean } = {}) {
    mkdirSync(path.dirname(file), { recursive: true });
    await sharp({ create: { width: 16, height: 16, channels: 3, background: "#579" } })
      .jpeg()
      .toFile(file);
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at, location_label, region_id, hidden_at, deleted_at)
       VALUES ($1, $2, $3, '2024-06-01T12:00:00Z', $4, $5, $6, $7) RETURNING id`,
      [USER, SPECIES, `pf-${n++}`, label, province, opts.hidden ? new Date() : null, opts.trashed ? new Date() : null],
    );
    await db.query(
      `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size, user_id)
       VALUES ($1, 'jpeg', 'path', $2, true, $3, 1, $4)`,
      [c.rows[0].id, file, `pf-hash-${n}`, USER],
    );
    return c.rows[0].id;
  }

  const refOf = async (captureId: string) =>
    (await db.query<{ ref: string }>(`SELECT ref FROM originals WHERE capture_id = $1`, [captureId])).rows[0].ref;
  const send = async (method: "POST" | "PATCH", url: string, payload: object) => {
    as.id = USER;
    const res = await app.inject({ method, url: `/api${url}`, payload });
    const { refileJob } = await import("../uploads/reorganizeOriginals.js");
    await refileJob.settled();
    return res;
  };
  const sublocation = async (file: string) => {
    const { extractLocationLabel, readExifTags } = await import("../uploads/exif.js");
    return extractLocationLabel(await readExifTags(file));
  };

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "lifer-place-folders-")));
    lib = path.join(dir, "lib");
    mkdirSync(lib, { recursive: true });
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = lib;
    process.env.APP_DATA_DIR = path.join(dir, "app");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(
      `INSERT INTO users (id, email, password_hash, folder_layout) VALUES ($1, 'place-folders@test', 'x', '{country,province,place,group,species}')`,
      [USER],
    );
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 918881, 'Placea folderis', 'Pf Plover', 'aves')`,
      [SPECIES],
    );
    const insert = async (name: string, parent: string | null, code: string | null, home: string | null = null) =>
      (
        await db.query<{ id: string }>(
          `INSERT INTO regions (name, parent_id, ebird_region_code, home_country_id) VALUES ($1, $2, $3, $4) RETURNING id`,
          [name, parent, code, home],
        )
      ).rows[0].id;
    // The province is shown under its continent: home_country_id still puts it in its country.
    const continent = await insert("Zzpf North America", null, null);
    country = await insert(region.country, continent, "ZQ");
    province = await insert(region.province, continent, "ZQ-AB", country);
    const { captureRoutes } = await import("./routes.js");
    app = Fastify();
    await app.register(captureRoutes, { prefix: "/api" });
    await app.ready();
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM originals WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    rmSync(lib, { recursive: true, force: true });
    mkdirSync(lib, { recursive: true });
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

  it("moves a renamed place's files, hidden ones too, into the new folder and writes the name in", async () => {
    const old = folder(region.country, region.province, "Pigeon Lake");
    const live = await photo(path.join(old, "a.jpg"), "Pigeon Lake");
    const hidden = await photo(path.join(old, "b.jpg"), "Pigeon Lake", { hidden: true });
    const trashed = await photo(path.join(old, "c.jpg"), "Pigeon Lake", { trashed: true });

    const res = await send("POST", "/places/rename", { from: "Pigeon Lake", to: "Sylvan Lake" });
    expect(res.json()).toEqual({ updated: 2, movingFiles: true });
    const now = folder(region.country, region.province, "Sylvan Lake");
    expect([await refOf(live), await refOf(hidden)]).toEqual([path.join(now, "a.jpg"), path.join(now, "b.jpg")]);
    expect(existsSync(path.join(now, "a.jpg")) && existsSync(path.join(now, "b.jpg"))).toBe(true);
    expect(await sublocation(path.join(now, "b.jpg"))).toBe("Sylvan Lake");
    // The trashed photo stays where it was, with its old name.
    expect(await refOf(trashed)).toBe(path.join(old, "c.jpg"));

    const { refileJob } = await import("../uploads/reorganizeOriginals.js");
    expect(refileJob.status).toMatchObject({ moved: 2, failed: 0 });
  });

  it("moves a removed place's files back out of its folder, never over another file", async () => {
    const old = folder(region.country, region.province, "Pigeon Lake");
    const a = await photo(path.join(old, "a.jpg"), "Pigeon Lake");
    const b = await photo(path.join(old, "b.jpg"), "Pigeon Lake");
    // Something already sits where b would go.
    const out = folder(region.country, region.province);
    mkdirSync(out, { recursive: true });
    await sharp({ create: { width: 4, height: 4, channels: 3, background: "#000" } })
      .jpeg()
      .toFile(path.join(out, "b.jpg"));
    const before = readFileSync(path.join(out, "b.jpg"));

    expect((await send("POST", "/places/remove", { name: "Pigeon Lake" })).json()).toEqual({
      updated: 2,
      movingFiles: true,
    });
    expect(await refOf(a)).toBe(path.join(out, "a.jpg"));
    expect(await refOf(b)).toBe(path.join(old, "b.jpg"));
    expect(readFileSync(path.join(out, "b.jpg")).equals(before)).toBe(true);
    expect(await sublocation(path.join(out, "a.jpg"))).toBeNull();
  });

  it("shows a layout's example on one of the user's own recent photos", async () => {
    await photo(path.join(folder(region.country, region.province, "Pigeon Lake"), "IMG_1.jpg"), "Pigeon Lake");
    const { folderLayoutExample } = await import("../uploads/managedFolders.js");
    expect(await folderLayoutExample(USER, ["country", "place", "year", "species"])).toEqual({
      path: path.join(region.country, "Pigeon Lake", "2024", "Pf Plover", "Adjusted", "IMG_1.jpg"),
      sample: false,
    });
  });

  it("follows a region change to the country's folder", async () => {
    const c = await photo(path.join(folder(region.country, region.province, "Pigeon Lake"), "a.jpg"), "Pigeon Lake");
    expect((await send("PATCH", `/captures/${c}/region`, { regionId: country })).statusCode).toBe(200);
    expect(await refOf(c)).toBe(path.join(folder(region.country, "Pigeon Lake"), "a.jpg"));
  });
});
