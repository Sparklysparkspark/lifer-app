// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test npx vitest run autoCovers
// A cover Lifer picked itself that shows a RAW's preview moves to the user's edit once one exists;
// a cover the user chose never moves.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000a01";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000a0a";
const SPECIES_B = "eeeeeeee-0000-4000-8000-000000000a0b";
const TOKEN = "lifer_test_auto_covers_a01";

describe.skipIf(!url)("automatic covers prefer an edit over a RAW's preview", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName: string;
  let tripId: string;
  let lib: typeof import("./autoCovers.js");
  let crop: typeof import("../collection/defaultCardCrop.js");

  const call = (method: "GET" | "POST" | "PATCH", route: string, payload?: unknown) =>
    app.inject({ method, url: route, payload: payload as object, cookies: { [cookieName]: TOKEN } });

  // A capture with one file: a RAW shows its embedded preview, a JPEG is an edit.
  async function addCapture(species: string, kind: "raw" | "jpeg", rating: number | null, name: string) {
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures (user_id, species_id, fingerprint, quality_rating, trip_id, taken_at)
       VALUES ($1, $2, $3, $4, $5, now()) RETURNING id`,
      [USER, species, `auto-covers-${name}`, rating, tripId],
    );
    const p = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
      [c.rows[0].id],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
    await db.query(
      `INSERT INTO originals (user_id, capture_id, kind, ref_type, ref, managed, content_hash, file_size)
       VALUES ($1, $2, $3, 'path', $4, false, $5, 1000)`,
      [USER, c.rows[0].id, kind, `/nowhere/${name}.${kind === "raw" ? "CR3" : "jpg"}`, `auto-covers-hash-${name}`],
    );
    return { capture: c.rows[0].id, photo: p.rows[0].id };
  }

  const speciesRow = async (species = SPECIES) =>
    (
      await db.query<{ cover_photo_id: string | null; card_crop_x: string | null }>(
        `SELECT cover_photo_id, card_crop_x FROM user_species WHERE user_id = $1 AND species_id = $2`,
        [USER, species],
      )
    ).rows[0];

  const setSpeciesCover = (photoId: string, chosen: string | null, species = SPECIES) =>
    db.query(
      `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, cover_chosen_photo_id, card_crop_x, card_crop_y, card_crop_size)
       VALUES ($1, $2, 'collected', $3, $4, 10, 10, 50)
       ON CONFLICT (user_id, species_id) DO UPDATE SET cover_photo_id = $3, cover_chosen_photo_id = $4,
         card_crop_x = 10, card_crop_y = 10, card_crop_size = 50`,
      [USER, species, photoId, chosen],
    );

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM albums WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM capture_versions WHERE user_id = $1`, [USER]);
    await db.query(`UPDATE captures_all SET current_photo_id = NULL WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM trips WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = ANY($1::uuid[])`, [[SPECIES, SPECIES_B]]);
  }

  // rawBest: 5 stars but only a RAW. editEarly and editLate: 2-star edits, imported in that order.
  // trashed and hidden: 5-star edits nobody can see.
  let rawBest: { capture: string; photo: string };
  let editEarly: { capture: string; photo: string };

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-auto-covers-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    lib = await import("./autoCovers.js");
    crop = await import("../collection/defaultCardCrop.js");
    const { albumRoutes } = await import("../albums/routes.js");
    const { tripsRoutes } = await import("../trips/routes.js");

    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'auto-covers@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 920801, 'Testus autocoverus', 'Auto Cover Bird', 'aves'),
              ($2, 920802, 'Testus versionus', 'Version Bird', 'aves')`,
      [SPECIES, SPECIES_B],
    );
    tripId = (
      await db.query<{ id: string }>(
        `INSERT INTO trips (user_id, name, source_folder, destination_folder) VALUES ($1, 'Marsh', '/nowhere', '/nowhere') RETURNING id`,
        [USER],
      )
    ).rows[0].id;

    rawBest = await addCapture(SPECIES, "raw", 5, "raw-best");
    editEarly = await addCapture(SPECIES, "jpeg", 2, "edit-early");
    await db.query(`UPDATE captures_all SET created_at = now() - interval '1 hour' WHERE id = $1`, [editEarly.capture]);
    await addCapture(SPECIES, "jpeg", 2, "edit-late");
    const trashed = await addCapture(SPECIES, "jpeg", 5, "trashed");
    await db.query(`UPDATE captures_all SET deleted_at = now() WHERE id = $1`, [trashed.capture]);
    const hidden = await addCapture(SPECIES, "jpeg", 5, "hidden");
    await db.query(`UPDATE captures_all SET hidden_at = now() WHERE id = $1`, [hidden.capture]);

    app = Fastify();
    await app.register(cookie);
    await app.register(albumRoutes, { prefix: "/api" });
    await app.register(tripsRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await cleanup();
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM albums WHERE user_id = $1`, [USER]);
  });

  it("moves an automatic RAW cover to the highest rated, first imported visible edit, once", async () => {
    await setSpeciesCover(rawBest.photo, null);
    const moved = await lib.preferEditedCovers(USER);
    expect(moved).toEqual([
      { userId: USER, speciesId: SPECIES, oldCaptureId: rawBest.capture, newCaptureId: editEarly.capture },
    ]);
    // The crop was framed for the RAW, so it goes; the trashed and hidden 5-star edits never win.
    expect(await speciesRow()).toEqual({ cover_photo_id: editEarly.photo, card_crop_x: null });
    expect(await lib.preferEditedCovers(USER)).toEqual([]);
    expect((await speciesRow()).cover_photo_id).toBe(editEarly.photo);
  });

  it("never moves a cover the user chose", async () => {
    await setSpeciesCover(rawBest.photo, rawBest.photo);
    expect(await lib.preferEditedCovers(USER)).toEqual([]);
    expect((await speciesRow()).cover_photo_id).toBe(rawBest.photo);
  });

  it("moves it when an import frames the species", async () => {
    await setSpeciesCover(rawBest.photo, null);
    await crop.ensureDefaultCardCrop(USER, SPECIES);
    expect((await speciesRow()).cover_photo_id).toBe(editEarly.photo);
  });

  it("heals existing covers at startup", async () => {
    await setSpeciesCover(rawBest.photo, null);
    crop.preferEditedCoversLater(null);
    await expect.poll(async () => (await speciesRow()).cover_photo_id, { timeout: 5000 }).toBe(editEarly.photo);
  });

  it("moves it when another photo of the species gains an edited version", async () => {
    const raw = await addCapture(SPECIES_B, "raw", 5, "b-raw");
    const other = await addCapture(SPECIES_B, "raw", 1, "b-other");
    const edit = await addCapture(SPECIES_B, "jpeg", 1, "b-other-edit");
    // Out of view on its own, so only the link can bring the edit forward.
    await db.query(`UPDATE captures_all SET hidden_at = now() WHERE id = $1`, [edit.capture]);
    await setSpeciesCover(raw.photo, null, SPECIES_B);
    expect(await lib.preferEditedCovers(USER, [SPECIES_B])).toEqual([]);

    const vg = await import("../uploads/versionGrouping.js");
    await vg.withVersionChanges(USER, async (client, after) => {
      await vg.linkVersionTx(client, USER, edit.capture, other.capture, "manual", after);
      await vg.showVersionTx(client, other.capture, edit.capture, after.recrop);
    });
    // The other capture now shows the edit's photo.
    await expect.poll(async () => (await speciesRow(SPECIES_B)).cover_photo_id, { timeout: 5000 }).toBe(edit.photo);
  });

  it("gives an album an edit as its automatic cover, and keeps one the user picked", async () => {
    const created = await call("POST", "/api/albums", { name: "Herons" });
    const albumId = created.json().id as string;
    await call("POST", `/api/albums/${albumId}/captures`, { captureIds: [rawBest.capture, editEarly.capture] });
    const album = async () =>
      (
        await db.query<{ cover_photo_id: string | null; cover_auto_photo_id: string | null }>(
          `SELECT cover_photo_id, cover_auto_photo_id FROM albums WHERE id = $1`,
          [albumId],
        )
      ).rows[0];
    expect(await album()).toEqual({ cover_photo_id: editEarly.photo, cover_auto_photo_id: editEarly.photo });

    // An automatic RAW cover from before the edit was added moves; a picked one stays.
    await db.query(`UPDATE albums SET cover_photo_id = $1, cover_auto_photo_id = $1 WHERE id = $2`, [
      rawBest.photo,
      albumId,
    ]);
    await lib.preferEditedCovers(USER, []);
    expect((await album()).cover_photo_id).toBe(editEarly.photo);

    await call("PATCH", `/api/albums/${albumId}`, { coverPhotoId: rawBest.photo });
    expect(await album()).toEqual({ cover_photo_id: rawBest.photo, cover_auto_photo_id: null });
    await lib.preferEditedCovers(USER, []);
    expect((await album()).cover_photo_id).toBe(rawBest.photo);
  });

  it("shows an edit as a smart album's and a trip's automatic cover", async () => {
    const smart = await call("POST", "/api/albums", {
      name: "Auto Cover Birds",
      rules: { version: 2, query: { tripId: [tripId] } },
    });
    expect(smart.statusCode).toBeLessThan(300);
    // Every photo in the trip that is still only a RAW (the 5-star ones would win on rating alone).
    const rawPreviews = (
      await db.query<{ id: string }>(
        `SELECT p.id FROM photos p JOIN captures c ON c.id = p.capture_id
         WHERE c.trip_id = $1 AND NOT EXISTS (SELECT 1 FROM originals o WHERE o.capture_id = c.id AND o.kind <> 'raw')
           AND NOT EXISTS (SELECT 1 FROM capture_versions v WHERE v.group_capture_id = c.id AND v.displayed)`,
        [tripId],
      )
    ).rows.map((r) => r.id);
    expect(rawPreviews).toContain(rawBest.photo);
    const detail = (await call("GET", `/api/albums/${smart.json().id}`)).json();
    expect(detail.items.length).toBeGreaterThan(rawPreviews.length);
    expect(rawPreviews).not.toContain(detail.coverPhotoId);

    const trips = (await call("GET", "/api/trips")).json();
    const trip = (trips.trips ?? trips).find((t: { id: string }) => t.id === tripId);
    expect(rawPreviews.map((id) => `/api/photos/${id}/thumb`)).not.toContain(trip.coverPhotoUrl);
    expect(trip.coverPhotoUrl).toMatch(/^\/api\/photos\//);
    await db.query(`UPDATE trips SET cover_capture_id = $1 WHERE id = $2`, [rawBest.capture, tripId]);
    const picked = (await call("GET", "/api/trips")).json();
    expect((picked.trips ?? picked).find((t: { id: string }) => t.id === tripId).coverPhotoUrl).toBe(
      `/api/photos/${rawBest.photo}/thumb`,
    );
    await db.query(`UPDATE trips SET cover_capture_id = NULL WHERE id = $1`, [tripId]);
  });
});
