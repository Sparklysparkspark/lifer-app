// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test npx vitest run versionLinking
// Linking any photo as a version, across species and dates: the picker's search, the life list
// following the original, a split giving everything back, and image routes serving the shown file.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000002961";
const MOOSE = "eeeeeeee-0000-4000-8000-00000000296a";
const HERON = "eeeeeeee-0000-4000-8000-00000000296b";
const TOKEN = "lifer_test_version_linking_2961";

describe.skipIf(!url)("linking any photo as a version", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;
  let resolveOriginal: (photoId: string, userId: string, kind: "jpeg") => Promise<{ ref: string | null } | null>;
  const ids: Record<string, string> = {};
  const photos: Record<string, string> = {};

  const call = (method: "GET" | "POST", route: string, payload?: unknown) =>
    app.inject({ method, url: route, payload: payload as object, cookies: { [cookieName]: TOKEN } });

  async function addPhoto(key: string, species: string, takenAt: string, ref: string) {
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures (user_id, species_id, fingerprint, taken_at) VALUES ($1, $2, $3, $4) RETURNING id`,
      [USER, species, `linking-${key}`, takenAt],
    );
    const p = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path, width, height)
       VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp', 100, 66) RETURNING id`,
      [c.rows[0].id],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
    await db.query(
      `INSERT INTO originals (user_id, capture_id, kind, ref_type, ref, managed, content_hash, file_size)
       VALUES ($1, $2, 'jpeg', 'path', $3, false, $4, 1000)`,
      [USER, c.rows[0].id, ref, `linking-hash-${key}`],
    );
    ids[key] = c.rows[0].id;
    photos[key] = p.rows[0].id;
  }

  const state = async (species: string) =>
    (
      await db.query<{ state: string; cover_photo_id: string | null }>(
        `SELECT state, cover_photo_id FROM user_species WHERE user_id = $1 AND species_id = $2`,
        [USER, species],
      )
    ).rows[0] ?? null;
  const visible = async () =>
    Number((await db.query(`SELECT count(*) FROM captures WHERE user_id = $1`, [USER])).rows[0].count);

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`UPDATE captures_all SET current_photo_id = NULL WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = ANY($1::uuid[])`, [[MOOSE, HERON]]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { captureRoutes } = await import("./routes.js");
    ({ resolveOriginal } = await import("../photos/routes.js"));

    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'linking@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 922961, 'Alces linkus', 'Linking Moose', 'mammalia'),
              ($2, 922962, 'Ardea linkus', 'Linking Heron', 'aves')`,
      [MOOSE, HERON],
    );

    await addPhoto("moose", MOOSE, "2024-05-01T07:12:33Z", "/lib/Moose/IMG_1234.jpg");
    await addPhoto("burst", MOOSE, "2024-05-01T07:13:00Z", "/lib/Moose/IMG_1235.jpg");
    // A print scanned years later, filed under the wrong species: only search finds it.
    await addPhoto("print", HERON, "2026-02-10T12:00:00Z", "/lib/Scans/moose_print_16x20.jpg");
    await addPhoto("heron", HERON, "2023-08-01T09:00:00Z", "/lib/Heron/IMG_0001.jpg");
    for (const [key, species] of [
      ["moose", MOOSE],
      ["print", HERON],
    ] as const) {
      await db.query(
        `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, cover_chosen_photo_id)
         VALUES ($1, $2, 'collected', $3, $3)`,
        [USER, species, photos[key]],
      );
    }

    app = Fastify();
    await app.register(cookie);
    await app.register(captureRoutes, { prefix: "/api" });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.end();
  });

  it("lists photos within two minutes, and searches every other one", async () => {
    const group = (await call("GET", `/api/captures/${ids.print}/versions`)).json();
    expect(group.nearby).toEqual([]);

    const byName = await call("GET", `/api/captures/${ids.print}/versions/candidates?q=IMG_1234`);
    expect(byName.statusCode).toBe(200);
    expect(byName.json().items).toEqual([
      expect.objectContaining({ captureId: ids.moose, fileName: "IMG_1234.jpg", speciesName: "Linking Moose" }),
    ]);
    // A folder name isn't a file name, and the photo itself is never offered.
    expect((await call("GET", `/api/captures/${ids.print}/versions/candidates?q=Scans`)).json().items).toEqual([]);
    expect((await call("GET", `/api/captures/${ids.print}/versions/candidates?q=16x20`)).json().items).toEqual([]);
    // "%" is a character to look for, not a wildcard.
    expect((await call("GET", `/api/captures/${ids.print}/versions/candidates?q=%25`)).json().items).toEqual([]);

    const bySpecies = (await call("GET", `/api/captures/${ids.print}/versions/candidates?q=linking%20moose`)).json();
    expect(bySpecies.items.map((i: { captureId: string }) => i.captureId).sort()).toEqual(
      [ids.moose, ids.burst].sort(),
    );
  });

  it("links across species and dates: the original's species counts, and a split gives it all back", async () => {
    const link = await call("POST", `/api/captures/${ids.print}/versions/link`, { groupCaptureId: ids.moose });
    expect(link.statusCode).toBe(200);
    expect(await visible()).toBe(3);
    // The print counts as the moose photo; the heron's hand-picked cover moves to its other photo.
    expect(await state(HERON)).toMatchObject({ state: "collected", cover_photo_id: photos.heron });
    expect(await state(MOOSE)).toMatchObject({ state: "collected", cover_photo_id: photos.moose });
    const own = await db.query(`SELECT species_id, taken_at FROM captures_all WHERE id = $1`, [ids.print]);
    expect(own.rows[0].species_id).toBe(HERON);

    // A photo with versions of its own can't become one, and a group is never offered.
    expect(
      (await call("POST", `/api/captures/${ids.moose}/versions/link`, { groupCaptureId: ids.burst })).statusCode,
    ).toBe(409);
    expect((await call("GET", `/api/captures/${ids.burst}/versions/candidates?q=IMG_1234`)).json().items).toEqual([]);

    const split = await call("POST", `/api/captures/${ids.print}/versions/split`);
    expect(split.json()).toEqual({ groupCaptureId: ids.moose });
    expect(await visible()).toBe(4);
    expect(await state(HERON)).toMatchObject({ state: "collected", cover_photo_id: photos.print });

    // The heron's only photo: the heron leaves the life list while it's a version, and comes back.
    await db.query(`UPDATE captures_all SET hidden_at = now() WHERE id = $1`, [ids.heron]);
    await call("POST", `/api/captures/${ids.print}/versions/link`, { groupCaptureId: ids.moose });
    expect((await state(HERON))?.state).not.toBe("collected");
    await call("POST", `/api/captures/${ids.print}/versions/split`);
    expect((await state(HERON))?.state).toBe("collected");
    await db.query(`UPDATE captures_all SET hidden_at = NULL WHERE id = $1`, [ids.heron]);
  });

  it("serves the shown version's file from the group's photo", async () => {
    await call("POST", `/api/captures/${ids.print}/versions/link`, { groupCaptureId: ids.moose });
    const show = await call("POST", `/api/captures/${ids.moose}/versions/show`, { captureId: ids.print });
    expect(show.statusCode).toBe(200);
    const shown = await db.query(`SELECT current_photo_id FROM captures_all WHERE id = $1`, [ids.moose]);
    expect(shown.rows[0].current_photo_id).toBe(photos.print);
    expect((await state(MOOSE))?.cover_photo_id).toBe(photos.print);
    expect((await resolveOriginal(photos.print, USER, "jpeg"))?.ref).toBe("/lib/Scans/moose_print_16x20.jpg");
    expect((await resolveOriginal(photos.moose, USER, "jpeg"))?.ref).toBe("/lib/Moose/IMG_1234.jpg");

    // Undo puts the original back, and splitting a shown version shows the original again.
    await call("POST", `/api/captures/${ids.print}/versions/split`);
    expect((await db.query(`SELECT current_photo_id FROM captures_all WHERE id = $1`, [ids.moose])).rows[0]).toEqual({
      current_photo_id: photos.moose,
    });
    expect((await resolveOriginal(photos.moose, USER, "jpeg"))?.ref).toBe("/lib/Moose/IMG_1234.jpg");
    // Showing and un-showing the moose never touched the heron's own pick.
    expect((await state(HERON))?.cover_photo_id).toBe(photos.print);
  });
});
