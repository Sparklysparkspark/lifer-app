// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Observations the user made on iNaturalist themselves: found, linked, offered for review, and
// linked instead of sent twice. iNaturalist and the image model are mocked with fixed vectors.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const unit = (i: number) => Float32Array.from({ length: 4 }, (_, j) => (j === i ? 1 : 0));
const near = (i: number, k: number, w: number) => {
  const v = Float32Array.from({ length: 4 }, (_, j) => (j === i ? 1 : j === k ? w : 0));
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

const client = vi.hoisted(() => ({
  fetchJwt: vi.fn(async () => "jwt"),
  createObservation: vi.fn(async () => "9001"),
  addObservationPhoto: vi.fn(async () => {}),
}));
vi.mock("./client.js", async (importOriginal) => ({ ...(await importOriginal<object>()), ...client }));

const remote = vi.hoisted(() => ({ pages: [] as unknown[][] }));
vi.mock("./observationSync.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./observationSync.js")>();
  const { parseObservation } = await import("./matching.js");
  return {
    ...real,
    fetchObservationPages: vi.fn(async (opts: Parameters<typeof real.fetchObservationPages>[0]) => {
      const page = (remote.pages.shift() ?? []).map(parseObservation).filter((o) => o !== null);
      await opts.onPage(page, { read: page.length, total: page.length });
      return page.length;
    }),
    fetchDeletedObservationIds: vi.fn(async () => []),
    // The preview's bytes name which vector the mocked model gives it.
    fetchPreview: vi.fn(async (url: string) => Buffer.from(url)),
  };
});
vi.mock("@lifer/core/species/embeddings.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isModelDownloaded: () => true,
  photoVectors: (image: Buffer | { path: string }) => {
    const key = Buffer.isBuffer(image) ? image.toString() : image.path;
    // Preview of photo 1 looks like axis 0, photo 2 like axis 2; local tiles of a capture's file follow its name.
    const v = key.includes("/2/") || key.includes("burst") ? unit(2) : key.includes("other") ? near(0, 1, 1) : unit(0);
    return { vectors: { clip: Promise.resolve(v), "clip-crop": Promise.resolve(v) } };
  },
}));
vi.mock("sharp", () => ({
  // A tile looks like the photo it was cut from.
  default: (file: string) => ({
    metadata: async () => ({ width: 100, height: 100 }),
    extract: () => ({ jpeg: () => ({ toBuffer: async () => Buffer.from(`tile of ${file}`) }) }),
  }),
}));

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000931";
const TOKEN = "lifer_test_inaturalist_existing_931";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000932";

const observation = (id: number, photoId: number, time: string) => ({
  id,
  taxon: { id: 931, rank_level: 10, ancestor_ids: [1, 931] },
  ident_taxon_ids: [1, 931],
  time_observed_at: time,
  time_zone_offset: "-07:00",
  observed_on: time.slice(0, 10),
  location: "54.0017,-122.6977",
  positional_accuracy: 31,
  place_guess: "Prince George, BC, Canada",
  photos: [
    {
      id: photoId,
      url: `https://inaturalist-open-data.s3.amazonaws.com/photos/${photoId}/square.jpg`,
      original_dimensions: { width: 2048, height: 1366 },
    },
  ],
  updated_at: "2026-11-04T15:16:59-07:00",
});

describe.skipIf(!url)("observations already on iNaturalist", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName: string;
  const ids: Record<string, string> = {};
  const call = (method: "GET" | "POST", u: string, payload?: object) =>
    app.inject({ method, url: `/api${u}`, payload, cookies: { [cookieName]: TOKEN } });
  const runCheck = async () => {
    expect((await call("POST", "/inaturalist/existing")).statusCode).toBe(200);
    for (;;) {
      const s = (await call("GET", "/inaturalist/existing/status")).json();
      if (!s.running) return s;
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-inat-existing-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { EMBEDDING_MODEL_VERSION } = await import("@lifer/core/config.js");
    const { saveInatAccount } = await import("./tokenStore.js");
    const { inaturalistRoutes } = await import("./routes.js");

    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'inat-existing@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class, inat_taxon_id)
       VALUES ($1, 915931, 'Pandia existens', 'Found Osprey', 'aves', 931)`,
      [SPECIES],
    );
    // osprey: the uploaded frame; other: a different frame that day; burstA/burstB: two alike frames.
    const rows: Array<[string, string, number[]]> = [
      ["osprey", "2026-09-11T04:40:17Z", Array.from(unit(0))],
      ["other", "2026-09-11T04:41:30Z", Array.from(near(0, 1, 1))],
      ["burstA", "2026-09-12T06:00:05Z", Array.from(unit(2))],
      ["burstB", "2026-09-12T06:00:06Z", Array.from(unit(2))],
      ["toSend", "2026-09-13T07:00:00Z", Array.from(unit(0))],
      // Two alike frames for an observation: the guard can't tell which, so it holds the send.
      ["burstTwinA", "2026-09-14T08:00:05Z", Array.from(unit(2))],
      ["burstTwinB", "2026-09-14T08:00:06Z", Array.from(unit(2))],
    ];
    for (const [name, takenAt, vector] of rows) {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at, taken_at_zoned)
         VALUES ($1, $2, $3, $4, false) RETURNING id`,
        [USER, SPECIES, `inat-existing-${name}`, takenAt],
      );
      const p = await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path, width, height)
         VALUES ($1, $2, '/nowhere/t.webp', 2560, 1708) RETURNING id`,
        [c.rows[0].id, `/nowhere/${name}.webp`],
      );
      await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
      await db.query(`INSERT INTO capture_embeddings (capture_id, embedding, model_version) VALUES ($1, $2, $3)`, [
        c.rows[0].id,
        vector,
        EMBEDDING_MODEL_VERSION,
      ]);
      ids[name] = c.rows[0].id;
    }
    await saveInatAccount({
      userId: USER,
      accessToken: "access",
      refreshToken: null,
      inatUserId: "7",
      inatUsername: "me",
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
      await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("links the frame the picture clearly picks, takes the observation's point and keeps the observation cached", async () => {
    remote.pages.push([
      observation(500, 1, "2026-09-11T04:40:00-07:00"),
      observation(501, 2, "2026-09-12T06:00:00-07:00"),
    ]);
    const status = await runCheck();
    expect(status.result).toMatchObject({ read: 2, linked: 1, review: 2, compared: true });
    const link = await db.query(
      `SELECT inat_observation_id, photo_sent, source, status FROM capture_inaturalist_observations WHERE capture_id = $1`,
      [ids.osprey],
    );
    expect(link.rows[0]).toEqual({
      inat_observation_id: "500",
      photo_sent: true,
      source: "inaturalist",
      status: "completed",
    });
    const placed = await db.query(`SELECT lat, lon, location_source FROM captures_all WHERE id = $1`, [ids.osprey]);
    expect(placed.rows[0]).toMatchObject({ lat: "54.0017", lon: "-122.6977", location_source: "inaturalist" });
    const cached = await db.query(`SELECT data FROM inaturalist_remote_observations WHERE user_id = $1 ORDER BY 1`, [
      USER,
    ]);
    expect(cached.rows[0].data).toMatchObject({
      point: { lat: 54.0017 },
      accuracyM: 31,
      placeGuess: "Prince George, BC, Canada",
    });
    // The preview was read once and its vectors kept.
    expect(
      (await db.query(`SELECT count(*)::int AS n FROM inaturalist_photo_embeddings WHERE user_id = $1`, [USER])).rows[0]
        .n,
    ).toBe(2);

    const completed = (await call("GET", "/inaturalist/completed")).json();
    expect(completed.observations).toEqual([expect.objectContaining({ observationId: "500", foundOnInat: true })]);
    const toSend = (await call("GET", "/inaturalist/import")).json();
    const listed = toSend.clusters.flatMap((c: { captures: Array<{ id: string; onInat: boolean }> }) => c.captures);
    expect(listed.map((c: { id: string }) => c.id)).not.toContain(ids.osprey);
    // The burst frames look the same as an observation, so To send says so.
    expect(listed.find((c: { id: string }) => c.id === ids.burstA)?.onInat).toBe(true);
  });

  it("offers a burst for review, remembers Not a match and links on Link", async () => {
    const list = (await call("GET", "/inaturalist/matches")).json();
    const burst = list.matches.filter((m: { observationId: string }) => m.observationId === "501");
    expect(burst.map((m: { captureId: string }) => m.captureId).sort()).toEqual([ids.burstA, ids.burstB].sort());
    expect(burst[0]).toMatchObject({ likeness: "same", evidence: { taxon: "same", time: "close", size: "same" } });

    expect(
      (await call("POST", "/inaturalist/matches/dismiss", { captureId: ids.burstB, observationId: "501" })).statusCode,
    ).toBe(200);
    // Undo puts the card back and forgets the answer; then it's dismissed again for real.
    await call("POST", "/inaturalist/matches/dismiss", { captureId: ids.burstB, observationId: "501", undo: true });
    const back = (await call("GET", "/inaturalist/matches")).json().matches;
    expect(back.map((m: { captureId: string }) => m.captureId)).toContain(ids.burstB);
    const remembered = await db.query(`SELECT 1 FROM capture_inaturalist_not_matches WHERE capture_id = $1`, [
      ids.burstB,
    ]);
    expect(remembered.rows).toEqual([]);
    await call("POST", "/inaturalist/matches/dismiss", { captureId: ids.burstB, observationId: "501" });
    expect(
      (await call("POST", "/inaturalist/matches/link", { captureId: ids.burstA, observationId: "501" })).statusCode,
    ).toBe(200);
    expect((await call("GET", "/inaturalist/matches")).json().matches).toEqual([]);

    // A later check never suggests the dismissed pair again.
    remote.pages.push([]);
    const again = await runCheck();
    expect(again.result).toMatchObject({ linked: 0, review: 0 });
  });

  it("links instead of sending a second observation of the same photo", async () => {
    remote.pages.push([observation(502, 3, "2026-09-13T07:00:00-07:00")]);
    const res = await call("POST", "/inaturalist/observations", { captureIds: [ids.toSend] });
    expect(res.json()).toMatchObject({ observationId: "502", linkedExisting: true });
    expect(client.createObservation).not.toHaveBeenCalled();
  });

  it("holds a send that may already be on iNaturalist, and sends it when the user says Send anyway", async () => {
    remote.pages.push([observation(503, 2, "2026-09-14T08:00:00-07:00")]);
    const held = await call("POST", "/inaturalist/observations", { captureIds: [ids.burstTwinA, ids.burstTwinB] });
    expect([held.statusCode, held.json()]).toEqual([
      409,
      { error: "This looks like it may already be on iNaturalist.", code: "maybe_on_inaturalist" },
    ]);
    expect(client.createObservation).not.toHaveBeenCalled();
    const sent = await call("POST", "/inaturalist/observations", {
      captureIds: [ids.burstTwinA, ids.burstTwinB],
      ignoreExistingGuard: true,
    });
    expect(sent.json()).toMatchObject({ observationId: "9001", linkedExisting: false });
    expect(client.createObservation).toHaveBeenCalledTimes(1);
  });

  it("unlinks a found photo: restores what the link wrote, keeps later edits, and never links it again by itself", async () => {
    // The osprey was linked by the check, and took the observation's point.
    const recorded = await db.query(`SELECT link_writes FROM capture_inaturalist_observations WHERE capture_id = $1`, [
      ids.osprey,
    ]);
    expect(recorded.rows[0].link_writes).toMatchObject({
      sidecar: true,
      fields: { lat: { from: null }, location_source: { to: "inaturalist" } },
    });
    const res = await call("POST", "/inaturalist/matches/unlink", { captureIds: [ids.osprey] });
    expect(res.json()).toEqual({ unlinked: 1, kept: 0 });
    const photo = await db.query(
      `SELECT lat, lon, location_source, location_accuracy_m FROM captures_all WHERE id = $1`,
      [ids.osprey],
    );
    expect(photo.rows[0]).toEqual({ lat: null, lon: null, location_source: null, location_accuracy_m: null });
    expect(
      (await db.query(`SELECT 1 FROM capture_inaturalist_observations WHERE capture_id = $1`, [ids.osprey])).rows,
    ).toEqual([]);
    const pair = await db.query(`SELECT kind FROM capture_inaturalist_not_matches WHERE capture_id = $1`, [ids.osprey]);
    expect(pair.rows).toEqual([{ kind: "unlinked" }]);
    // Back on To send and in review; a later check offers it but doesn't link it.
    const listed = (await call("GET", "/inaturalist/import"))
      .json()
      .clusters.flatMap((c: { captures: Array<{ id: string }> }) => c.captures);
    expect(listed.map((c: { id: string }) => c.id)).toContain(ids.osprey);
    expect(
      (await call("GET", "/inaturalist/matches")).json().matches.map((m: { captureId: string }) => m.captureId),
    ).toContain(ids.osprey);
    remote.pages.push([]);
    await runCheck();
    expect(
      (await db.query(`SELECT 1 FROM capture_inaturalist_observations WHERE capture_id = $1`, [ids.osprey])).rows,
    ).toEqual([]);

    // A pin moved after linking stays where the user put it.
    await db.query(`UPDATE captures_all SET lat = 49.5, location_source = NULL WHERE id = $1`, [ids.toSend]);
    const kept = await call("POST", "/inaturalist/matches/unlink", { observationId: "502" });
    expect(kept.json()).toEqual({ unlinked: 1, kept: 1 });
    expect((await db.query(`SELECT lat::text FROM captures_all WHERE id = $1`, [ids.toSend])).rows[0].lat).toBe("49.5");
  });
});
