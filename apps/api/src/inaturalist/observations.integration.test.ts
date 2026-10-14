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
}));
vi.mock("./client.js", async (importOriginal) => ({ ...(await importOriginal<object>()), ...client }));

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000821";
const TOKEN = "lifer_test_inaturalist_send_821";
const SPECIES_A = "eeeeeeee-0000-4000-8000-000000000822";
const SPECIES_B = "eeeeeeee-0000-4000-8000-000000000823";

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
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SPECIES_A, SPECIES_B]]);
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
      await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SPECIES_A, SPECIES_B]]);
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
    );
    expect((await links()).every((l) => l.photo_sent)).toBe(true);

    const again = await send([first]);
    expect([again.statusCode, again.json()]).toEqual([
      409,
      { error: "One or more of these photos is already on iNaturalist" },
    ]);
  });
});
