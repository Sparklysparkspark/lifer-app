// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Setting a location in Lifer for observations sent without one, then sending it to iNaturalist:
// through the shared Set place route, queued when offline, never overwriting a pin placed there.
// The iNaturalist client is mocked; nothing leaves the test.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  fetchJwt: vi.fn(async () => "jwt"),
  fetchObservationLocation: vi.fn(async () => ({
    lat: null as number | null,
    lon: null as number | null,
    positionalAccuracyMeters: null as number | null,
    observedOn: null as string | null,
  })),
  updateObservationLocation: vi.fn(async () => {}),
}));
vi.mock("./client.js", async (importOriginal) => ({ ...(await importOriginal<object>()), ...client }));
vi.mock("./observationSync.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchObservationPages: vi.fn(async () => 0),
}));

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000931";
const TOKEN = "lifer_test_inaturalist_location_931";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000932";
const OBS = ["7001", "7002", "7003", "7004"];

describe.skipIf(!url)("sending a location set in Lifer to iNaturalist", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName: string;
  let spotId: string;
  const captures: string[] = [];

  const inject = (method: "GET" | "POST", path: string, payload?: object) =>
    app.inject({ method, url: `/api${path}`, payload, cookies: { [cookieName]: TOKEN } });
  const setLocation = (observationIds: string[], conflict?: "replace" | "keep") =>
    inject("POST", "/inaturalist/observations/location", { observationIds, ...(conflict ? { conflict } : {}) });
  const settled = async () => {
    for (;;) {
      const status = (await inject("GET", "/inaturalist/observations/location/status")).json();
      if (!status.running) return status.result;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const listed = async (id: string) =>
    (await inject("GET", "/inaturalist/pending"))
      .json()
      .observations.find((o: { observationId: string }) => o.observationId === id);
  const place = (i: number) =>
    db.query(`UPDATE captures_all SET lat = 49.25, lon = -123.1 WHERE id = $1`, [captures[i]]);

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-inat-location-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { saveInatAccount } = await import("./tokenStore.js");
    const { inaturalistRoutes } = await import("./routes.js");
    const { savedSpotRoutes } = await import("../places/savedSpots.js");

    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'inat-location@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class, inat_taxon_id)
       VALUES ($1, 915931, 'Locata prima', 'Placed Bird', 'aves', 931)`,
      [SPECIES],
    );
    for (const [i, obs] of OBS.entries()) {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures_all (user_id, species_id, fingerprint) VALUES ($1, $2, $3) RETURNING id`,
        [USER, SPECIES, `inat-location-${i}`],
      );
      captures.push(c.rows[0].id);
      // Sent without a location: Casual on iNaturalist.
      await db.query(
        `INSERT INTO capture_inaturalist_observations (capture_id, inat_observation_id, photo_sent) VALUES ($1, $2, true)`,
        [c.rows[0].id, obs],
      );
    }
    spotId = (
      await db.query<{ id: string }>(
        `INSERT INTO saved_spots (user_id, name, lat, lon, radius_m, geoprivacy)
         VALUES ($1, 'Hidden marsh', 49.3, -123.2, 500, 'obscured') RETURNING id`,
        [USER],
      )
    ).rows[0].id;
    await saveInatAccount({
      userId: USER,
      accessToken: "access",
      refreshToken: null,
      inatUserId: "1",
      inatUsername: "placer",
    });

    app = Fastify();
    await app.register(cookie);
    await app.register(inaturalistRoutes, { prefix: "/api" });
    await app.register(savedSpotRoutes, { prefix: "/api" });
    await app.ready();
  });

  beforeEach(() => {
    client.fetchJwt.mockReset().mockResolvedValue("jwt");
    client.fetchObservationLocation
      .mockReset()
      .mockResolvedValue({ lat: null, lon: null, positionalAccuracyMeters: null, observedOn: null });
    client.updateObservationLocation.mockReset().mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM install_settings WHERE key = $1`, [`inat_location_updates:${USER}`]);
      await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
      await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("lists a sighting sent without a location as having none on iNaturalist", async () => {
    expect(await listed("7001")).toMatchObject({
      noLocationOnInat: true,
      locationUpdate: null,
      captureIds: [captures[0]],
    });
  });

  it("files the photos under the place, then sends its point and privacy to iNaturalist", async () => {
    // The Gallery's Set place: the place's centre goes onto the photo that had no point.
    const applied = await inject("POST", `/saved-spots/${spotId}/apply`, { captureIds: [captures[0]], wait: true });
    expect(applied.json()).toMatchObject({ ok: true, applied: 1 });

    expect((await setLocation(["7001"])).json()).toEqual({ started: true });
    expect(await settled()).toEqual({ updated: 1, waiting: 0, failed: 0, conflicts: 0, conflictIds: [] });
    expect(client.updateObservationLocation).toHaveBeenCalledWith(
      "jwt",
      "7001",
      { lat: 49.3, lon: -123.2, positionalAccuracy: 500, geoprivacy: "obscured" },
      expect.anything(),
    );
    const row = await listed("7001");
    expect(row).toMatchObject({ noLocationOnInat: false, sentLocation: true, locationUpdate: { state: "sent" } });
    // What Lifer sent is now that point, for the To finish check and any later update.
    const sent = await db.query(
      `SELECT submitted_lat::float8 AS lat, submitted_lon::float8 AS lon FROM capture_inaturalist_observations
       WHERE inat_observation_id = '7001'`,
    );
    expect(sent.rows).toEqual([{ lat: 49.3, lon: -123.2 }]);
  });

  it("keeps the location in Lifer and queues the update while offline, then sends it on the next check", async () => {
    await place(1);
    client.fetchJwt.mockRejectedValue(new TypeError("fetch failed"));
    expect((await setLocation(["7002"])).json()).toEqual({ started: true });
    expect(await settled()).toEqual({ updated: 0, waiting: 1, failed: 0, conflicts: 0, conflictIds: [] });
    expect(await listed("7002")).toMatchObject({ noLocationOnInat: true, locationUpdate: { state: "waiting" } });

    // Back online: the To finish check retries what's waiting.
    client.fetchJwt.mockResolvedValue("jwt");
    await inject("POST", "/inaturalist/pending/check", {});
    // The retry starts in the background.
    await vi.waitFor(async () => expect(await listed("7002")).toMatchObject({ locationUpdate: { state: "sent" } }), {
      timeout: 5000,
    });
    expect(client.updateObservationLocation).toHaveBeenCalledWith("jwt", "7002", expect.anything(), expect.anything());
  });

  it("asks the user to reconnect when iNaturalist refuses the sign-in", async () => {
    await place(2);
    // Imported here: a top-level import would read the config before the test sets it.
    const { InatHttpError } = await import("./client.js");
    client.fetchJwt.mockRejectedValue(new InatHttpError("iNaturalist JWT exchange failed: 401", 401));
    await setLocation(["7003"]);
    expect(await settled()).toMatchObject({ failed: 1 });
    expect(await listed("7003")).toMatchObject({ locationUpdate: { state: "failed", reason: "reconnect" } });
    expect(client.updateObservationLocation).not.toHaveBeenCalled();
  });

  it("never overwrites a location placed on iNaturalist since sending, until the user says Replace", async () => {
    await place(3);
    client.fetchObservationLocation.mockResolvedValue({
      lat: 50.1,
      lon: -120.4,
      positionalAccuracyMeters: 30,
      observedOn: null,
    });
    await setLocation(["7004"]);
    expect(await settled()).toMatchObject({ conflicts: 1, conflictIds: ["7004"], updated: 0 });
    expect(client.updateObservationLocation).not.toHaveBeenCalled();
    expect(await listed("7004")).toMatchObject({ noLocationOnInat: false, locationUpdate: { state: "conflict" } });

    // Keep iNaturalist's: nothing is sent and the question goes away.
    await setLocation(["7004"], "keep");
    expect(await listed("7004")).toMatchObject({ locationUpdate: null });

    await setLocation(["7004"], "replace");
    expect(await settled()).toMatchObject({ updated: 1 });
    // Replace doesn't ask iNaturalist again.
    expect(client.fetchObservationLocation).toHaveBeenCalledTimes(1);
    expect(client.updateObservationLocation).toHaveBeenCalledWith(
      "jwt",
      "7004",
      { lat: 49.25, lon: -123.1, positionalAccuracy: null, geoprivacy: null },
      expect.anything(),
    );
  });

  it("ignores observations that aren't the user's", async () => {
    expect((await setLocation(["123456789"])).json()).toEqual({ started: true });
    expect(await settled()).toEqual({ updated: 0, waiting: 0, failed: 0, conflicts: 0, conflictIds: [] });
  });
});
