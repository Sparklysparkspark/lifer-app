// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Sending captures to iNaturalist: a send that fails partway resumes on the same observation, and
// one observation never mixes species. The iNaturalist client is mocked.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  fetchJwt: vi.fn(async () => "jwt"),
  createObservation: vi.fn(async () => "9001"),
  addObservationPhoto: vi.fn(async () => {}),
  fetchObservationLocation: vi.fn(async () => ({
    lat: 49.2,
    lon: -123.1,
    positionalAccuracyMeters: 25,
    observedOn: "2026-06-03" as string | null,
  })),
}));
vi.mock("./client.js", async (importOriginal) => ({ ...(await importOriginal<object>()), ...client }));

// Reading observations back from iNaturalist (the existing-observations check) never leaves the test.
vi.mock("./observationSync.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchObservationPages: vi.fn(async () => 0),
  fetchDeletedObservationIds: vi.fn(async () => []),
  fetchPreview: vi.fn(async () => {
    throw new Error("no network in tests");
  }),
}));

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000821";
const TOKEN = "lifer_test_inaturalist_send_821";
const SPECIES_A = "eeeeeeee-0000-4000-8000-000000000822";
const SPECIES_B = "eeeeeeee-0000-4000-8000-000000000823";
const SPECIES_C = "eeeeeeee-0000-4000-8000-000000000824";
const SPECIES_D = "eeeeeeee-0000-4000-8000-000000000825";
const ALL_SPECIES = [SPECIES_A, SPECIES_B, SPECIES_C, SPECIES_D];

describe.skipIf(!url)("sending captures to iNaturalist", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName: string;
  const captures: string[] = [];

  const send = (captureIds: string[]) =>
    app.inject({
      method: "POST",
      url: "/api/inaturalist/observations",
      payload: { captureIds },
      cookies: { [cookieName]: TOKEN },
    });
  const links = async () =>
    (
      await db.query(
        `SELECT capture_id, inat_observation_id, photo_sent FROM capture_inaturalist_observations
         WHERE capture_id = ANY($1) ORDER BY capture_id`,
        [captures],
      )
    ).rows;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-inat-send-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { saveInatAccount } = await import("./tokenStore.js");
    const { inaturalistRoutes } = await import("./routes.js");

    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [ALL_SPECIES]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'inat-send@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class, inat_taxon_id) VALUES
         ($1, 915821, 'Sendia prima', 'First Sender', 'aves', 821),
         ($2, 915822, 'Sendia secunda', 'Second Sender', 'aves', 822)`,
      [SPECIES_A, SPECIES_B],
    );
    for (const [i, species] of [SPECIES_A, SPECIES_A, SPECIES_B].entries()) {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures_all (user_id, species_id, fingerprint) VALUES ($1, $2, $3) RETURNING id`,
        [USER, species, `inat-send-${i}`],
      );
      const p = await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, $2, '/nowhere/t.webp') RETURNING id`,
        [c.rows[0].id, `/nowhere/d${i}.webp`],
      );
      await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
      captures.push(c.rows[0].id);
    }
    await saveInatAccount({
      userId: USER,
      accessToken: "access",
      refreshToken: null,
      inatUserId: "1",
      inatUsername: "sender",
    });

    app = Fastify();
    await app.register(cookie);
    await app.register(inaturalistRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
      await db.query(`DELETE FROM species WHERE id = ANY($1)`, [ALL_SPECIES]);
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("refuses captures of different species in one observation", async () => {
    const res = await send([captures[0], captures[2]]);
    expect([res.statusCode, res.json()]).toEqual([
      400,
      { error: "An observation's photos must all be the same species" },
    ]);
    expect(client.createObservation).not.toHaveBeenCalled();
  });

  it("resumes a failed send on the same observation instead of making another", async () => {
    const [first, second] = captures;
    client.addObservationPhoto.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error("upload failed"));
    const failed = await send([first, second, first]);
    expect([failed.statusCode, failed.json()]).toEqual([502, { error: "upload failed" }]);
    expect(client.createObservation).toHaveBeenCalledTimes(1);
    // One photo went up before the failure; both captures are linked to the one observation.
    const afterFailure = await links();
    expect(afterFailure.map((l) => l.inat_observation_id)).toEqual(["9001", "9001"]);
    expect(afterFailure.filter((l) => l.photo_sent)).toHaveLength(1);
    const unsent = afterFailure.find((l) => !l.photo_sent)!.capture_id as string;

    // The unfinished capture is still offered for import, and isn't listed as pending yet.
    const importable = (await app.inject({ url: "/api/inaturalist/import", cookies: { [cookieName]: TOKEN } })).json();
    expect(
      importable.clusters.flatMap((c: { captures: Array<{ id: string }> }) => c.captures.map((x) => x.id)),
    ).toContain(unsent);
    const pending = await app.inject({ url: "/api/inaturalist/pending", cookies: { [cookieName]: TOKEN } });
    expect(JSON.stringify(pending.json())).not.toContain("9001");

    client.addObservationPhoto.mockClear();
    const retried = await send([first, second]);
    expect([retried.statusCode, retried.json().observationId]).toEqual([200, "9001"]);
    expect(client.createObservation).toHaveBeenCalledTimes(1);
    // Only the photo that didn't make it goes up again.
    expect(client.addObservationPhoto).toHaveBeenCalledTimes(1);
    expect(client.addObservationPhoto).toHaveBeenCalledWith(
      "jwt",
      "9001",
      `/nowhere/d${captures.indexOf(unsent)}.webp`,
      null,
    );
    expect((await links()).every((l) => l.photo_sent)).toBe(true);
    // No GPS and no date were sent, so the Pending row says what's left to add on iNaturalist.
    const listed = (await app.inject({ url: "/api/inaturalist/pending", cookies: { [cookieName]: TOKEN } })).json();
    expect(listed.observations).toEqual([
      expect.objectContaining({ observationId: "9001", photoCount: 2, observedAt: null, sentLocation: false }),
    ]);
    expect(listed.observations[0].photoIds).toHaveLength(2);
    // Species cards group observations by this.
    expect(listed.observations[0].speciesId).toBe(SPECIES_A);

    const again = await send([first]);
    expect([again.statusCode, again.json()]).toEqual([
      409,
      { error: "One or more of these photos is already on iNaturalist" },
    ]);
  });

  it("leaves ignored photos out of To send until they're restored", async () => {
    const third = captures[2];
    const ignore = (ignored: boolean) =>
      app.inject({
        method: "POST",
        url: "/api/inaturalist/ignore",
        payload: { captureIds: [third], ignored },
        cookies: { [cookieName]: TOKEN },
      });
    const listed = async (ignored: boolean) =>
      (
        await app.inject({
          url: `/api/inaturalist/import${ignored ? "?ignored=true" : ""}`,
          cookies: { [cookieName]: TOKEN },
        })
      ).json();
    const ids = (body: { clusters: Array<{ captures: Array<{ id: string }> }> }) =>
      body.clusters.flatMap((c) => c.captures.map((x) => x.id));

    expect((await ignore(true)).json()).toEqual({ updated: 1 });
    const active = await listed(false);
    expect(ids(active)).not.toContain(third);
    expect(active.ignoredCount).toBe(1);
    expect(ids(await listed(true))).toEqual([third]);
    expect((await ignore(false)).json()).toEqual({ updated: 1 });
    expect(ids(await listed(false))).toContain(third);
  });

  it("completes an observation at once when its photos had a location and a date", async () => {
    const third = captures[2];
    await db.query(
      `UPDATE captures_all SET lat = 49.1, lon = -123.2, taken_at = '2026-06-04T10:00:00Z' WHERE id = $1`,
      [third],
    );
    client.createObservation.mockResolvedValueOnce("9002");
    const res = await send([third]);
    expect([res.statusCode, res.json().needsLocation, res.json().needsDate]).toEqual([200, false, false]);
    const completed = (
      await app.inject({ url: "/api/inaturalist/completed", cookies: { [cookieName]: TOKEN } })
    ).json();
    expect(completed.observations).toEqual([
      expect.objectContaining({ observationId: "9002", sentLocation: true, photoCount: 1 }),
    ]);
  });

  it("finishes a pending observation by itself, filling only photos with no location or date", async () => {
    // 9001 went without GPS or a date; the user has since placed it and dated it on iNaturalist.
    const res = await app.inject({
      method: "POST",
      url: "/api/inaturalist/pending/check",
      cookies: { [cookieName]: TOKEN },
    });
    expect(res.json()).toEqual(expect.objectContaining({ completed: 1 }));
    const photos = (
      await db.query(`SELECT lat, lon, taken_at, location_source FROM captures_all WHERE id = ANY($1)`, [
        captures.slice(0, 2),
      ])
    ).rows;
    for (const p of photos) {
      expect([Number(p.lat), Number(p.lon), p.location_source]).toEqual([49.2, -123.1, "inaturalist"]);
      expect(new Date(p.taken_at).toISOString()).toBe("2026-06-03T12:00:00.000Z");
    }
    const completed = (
      await app.inject({ url: "/api/inaturalist/completed", cookies: { [cookieName]: TOKEN } })
    ).json();
    expect(completed.observations).toContainEqual(
      expect.objectContaining({ observationId: "9001", sentLocation: false, dateFromInat: true }),
    );
  });

  it("keeps videos and sounds out of To send and sends a mixed sighting's photos only", async () => {
    const made: Record<string, string> = {};
    for (const kind of ["image", "video", "audio"]) {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures_all (user_id, species_id, fingerprint) VALUES ($1, $2, $3) RETURNING id`,
        [USER, SPECIES_B, `inat-send-media-${kind}`],
      );
      const p = await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path, kind) VALUES ($1, $2, '/nowhere/t.webp', $3) RETURNING id`,
        [c.rows[0].id, `/nowhere/${kind}.webp`, kind],
      );
      await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
      made[kind] = c.rows[0].id;
    }
    const listed = (await app.inject({ url: "/api/inaturalist/import", cookies: { [cookieName]: TOKEN } })).json();
    const ids = listed.clusters.flatMap((c: { captures: Array<{ id: string }> }) => c.captures.map((x) => x.id));
    expect(ids).toContain(made.image);
    expect(ids).not.toContain(made.video);
    expect(ids).not.toContain(made.audio);

    const recordingsOnly = await send([made.video, made.audio]);
    expect([recordingsOnly.statusCode, recordingsOnly.json()]).toEqual([
      422,
      { error: "Only photos can be sent to iNaturalist" },
    ]);

    client.createObservation.mockResolvedValueOnce("9003");
    client.addObservationPhoto.mockClear();
    const mixed = await send([made.image, made.video, made.audio]);
    expect([mixed.statusCode, mixed.json().observationId]).toEqual([200, "9003"]);
    expect(client.addObservationPhoto).toHaveBeenCalledTimes(1);
    expect(client.addObservationPhoto).toHaveBeenCalledWith("jwt", "9003", "/nowhere/image.webp", null);
    const linked = await db.query(
      `SELECT capture_id FROM capture_inaturalist_observations WHERE capture_id = ANY($1)`,
      [Object.values(made)],
    );
    expect(linked.rows.map((r) => r.capture_id)).toEqual([made.image]);
  });

  it("narrows To send with the Gallery's RAW filters, keeping whole sightings", async () => {
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class, inat_taxon_id) VALUES
         ($1, 915824, 'Sendia tertia', 'Third Sender', 'aves', 824),
         ($2, 915825, 'Sendia quarta', 'Fourth Sender', 'aves', 825)`,
      [SPECIES_C, SPECIES_D],
    );
    // edited: a JPEG with its RAW; partner: the same sighting with no RAW; plain: a lone JPEG.
    const made: Record<string, string> = {};
    for (const [name, species, kinds] of [
      ["edited", SPECIES_C, ["jpeg", "raw"]],
      ["partner", SPECIES_C, ["jpeg"]],
      ["plain", SPECIES_D, ["jpeg"]],
    ] as const) {
      const c = await db.query<{ id: string }>(
        // One minute apart: the same sighting when the species matches.
        `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at)
         VALUES ($1, $2, $3, '2026-05-01T08:00:00Z'::timestamptz + $4 * interval '1 minute') RETURNING id`,
        [USER, species, `inat-send-raw-${name}`, Object.keys(made).length],
      );
      const p = await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/r.webp', '/nowhere/t.webp') RETURNING id`,
        [c.rows[0].id],
      );
      await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
      for (const kind of kinds) {
        await db.query(
          `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size)
           VALUES ($1, $2, 'path', $3, false, $3, 1)`,
          [c.rows[0].id, kind, `/nowhere/${name}.${kind}`],
        );
      }
      made[name] = c.rows[0].id;
    }
    const listed = async (query: string) => {
      const body = (
        await app.inject({ url: `/api/inaturalist/import?${query}`, cookies: { [cookieName]: TOKEN } })
      ).json();
      return body.clusters.flatMap((c: { captures: Array<{ id: string }> }) => c.captures.map((x) => x.id));
    };
    const withRaw = await listed("onlyHasRaw=1");
    expect(withRaw).toEqual(expect.arrayContaining([made.edited, made.partner]));
    expect(withRaw).not.toContain(made.plain);
    expect(withRaw).not.toContain(captures[0]);
    const withoutRaw = await listed("excludeHasRaw=1");
    expect(withoutRaw).toContain(made.plain);
    // The partner passes, so its sighting stays whole.
    expect(withoutRaw).toContain(made.edited);
    expect(await listed("onlyRaw=1")).toEqual([]);
    expect(await listed("")).toEqual(expect.arrayContaining(Object.values(made)));
  });

  it("counts every sighting in totalCount whatever the RAW filters leave", async () => {
    const body = async (query: string) =>
      (await app.inject({ url: `/api/inaturalist/import?${query}`, cookies: { [cookieName]: TOKEN } })).json();
    const all = await body("");
    const none = await body("onlyRaw=1");
    expect(none.clusters).toEqual([]);
    expect(all.totalCount).toBe(all.clusters.length);
    expect(none.totalCount).toBe(all.totalCount);
  });
});
