// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// The editing backlog: ?unedited=1 lists RAW photos with no edited version (nothing but RAW beside
// them or linked to them as versions), in the Gallery and scoped to an album or trip; a species is
// "RAW only" when every photo of it is one.
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "ffffffff-0000-4000-8000-000000000941";
const ALL_RAW = "ffffffff-0000-4000-8000-0000000009a1";
const MIXED = "ffffffff-0000-4000-8000-0000000009a2";
const LINKED = "ffffffff-0000-4000-8000-0000000009a3";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "backlog@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

type Kind = "raw" | "jpeg" | "video";

describe.skipIf(!url)("the editing backlog", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  const ids: Record<string, string> = {};
  let albumId = "";
  let tripId = "";

  // A capture with one original of each kind given, shown as a photo (a video for "video").
  async function addCapture(name: string, species: string, kinds: Kind[], opts: { hidden?: boolean } = {}) {
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at, hidden_at)
       VALUES ($1, $2, gen_random_uuid()::text, now(), CASE WHEN $3 THEN now() END) RETURNING id`,
      [USER, species, !!opts.hidden],
    );
    const id = c.rows[0].id;
    const p = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path, kind) VALUES ($1, '/x/d.webp', '/x/t.webp', $2) RETURNING id`,
      [id, kinds.includes("video") ? "video" : "image"],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, id]);
    for (const kind of kinds)
      await db.query(
        `INSERT INTO originals (user_id, capture_id, kind, ref_type, ref, managed, content_hash, file_size)
         VALUES ($1, $2, $3, 'path', $4, false, $4, 1)`,
        [USER, id, kind, `/backlog/${name}.${kind}`],
      );
    ids[name] = id;
    return id;
  }

  const unedited = async (scope = "") => {
    const res = await app.inject({ method: "GET", url: `/api/gallery/ids?unedited=1${scope}` });
    expect(res.statusCode).toBe(200);
    const names = Object.fromEntries(Object.entries(ids).map(([name, id]) => [id, name]));
    return (res.json().captureIds as string[]).map((id) => names[id] ?? id).sort();
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    db = new pg.Pool({ connectionString: url });
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'backlog@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES
         ($1, 914101, 'Crudus omnis', 'All Raw Owl', 'aves'),
         ($2, 914102, 'Crudus mixtus', 'Mixed Owl', 'aves'),
         ($3, 914103, 'Crudus iunctus', 'Linked Owl', 'aves')
       ON CONFLICT (id) DO NOTHING`,
      [ALL_RAW, MIXED, LINKED],
    );
    // All RAW: two RAW-only photos.
    await addCapture("rawOnly", ALL_RAW, ["raw"]);
    await addCapture("rawOnly2", ALL_RAW, ["raw"]);
    // Mixed: a RAW whose JPG is a separate photo Lifer never linked, a JPG-only photo, a video,
    // and a RAW with its JPG on the same photo.
    await addCapture("rawUnlinked", MIXED, ["raw"]);
    await addCapture("unlinkedJpg", MIXED, ["jpeg"]);
    await addCapture("jpgOnly", MIXED, ["jpeg"]);
    await addCapture("video", MIXED, ["video"]);
    await addCapture("rawAndJpg", MIXED, ["raw", "jpeg"]);
    // Linked: a RAW with an edited JPG linked as its version (a link hides the version's capture).
    const head = await addCapture("rawLinked", LINKED, ["raw"]);
    const edit = await addCapture("linkedEdit", LINKED, ["jpeg"], { hidden: true });
    await db.query(
      `INSERT INTO capture_versions (capture_id, group_capture_id, user_id, evidence, state, hid_capture)
       VALUES ($1, $2, $3, 'manual', 'linked', true)`,
      [edit, head, USER],
    );
    await db.query(
      `INSERT INTO user_species (user_id, species_id, state) SELECT $1, s, 'collected' FROM unnest($2::uuid[]) s
       ON CONFLICT (user_id, species_id) DO UPDATE SET state = 'collected'`,
      [USER, [ALL_RAW, MIXED, LINKED]],
    );
    albumId = (
      await db.query<{ id: string }>(`INSERT INTO albums (user_id, name) VALUES ($1, 'Backlog') RETURNING id`, [USER])
    ).rows[0].id;
    await db.query(`INSERT INTO album_captures (album_id, capture_id) SELECT $1, unnest($2::uuid[])`, [
      albumId,
      [ids.rawOnly, ids.rawLinked, ids.jpgOnly],
    ]);
    tripId = (
      await db.query<{ id: string }>(
        `INSERT INTO trips (user_id, name, source_folder, destination_folder) VALUES ($1, 'Coast', '/nowhere', '/nowhere') RETURNING id`,
        [USER],
      )
    ).rows[0].id;
    await db.query(`UPDATE captures_all SET trip_id = $1 WHERE id = ANY($2::uuid[])`, [
      tripId,
      [ids.rawOnly2, ids.rawAndJpg, ids.video],
    ]);

    const { galleryRoutes } = await import("./routes.js");
    app = Fastify();
    await app.register(galleryRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("lists RAW photos with no edited version, counting only edits Lifer has linked", async () => {
    // Not: a linked edit, a JPG beside the RAW, JPG only, a video. An unlinked JPG elsewhere
    // doesn't count, so its RAW is listed.
    expect(await unedited()).toEqual(["rawOnly", "rawOnly2", "rawUnlinked"]);
  });

  it("works with the other filters and scoped to an album or a trip", async () => {
    expect(await unedited(`&albumId=${albumId}`)).toEqual(["rawOnly"]);
    expect(await unedited(`&tripId=${tripId}`)).toEqual(["rawOnly2"]);
    // Filters combine: hiding RAW files or asking for undated photos leaves nothing.
    expect(await unedited("&includeRaw=0")).toEqual([]);
    expect(await unedited("&missingDate=1")).toEqual([]);
  });

  it("marks a species RAW only when every photo of it is an unedited RAW", async () => {
    const { photoSetSpeciesCards } = await import("../collection/photoSetSpecies.js");
    const cards = await photoSetSpeciesCards(USER, [ALL_RAW, MIXED, LINKED], []);
    expect(Object.fromEntries(cards.map((c) => [c.scientificName, c.rawOnly]))).toEqual({
      "Crudus omnis": true,
      "Crudus mixtus": false,
      "Crudus iunctus": false,
    });
  });
});
