// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer_test npx vitest run captures/appearance
// How the animal looks (migration 196): set over the API, read back by the Gallery, the photo feed
// and the sync change feed, and synced like any other edit. Also the canonical species keys.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "abab0196-0000-4000-8000-000000000001";
const OTHER_USER = "abab0196-0000-4000-8000-000000000002";
const SPECIES = "abab0196-0000-4000-8000-00000000000a";
const OLD_A = "abab0196-0000-4000-8000-0000000000a1";
const OLD_B = "abab0196-0000-4000-8000-0000000000b1";
const TOKEN = "lifer_test_appearance_196";

describe.skipIf(!url)("photo appearance", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  const ids: string[] = [];
  let othersCapture = "";

  const call = (method: "GET" | "POST", path: string, payload?: object) =>
    app.inject({ method, url: path, payload, headers: { "x-api-key": TOKEN } });
  const setAppearance = (payload: object) => call("POST", "/api/captures/appearance", payload);
  const row = async (id: string) =>
    (await db.query(`SELECT life_stage, sex, plumage, morph FROM captures_all WHERE id = $1`, [id])).rows[0];

  async function cleanup() {
    await db.query(`DELETE FROM species_merges WHERE old_species_id = ANY($1)`, [[OLD_A, OLD_B]]);
    await db.query(`DELETE FROM user_species WHERE user_id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`UPDATE captures_all SET current_photo_id = NULL WHERE user_id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`DELETE FROM captures_all WHERE user_id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`DELETE FROM sync_tombstones WHERE user_id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`DELETE FROM users WHERE id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SPECIES, OLD_A, OLD_B]]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashApiKey } = await import("../auth/apiKeys.js");
    const { captureRoutes } = await import("./routes.js");
    const { integrationRoutes } = await import("../integrations/routes.js");
    const { galleryRoutes } = await import("../gallery/routes.js");
    const { speciesSearchRoutes } = await import("../species/search.js");
    const { apiVersionAlias } = await import("../apiRoutes.js");

    await cleanup();
    await db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'appearance@test', 'x'), ($2, 'appearance-other@test', 'x')`,
      [USER, OTHER_USER],
    );
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class, inat_taxon_id)
       VALUES ($1, 990196, 'Pterophyllum appearancei', 'Appearance Angelfish', 'actinopterygii', 1960196),
              ($2, 990197, 'Pterophyllum oldus', 'Old Angelfish', 'actinopterygii', NULL),
              ($3, 990198, 'Pterophyllum olderus', 'Older Angelfish', 'actinopterygii', NULL)`,
      [SPECIES, OLD_A, OLD_B],
    );
    // Three photos over two years, and one undated.
    for (const [i, takenAt] of [
      "2023-05-01T12:00:00Z",
      "2025-02-01T12:00:00Z",
      "2025-08-01T12:00:00Z",
      null,
    ].entries()) {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures (user_id, species_id, fingerprint, taken_at) VALUES ($1, $2, $3, $4) RETURNING id`,
        [USER, SPECIES, `appearance-${i}`, takenAt],
      );
      const p = await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
        [c.rows[0].id],
      );
      await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
      ids.push(c.rows[0].id);
    }
    othersCapture = (
      await db.query<{ id: string }>(
        `INSERT INTO captures (user_id, species_id, fingerprint) VALUES ($1, $2, 'appearance-other') RETURNING id`,
        [OTHER_USER, SPECIES],
      )
    ).rows[0].id;
    await db.query(`INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'collected')`, [
      USER,
      SPECIES,
    ]);
    await db.query(`INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, 'test', $2, $3)`, [
      USER,
      hashApiKey(TOKEN),
      ["photos.read", "photos.write", "collection.read", "gallery.read", "species.read"],
    ]);

    app = Fastify({ rewriteUrl: apiVersionAlias });
    await app.register(cookie);
    for (const routes of [captureRoutes, integrationRoutes, galleryRoutes, speciesSearchRoutes])
      await app.register(routes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db?.end();
  });

  it("checks the values at the boundary", async () => {
    for (const bad of [
      { captureIds: [ids[0]], lifeStage: "tadpole" },
      { captureIds: [ids[0]], sex: "M" },
      { captureIds: [ids[0]], morph: "x".repeat(101) },
      { captureIds: [], morph: "dark" },
      { captureIds: [ids[0]], colour: "blue" },
    ])
      expect((await setAppearance(bad)).statusCode).toBe(400);
    expect(await row(ids[0])).toEqual({ life_stage: null, sex: null, plumage: null, morph: null });
  });

  it("sets one photo, leaves fields left out alone, and clears with null or blank text", async () => {
    const res = await setAppearance({
      captureIds: [ids[0]],
      lifeStage: "juvenile",
      sex: "female",
      plumage: " breeding ",
      morph: "Koi",
    });
    expect(res.json()).toEqual({ updated: 1 });
    expect(await row(ids[0])).toEqual({ life_stage: "juvenile", sex: "female", plumage: "breeding", morph: "Koi" });

    await setAppearance({ captureIds: [ids[0]], sex: null, morph: "   " });
    expect(await row(ids[0])).toEqual({ life_stage: "juvenile", sex: null, plumage: "breeding", morph: null });
  });

  it("applies to a selection, never to another person's photo", async () => {
    const res = await setAppearance({ captureIds: [ids[1], ids[2], othersCapture], lifeStage: "adult" });
    expect(res.json()).toEqual({ updated: 2 });
    expect((await row(ids[2])).life_stage).toBe("adult");
    expect((await row(othersCapture)).life_stage).toBeNull();
  });

  it("counts as an edit: updated_at moves, so it syncs", async () => {
    const before = (await db.query(`SELECT updated_at FROM captures_all WHERE id = $1`, [ids[3]])).rows[0].updated_at;
    await setAppearance({ captureIds: [ids[3]], morph: "Marble" });
    const after = (await db.query(`SELECT updated_at FROM captures_all WHERE id = $1`, [ids[3]])).rows[0].updated_at;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it("goes both ways in the desktop-server sync", async () => {
    const { listChanges, FIRST_CURSOR, isoStamp } = await import("../sync/changes.js");
    const page = await listChanges(db, USER, FIRST_CURSOR, 100);
    const first = page.items.find((i) => i.id === ids[0]);
    expect(first).toMatchObject({ lifeStage: "juvenile", sex: null, plumage: "breeding", morph: null });

    const { applyPushedCaptures } = await import("../sync/pushServer.js");
    const base = (await db.query(`SELECT ${isoStamp("updated_at")} AS u FROM captures_all WHERE id = $1`, [ids[0]]))
      .rows[0].u as string;
    const pushed = await applyPushedCaptures(db, USER, [
      { ...first!, sex: "male", morph: "Platinum", baseUpdatedAt: base },
    ]);
    expect(pushed.outcomes[0]).toMatchObject({ status: "updated" });
    expect(await row(ids[0])).toEqual({ life_stage: "juvenile", sex: "male", plumage: "breeding", morph: "Platinum" });
  });

  it("shows in the Gallery and the photo feed", async () => {
    const gallery = (await call("GET", "/api/gallery?limit=50")).json() as {
      items: Array<{ captureId: string; lifeStage: string | null; morph: string | null }>;
    };
    expect(gallery.items.find((i) => i.captureId === ids[0])).toMatchObject({
      lifeStage: "juvenile",
      morph: "Platinum",
    });

    const feed = (await call("GET", "/api/captures?limit=50")).json() as {
      items: Array<{ captureId: string; lifeStage: string | null; sex: string | null; plumage: string | null }>;
    };
    expect(feed.items.find((i) => i.captureId === ids[0])).toMatchObject({
      lifeStage: "juvenile",
      sex: "male",
      plumage: "breeding",
      morph: "Platinum",
    });
    expect(feed.items.find((i) => i.captureId === ids[3])).toMatchObject({ lifeStage: null, sex: null });
  });

  it("lists the years a species was photographed on the life list", async () => {
    const list = (await call("GET", "/api/life-list")).json() as {
      species: Array<{ speciesId: string; years: number[] }>;
    };
    expect(list.species.find((s) => s.speciesId === SPECIES)?.years).toEqual([2023, 2025]);
  });

  it("gives species search hits their GBIF key, iNaturalist id and class", async () => {
    const res = (await call("GET", "/api/species?q=Pterophyllum%20appearancei")).json() as {
      results: Array<Record<string, unknown>>;
    };
    expect(res.results.find((r) => r.id === SPECIES)).toMatchObject({
      gbif_key: 990196,
      inat_taxon_id: 1960196,
      taxon_class: "actinopterygii",
    });
  });

  it("lists species merges, following a chain to the survivor", async () => {
    // OLD_B was folded into OLD_A, then OLD_A into SPECIES: both live on SPECIES now.
    await db.query(
      `INSERT INTO species_merges (old_species_id, new_species_id, old_scientific_name, merged_at)
       VALUES ($1, $2, 'Pterophyllum olderus', '2026-01-01T00:00:00Z'), ($2, $3, 'Pterophyllum oldus', '2026-03-01T00:00:00Z')`,
      [OLD_B, OLD_A, SPECIES],
    );
    const all = (await call("GET", "/api/species/merges")).json() as {
      merges: Array<{ oldSpeciesId: string; newSpeciesId: string; oldScientificName: string }>;
    };
    const ours = all.merges.filter((m) => [OLD_A, OLD_B].includes(m.oldSpeciesId));
    expect(ours).toEqual([
      expect.objectContaining({
        oldSpeciesId: OLD_B,
        newSpeciesId: SPECIES,
        oldScientificName: "Pterophyllum olderus",
      }),
      expect.objectContaining({ oldSpeciesId: OLD_A, newSpeciesId: SPECIES }),
    ]);
    const since = (await call("GET", "/api/species/merges?since=2026-02-01T00:00:00Z")).json() as {
      merges: Array<{ oldSpeciesId: string }>;
    };
    expect(since.merges.map((m) => m.oldSpeciesId).filter((id) => [OLD_A, OLD_B].includes(id))).toEqual([OLD_A]);
  });
});
