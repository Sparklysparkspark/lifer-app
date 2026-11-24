// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// A sighting's place on the iNaturalist page: the saved name, else the region the photo is filed
// under, else the region whose outline is within 22 km of its GPS point (a photo taken at sea off
// the coast), else nothing.
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000931";
const SQUID = "eeeeeeee-0000-4000-8000-000000000932";
const COUNTRY = "eeeeeeee-0000-4000-8000-000000000933";
const auth = vi.hoisted(() => ({ user: "" }));

vi.mock("../auth/session.js", async (importOriginal) => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: auth.user, email: "inat-place@test" };
  };
  return { ...(await importOriginal<object>()), requireAuth: asUser, requireScope: () => asUser };
});
vi.mock("./observationSync.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchObservationPages: vi.fn(async () => 0),
  fetchDeletedObservationIds: vi.fn(async () => []),
}));

// Degrees of latitude for km.
const deg = (km: number) => km / ((6371.0088 * Math.PI) / 180);
// A country in the open South Pacific, so no other outline is near.
const OUTLINE = {
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-140, -40],
        [-130, -40],
        [-130, -30],
        [-140, -30],
        [-140, -40],
      ],
    ],
  },
};

describe.skipIf(!url)("iNaturalist place names", () => {
  let app: FastifyInstance;
  let db: pg.Pool;

  async function addCapture(lat: number, lon: number, opts: { region?: string; label?: string; sent?: string } = {}) {
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, lat, lon, region_id, location_label, taken_at)
       VALUES ($1, $2, gen_random_uuid()::text, $3, $4, $5, $6, now()) RETURNING id`,
      [USER, SQUID, lat, lon, opts.region ?? null, opts.label ?? null],
    );
    const id = c.rows[0].id;
    const p = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/x/d.webp', '/x/t.webp') RETURNING id`,
      [id],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, id]);
    if (opts.sent)
      await db.query(
        `INSERT INTO capture_inaturalist_observations (capture_id, inat_observation_id, submitted_lat, submitted_lon,
           submitted_positional_accuracy, status, photo_sent) VALUES ($1, $2, $3, $4, 10, 'completed', true)`,
        [id, opts.sent, lat, lon],
      );
    return id;
  }

  const cleanup = async () => {
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM regions WHERE id = $1`, [COUNTRY]);
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'inat-place@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 913101, 'Sepioteuthis placei', 'Place Squid', 'cephalopoda') ON CONFLICT (id) DO NOTHING`,
      [SQUID],
    );
    await db.query(
      `INSERT INTO regions (id, name, parent_id, external_codes, boundary_geojson) VALUES ($1, 'Sea Country', NULL, '{ZZQ}', $2)`,
      [COUNTRY, OUTLINE],
    );
    // Completed: 10 km off the south coast (named by the outline), 30 km out (too far to name),
    // filed under the country far away (its filing names it), and a saved place name.
    await addCapture(-40 - deg(10), -135, { sent: "9310001" });
    await addCapture(-40 - deg(30), -135, { sent: "9310002" });
    await addCapture(-40 - deg(500), -135, { region: COUNTRY, sent: "9310003" });
    await addCapture(-35, -135, { label: "Reef Point", region: COUNTRY, sent: "9310004" });
    // To send: one at sea near the coast.
    await addCapture(-40 - deg(5), -132);

    auth.user = USER;
    const { inaturalistRoutes } = await import("./routes.js");
    app = Fastify();
    await app.register(inaturalistRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await cleanup();
      await db.query(`DELETE FROM species WHERE id = $1`, [SQUID]);
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("names a completed sighting by its saved place, filing, or the coast it was taken off", async () => {
    const res = await app.inject({ method: "GET", url: "/api/inaturalist/completed" });
    expect(res.statusCode).toBe(200);
    const places = Object.fromEntries(
      (res.json().observations as Array<{ observationId: string; placeName: string | null }>).map((o) => [
        o.observationId,
        o.placeName,
      ]),
    );
    expect(places).toEqual({
      "9310001": "Sea Country",
      "9310002": null,
      "9310003": "Sea Country",
      "9310004": "Reef Point, Sea Country",
    });
  });

  it("names a sighting to send by the coast it was taken off", async () => {
    const res = await app.inject({ method: "GET", url: "/api/inaturalist/import" });
    expect(res.statusCode).toBe(200);
    expect(res.json().clusters.map((c: { placeName: string | null }) => c.placeName)).toEqual(["Sea Country"]);
  });
});
