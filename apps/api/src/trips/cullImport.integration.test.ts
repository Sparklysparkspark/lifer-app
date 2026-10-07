// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55470/lifer npx vitest run trips/cullImport
// Culling marks at trip import: the scan counts what a culling app rejected and picked (in the
// file or its sidecar), and the import skips, hides or ignores rejected photos as asked, never
// touching the source files. Hidden photos stay out of the `captures` view and the life list
// until unhidden, and a rescan doesn't offer them again.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import sharp from "sharp";
import { ExifTool } from "exiftool-vendored";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000731";
const TOKEN = "lifer_test_cull_import_owner_731";
const KEPT_SPECIES = "eeeeeeee-0000-4000-8000-000000000732";
const REJECTED_SPECIES = "eeeeeeee-0000-4000-8000-000000000733";
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "../uploads/__fixtures__/cull");

type Option = "skip" | "hide" | "ignore";
interface ImportStatus {
  running: boolean;
  finishedAt: number | null;
  error: string | null;
  result: { imported: number; failed: number; skipped: number; hidden: number } | null;
  results: Array<{ relativePath: string; captureId?: string; error?: string; skipped?: string; hidden?: boolean }>;
}

describe.skipIf(!url)("culling marks at trip import", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName: string;
  const writer = new ExifTool();

  const call = (method: "GET" | "POST", route: string, payload?: unknown) =>
    app.inject({ method, url: route, payload: payload as object, cookies: { [cookieName]: TOKEN } });

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM trips WHERE user_id = $1`, [USER]);
    await db.query(`UPDATE captures_all SET current_photo_id = NULL WHERE user_id = $1`, [USER]);
    await db.query(
      `DELETE FROM originals WHERE user_id = $1 OR capture_id IN (SELECT id FROM captures_all WHERE user_id = $1)`,
      [USER],
    );
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = ANY($1::uuid[])`, [[KEPT_SPECIES, REJECTED_SPECIES]]);
  }

  async function waitFor<T extends { running: boolean; finishedAt: number | null }>(route: string): Promise<T> {
    for (let i = 0; i < 200; i++) {
      const status = (await call("GET", route)).json() as T;
      if (!status.running && status.finishedAt) return status;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${route} didn't finish`);
  }

  /** A trip folder with four photos: one unmarked, one rejected inside the file (xmp:Rating -1),
   *  one rejected in a Lightroom Classic sidecar, and one picked in a sidecar. `tint` keeps each
   *  folder's photos distinct by content, since a file already imported isn't offered again. */
  async function tripFolder(name: string, tint: number): Promise<{ id: string; folder: string }> {
    const folder = path.join(dataDir, name);
    mkdirSync(folder);
    const files = ["kept.jpg", "rejected.jpg", "flagged.jpg", "picked.jpg"];
    for (const [i, file] of files.entries()) {
      await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: tint, g: i * 40, b: 90 } } })
        .withExif({
          IFD0: { Make: "Lifer", Model: "Cull Test" },
          IFD2: { DateTimeOriginal: `2024:05:0${i + 1} 12:00:00` },
        })
        .jpeg()
        .toFile(path.join(folder, file));
    }
    await writer.write(path.join(folder, "rejected.jpg"), { "XMP-xmp:Rating": -1 } as never, {
      writeArgs: ["-overwrite_original"],
    });
    copyFileSync(path.join(FIXTURES, "lightroom-classic-reject.xmp"), path.join(folder, "flagged.xmp"));
    copyFileSync(path.join(FIXTURES, "lightroom-classic-pick.xmp"), path.join(folder, "picked.xmp"));
    const created = await call("POST", "/api/trips", {
      name,
      sourceFolder: folder,
      destinationFolder: path.join(folder, "Wildlife"),
    });
    expect(created.statusCode).toBe(201);
    return { id: created.json().id, folder };
  }

  async function scan(tripId: string) {
    expect((await call("POST", `/api/trips/${tripId}/scan`)).statusCode).toBe(200);
    return waitFor<{
      running: boolean;
      finishedAt: number | null;
      error: string | null;
      newFiles: Array<{ relativePath: string; cull: { verdict: string | null; label: string | null } }>;
      cullRejected: number;
      cullPicked: number;
    }>(`/api/trips/${tripId}/scan/status`);
  }

  async function importAll(tripId: string, cullMarks?: Option): Promise<ImportStatus> {
    const speciesFor = (file: string) =>
      file === "rejected.jpg" || file === "flagged.jpg" ? REJECTED_SPECIES : KEPT_SPECIES;
    const files = ["kept.jpg", "rejected.jpg", "flagged.jpg", "picked.jpg"].map((f) => ({
      relativePath: f,
      speciesId: speciesFor(f),
    }));
    const res = await call("POST", `/api/trips/${tripId}/import`, { files, ...(cullMarks ? { cullMarks } : {}) });
    expect(res.statusCode).toBe(200);
    const status = await waitFor<ImportStatus>(`/api/trips/${tripId}/import/status`);
    expect(status.error).toBeNull();
    return status;
  }

  const byFile = (status: ImportStatus) => Object.fromEntries(status.results.map((r) => [r.relativePath, r]));
  const visibleCaptures = async (tripId: string) =>
    (await db.query(`SELECT id FROM captures WHERE trip_id = $1`, [tripId])).rowCount ?? 0;
  const collected = async (speciesId: string) =>
    (await db.query(`SELECT state FROM user_species WHERE user_id = $1 AND species_id = $2`, [USER, speciesId])).rows[0]
      ?.state ?? null;

  beforeAll(async () => {
    dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "lifer-cull-import-")));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { tripsRoutes } = await import("./routes.js");
    const { hiddenCaptureRoutes } = await import("../captures/hidden.js");

    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'cull-import@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 920731, 'Testus servatus', 'Kept Bird', 'aves'), ($2, 920732, 'Testus rejectus', 'Rejected Bird', 'aves')`,
      [KEPT_SPECIES, REJECTED_SPECIES],
    );

    app = Fastify();
    await app.register(cookie);
    await app.register(tripsRoutes, { prefix: "/api" });
    await app.register(hiddenCaptureRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await writer.end();
    if (db) {
      await cleanup();
      await db.end();
    }
    const { closeExiftool } = await import("../uploads/exif.js");
    await closeExiftool();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("counts rejected and picked photos at scan time, from the file and its sidecar", async () => {
    const { id } = await tripFolder("Scan counts", 10);
    const status = await scan(id);
    expect(status.error).toBeNull();
    expect(status.cullRejected).toBe(2);
    expect(status.cullPicked).toBe(1);
    const cull = Object.fromEntries(status.newFiles.map((f) => [f.relativePath, f.cull]));
    expect(cull).toStrictEqual({
      "kept.jpg": { verdict: null, label: null },
      "rejected.jpg": { verdict: "reject", label: null },
      "flagged.jpg": { verdict: "reject", label: "red" },
      "picked.jpg": { verdict: "pick", label: "green" },
    });
  });

  it("skips rejected photos by default, copying nothing and leaving the source files as they were", async () => {
    const { id, folder } = await tripFolder("Skip", 60);
    const before = Object.fromEntries(
      readdirSync(folder)
        .filter((f) => f !== "Wildlife")
        .map((f) => [f, readFileSync(path.join(folder, f))]),
    );
    await scan(id);
    const status = await importAll(id);
    expect(status.result).toStrictEqual({ imported: 2, failed: 0, skipped: 2, hidden: 0 });
    const results = byFile(status);
    expect(results["rejected.jpg"]).toStrictEqual({ relativePath: "rejected.jpg", skipped: "rejected" });
    expect(results["flagged.jpg"]).toStrictEqual({ relativePath: "flagged.jpg", skipped: "rejected" });
    expect(results["picked.jpg"].captureId).toBeTruthy();

    // Only the two kept photos were copied into the destination.
    const copies = (
      await db.query<{ ref: string }>(
        `SELECT o.ref FROM originals o JOIN captures c ON c.id = o.capture_id WHERE c.trip_id = $1`,
        [id],
      )
    ).rows;
    expect(copies.map((c) => path.basename(c.ref)).sort()).toEqual(["kept.jpg", "picked.jpg"]);
    for (const [file, bytes] of Object.entries(before))
      expect(readFileSync(path.join(folder, file)).equals(bytes)).toBe(true);

    // The pick and label are kept on the imported photo.
    const picked = await db.query(`SELECT cull_verdict, cull_label, hidden_at FROM captures_all WHERE id = $1`, [
      results["picked.jpg"].captureId,
    ]);
    expect(picked.rows[0]).toStrictEqual({ cull_verdict: "pick", cull_label: "green", hidden_at: null });
    expect(await collected(REJECTED_SPECIES)).toBeNull();

    // A rescan offers the skipped photos again (still marked), and not the imported ones.
    const rescan = await scan(id);
    expect(rescan.newFiles.map((f) => f.relativePath).sort()).toEqual(["flagged.jpg", "rejected.jpg"]);
    expect(rescan.cullRejected).toBe(2);
  });

  it("imports rejected photos hidden: out of the captures view and the life list until unhidden", async () => {
    const { id } = await tripFolder("Hide", 110);
    await scan(id);
    const status = await importAll(id, "hide");
    expect(status.result).toStrictEqual({ imported: 4, failed: 0, skipped: 0, hidden: 2 });
    const results = byFile(status);
    expect(results["flagged.jpg"].hidden).toBe(true);
    expect(results["kept.jpg"].hidden).toBeUndefined();

    expect(await visibleCaptures(id)).toBe(2);
    const hidden = await db.query(
      `SELECT cull_verdict, cull_label FROM captures_all WHERE trip_id = $1 AND hidden_at IS NOT NULL ORDER BY cull_label NULLS FIRST`,
      [id],
    );
    expect(hidden.rows).toStrictEqual([
      { cull_verdict: "reject", cull_label: null },
      { cull_verdict: "reject", cull_label: "red" },
    ]);
    // Only hidden photos show this species, so it isn't on the life list yet.
    expect(await collected(REJECTED_SPECIES)).toBeNull();
    expect(await collected(KEPT_SPECIES)).toBe("collected");
    expect((await call("GET", "/api/captures/hidden-count")).json()).toStrictEqual({ count: 2 });

    // A rescan treats hidden photos as imported.
    expect((await scan(id)).newFiles).toEqual([]);

    const unhide = await call("POST", "/api/captures/unhide", { captureIds: [results["flagged.jpg"].captureId] });
    expect(unhide.json()).toStrictEqual({ unhidden: 1 });
    expect(await visibleCaptures(id)).toBe(3);
    expect(await collected(REJECTED_SPECIES)).toBe("collected");
    // Unhiding again changes nothing; the verdict stays as the culling app left it.
    expect(
      (await call("POST", "/api/captures/unhide", { captureIds: [results["flagged.jpg"].captureId] })).json(),
    ).toStrictEqual({ unhidden: 0 });
    const after = await db.query(`SELECT cull_verdict FROM captures WHERE id = $1`, [results["flagged.jpg"].captureId]);
    expect(after.rows[0].cull_verdict).toBe("reject");
  });

  it("imports rejected photos like any other when told to ignore the marks, keeping the marks", async () => {
    const { id } = await tripFolder("Ignore", 160);
    await scan(id);
    const status = await importAll(id, "ignore");
    expect(status.result).toStrictEqual({ imported: 4, failed: 0, skipped: 0, hidden: 0 });
    expect(await visibleCaptures(id)).toBe(4);
    const verdicts = await db.query(
      `SELECT cull_verdict, count(*)::int AS n FROM captures WHERE trip_id = $1 GROUP BY 1 ORDER BY 1 NULLS FIRST`,
      [id],
    );
    expect(verdicts.rows).toStrictEqual([
      { cull_verdict: null, n: 1 },
      { cull_verdict: "pick", n: 1 },
      { cull_verdict: "reject", n: 2 },
    ]);
  });

  it("refuses an unknown option", async () => {
    const { id } = await tripFolder("Bad option", 200);
    const res = await call("POST", `/api/trips/${id}/import`, {
      files: [{ relativePath: "kept.jpg", speciesId: KEPT_SPECIES }],
      cullMarks: "delete",
    });
    expect(res.statusCode).toBe(400);
  });
});
