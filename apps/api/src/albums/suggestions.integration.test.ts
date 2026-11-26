// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Suggested smart albums: only with enough photos, never one the user already has, never one they
// dismissed, most interesting first and capped.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const OWNER = "5a6b6b6b-0000-4000-8000-000000000001";
const OTHER = "5a6b6b6b-0000-4000-8000-000000000002";
const BIRD = "5a6b6b6b-0000-4000-8000-0000000000aa";
const OWLS = Array.from({ length: 8 }, (_, i) => `5a6b6b6b-0000-4000-8000-0000000000b${i}`);
const TRIP = "5a6b6b6b-0000-4000-8000-0000000000c1";
const COUNTRY_A = "5a6b6b6b-0000-4000-8000-0000000000d1";
const COUNTRY_B = "5a6b6b6b-0000-4000-8000-0000000000d2";
const CONTINENT = "5a6b6b6b-0000-4000-8000-0000000000d0";
const TOKEN = "lifer_test_album_suggestions_owner";
const OTHER_TOKEN = "lifer_test_album_suggestions_other";

interface Suggestion {
  id: string;
  kind: string;
  label: string | null;
  name: string;
  rules: { version: 2; query: Record<string, string | string[]> };
  photoCount: number;
  previewPhotoIds: string[];
}

describe.skipIf(!url)("album suggestions", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName: string;
  let thumb: string;
  let clearCaches: () => void;
  let suggestionCounts: typeof import("./suggestions.js");

  const call = (method: "GET" | "POST", route: string, payload?: unknown, token = TOKEN) =>
    app.inject({ method, url: route, payload: payload as object, cookies: { [cookieName]: token } });
  // Counts are cached and recounted in the background, so most checks start from a fresh count.
  async function forgetCounts() {
    clearCaches();
    await suggestionCounts.clearAlbumSuggestionCounts();
    await db.query(`DELETE FROM install_settings WHERE key = ANY($1)`, [
      [OWNER, OTHER].map((u) => `album_suggestions_counted:${u}`),
    ]);
  }
  const suggestions = async (token = TOKEN): Promise<Suggestion[]> => {
    await forgetCounts();
    const res = await call("GET", "/api/albums/suggestions", undefined, token);
    expect(res.statusCode).toBe(200);
    return res.json().suggestions;
  };
  const ids = async () => (await suggestions()).map((s) => s.id);

  async function addCapture(o: {
    species?: string;
    rating?: number | null;
    takenAt?: string;
    tripId?: string | null;
    regionId?: string | null;
    animals?: number | null;
  }) {
    const captureId = (
      await db.query<{ id: string }>(
        `INSERT INTO captures (user_id, species_id, fingerprint, quality_rating, taken_at, lat, lon, trip_id, region_id, subject_count)
         VALUES ($1, $2, gen_random_uuid()::text, $3, $4, 10.5, -84.2, $5, $6, $7) RETURNING id`,
        [
          OWNER,
          o.species ?? BIRD,
          o.rating ?? null,
          // Midday at this spot, so no photo reads as golden hour.
          o.takenAt ?? "2023-06-15T18:00:00Z",
          o.tripId ?? null,
          o.regionId ?? null,
          o.animals ?? null,
        ],
      )
    ).rows[0].id;
    const photoId = (
      await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, $2, $2) RETURNING id`,
        [captureId, thumb],
      )
    ).rows[0].id;
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [photoId, captureId]);
    return { captureId, photoId };
  }

  async function clearLibrary() {
    await db.query(`DELETE FROM albums WHERE user_id = ANY($1)`, [[OWNER, OTHER]]);
    await db.query(`DELETE FROM captures_all WHERE user_id = ANY($1)`, [[OWNER, OTHER]]);
    await db.query(`DELETE FROM user_species WHERE user_id = ANY($1)`, [[OWNER, OTHER]]);
    await db.query(`DELETE FROM trips WHERE user_id = ANY($1)`, [[OWNER, OTHER]]);
    await db.query(`DELETE FROM install_settings WHERE key = ANY($1)`, [
      [OWNER, OTHER].map((u) => `album_suggestions_dismissed:${u}`),
    ]);
    await forgetCounts();
  }

  async function cleanup() {
    await clearLibrary();
    await db.query(`DELETE FROM users WHERE id = ANY($1)`, [[OWNER, OTHER]]);
    await db.query(`DELETE FROM species_rarity WHERE species_id = ANY($1)`, [[BIRD, ...OWLS]]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[BIRD, ...OWLS]]);
    await db.query(`DELETE FROM regions WHERE id = ANY($1)`, [[COUNTRY_A, COUNTRY_B, CONTINENT]]);
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-album-suggestions-"));
    thumb = path.join(dataDir, "thumb.webp");
    writeFileSync(thumb, "webp");
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { albumRoutes } = await import("./routes.js");
    clearCaches = (await import("../gallery/routes.js")).clearGallerySearchCaches;
    suggestionCounts = await import("./suggestions.js");

    await cleanup();
    for (const [id, email, token] of [
      [OWNER, "suggest-owner@test", TOKEN],
      [OTHER, "suggest-other@test", OTHER_TOKEN],
    ]) {
      await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`, [id, email]);
      await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
        hashToken(token),
        id,
      ]);
    }
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class, taxon_order, family)
       VALUES ($1, 975400, 'Suggestus avis', 'Suggest Test Finch', 'aves', 'Passeriformes', 'Fringillidae')`,
      [BIRD],
    );
    for (const [i, id] of OWLS.entries()) {
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class, taxon_order, family)
         VALUES ($1, $2, $3, $4, 'aves', 'Strigiformes', 'Strigidae')`,
        [id, 975410 + i, `Suggestus strix${i}`, `Suggest Test Owl ${i}`],
      );
    }
    await db.query(
      `INSERT INTO regions (id, name, sovereignty_group, parent_id) VALUES
         ($3, 'Suggest Continent', NULL, NULL), ($1, 'Suggestland', 'SGA', $3), ($2, 'Otherland', 'SGB', $3)`,
      [COUNTRY_A, COUNTRY_B, CONTINENT],
    );

    app = Fastify();
    await app.register(cookie);
    await app.register(albumRoutes, { prefix: "/api" });
    await app.ready();
  });

  beforeEach(clearLibrary);

  afterAll(async () => {
    await app?.close();
    if (db) {
      await cleanup();
      await db.end();
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("suggests nothing under 8 photos, and a live count with previews from 8", async () => {
    for (let i = 0; i < 7; i++) await addCapture({ rating: 5, regionId: COUNTRY_A });
    await addCapture({ rating: 2, regionId: COUNTRY_A });
    expect(await suggestions()).toEqual([]);

    const eighth = await addCapture({ rating: 5, regionId: COUNTRY_A });
    const best = (await suggestions()).find((s) => s.id === "best-of-2023");
    expect(best).toMatchObject({
      kind: "bestOfYear",
      label: "2023",
      name: "Best of 2023",
      photoCount: 8,
      rules: {
        version: 2,
        query: { ratingMin: "4", dateFrom: "2023-01-01", dateTo: "2023-12-31", excludeVideo: "1" },
      },
    });
    expect(best!.previewPhotoIds).toHaveLength(4);
    expect(best!.previewPhotoIds).toContain(eighth.photoId);
    // One country is the whole library, so it isn't offered.
    expect((await ids()).some((id) => id.startsWith("country-"))).toBe(false);
  });

  it("answers from the last count at once, recounting behind it, and keeps it over a restart", async () => {
    for (let i = 0; i < 8; i++) await addCapture({});
    const first = (await call("GET", "/api/albums/suggestions")).json();
    expect(first.suggestions.map((s: Suggestion) => s.id)).toEqual(["needs-rating", "missing-region"]);
    expect(first.startMatches.photoCount).toBe(8);
    expect(first.startMatches.previewPhotoIds).toHaveLength(8);

    // A new import: the next open still shows the last count, without waiting for a recount.
    for (let i = 0; i < 8; i++) await addCapture({ rating: 5 });
    clearCaches();
    const stale = (await call("GET", "/api/albums/suggestions")).json();
    expect(stale.suggestions.map((s: Suggestion) => s.id)).toEqual(["needs-rating", "missing-region"]);
    expect(stale.startMatches.photoCount).toBe(8);

    // That open started a recount; once it lands the import shows.
    await suggestionCounts.recountAlbumSuggestions(OWNER);
    const fresh = (await call("GET", "/api/albums/suggestions")).json();
    expect(fresh.suggestions.map((s: Suggestion) => s.id)).toContain("best-of-2023");
    expect(fresh.startMatches.photoCount).toBe(16);

    // After a restart the saved count answers at once too.
    await suggestionCounts.clearAlbumSuggestionCounts();
    const restarted = (await call("GET", "/api/albums/suggestions")).json();
    expect(restarted.suggestions).toEqual(fresh.suggestions);

    // An album made from one hides it straight away, before any recount.
    const best = fresh.suggestions.find((s: Suggestion) => s.id === "best-of-2023");
    await call("POST", "/api/albums", { name: "Best", rules: best.rules });
    const after = (await call("GET", "/api/albums/suggestions")).json();
    expect(after.suggestions.map((s: Suggestion) => s.id)).not.toContain("best-of-2023");
  });

  it("leaves out previews of photos deleted since the last count", async () => {
    for (let i = 0; i < 8; i++) await addCapture({});
    const first = (await call("GET", "/api/albums/suggestions")).json();
    const gone = first.startMatches.previewPhotoIds[0];
    await db.query(`DELETE FROM captures_all WHERE id = (SELECT capture_id FROM photos WHERE id = $1)`, [gone]);
    clearCaches();
    const stale = (await call("GET", "/api/albums/suggestions")).json();
    expect(stale.startMatches.previewPhotoIds).toHaveLength(7);
    expect(stale.startMatches.previewPhotoIds).not.toContain(gone);
    for (const s of stale.suggestions) expect(s.previewPhotoIds).not.toContain(gone);
  });

  it("leaves out an album of the whole library, but not tidying it", async () => {
    for (let i = 0; i < 8; i++) await addCapture({ rating: 5, regionId: COUNTRY_A });
    expect(await ids()).toEqual([]);
    await db.query(`UPDATE captures_all SET quality_rating = NULL WHERE user_id = $1`, [OWNER]);
    expect(await ids()).toEqual(["needs-rating"]);
  });

  it("never suggests rules an album already has, however their keys are ordered", async () => {
    for (let i = 0; i < 8; i++) await addCapture({ rating: 5 });
    await addCapture({ rating: 1 });
    const best = (await suggestions()).find((s) => s.id === "best-of-2023")!;
    const reordered = Object.fromEntries(Object.entries(best.rules.query).reverse());
    const created = await call("POST", "/api/albums", { name: "Mine", rules: { version: 2, query: reordered } });
    expect(created.statusCode).toBe(200);
    expect(await ids()).not.toContain("best-of-2023");
    // A different rule set is still offered.
    expect(await ids()).toContain("missing-region");
  });

  it("forgets a dismissed suggestion for that user only", async () => {
    for (let i = 0; i < 8; i++) await addCapture({});
    expect(await ids()).toEqual(["needs-rating", "missing-region"]);
    expect((await call("POST", "/api/albums/suggestions/needs-rating/dismiss")).statusCode).toBe(200);
    // Dismissing twice keeps one entry.
    await call("POST", "/api/albums/suggestions/needs-rating/dismiss");
    expect(await ids()).toEqual(["missing-region"]);
    const saved = await db.query(`SELECT value FROM install_settings WHERE key = $1`, [
      `album_suggestions_dismissed:${OWNER}`,
    ]);
    expect(saved.rows[0].value).toEqual(["needs-rating"]);
    expect((await call("POST", "/api/albums/suggestions/Not%20an%20id/dismiss")).statusCode).toBe(400);
    expect(await suggestions(OTHER_TOKEN)).toEqual([]);
  });

  it("lists dismissed suggestions and restores any of them", async () => {
    for (let i = 0; i < 8; i++) await addCapture({});
    await call("POST", "/api/albums/suggestions/needs-rating/dismiss");
    const open = (await call("GET", "/api/albums/suggestions")).json();
    expect(open.suggestions.map((s: Suggestion) => s.id)).toEqual(["missing-region"]);
    expect(open.dismissedCount).toBe(1);
    const dismissed = (await call("GET", "/api/albums/suggestions?dismissed=true")).json();
    expect(dismissed.suggestions).toEqual([expect.objectContaining({ id: "needs-rating", photoCount: 8 })]);
    expect((await call("POST", "/api/albums/suggestions/needs-rating/restore")).statusCode).toBe(200);
    // Restoring twice, or something never dismissed, changes nothing.
    expect((await call("POST", "/api/albums/suggestions/needs-rating/restore")).statusCode).toBe(200);
    expect(await ids()).toEqual(["needs-rating", "missing-region"]);
    expect((await call("GET", "/api/albums/suggestions?dismissed=true")).json().suggestions).toEqual([]);
    expect((await call("GET", "/api/albums/suggestions?dismissed=maybe")).statusCode).toBe(400);
  });

  // Each suggestion's photos checked against what is true of the labelled library: precision is the
  // share of a suggestion's photos that really are of its kind.
  it("keeps every suggestion type at 0.9 precision or better on a labelled library", async () => {
    await db.query(
      `INSERT INTO species_rarity (species_id, tier) SELECT unnest($1::uuid[]), 'rare'
       ON CONFLICT (species_id) DO UPDATE SET tier = 'rare'`,
      [OWLS],
    );
    type Truth = { rating: number | null; year: number; animals: number; owl: boolean };
    const truth = new Map<string, Truth>();
    const add = async (t: Truth, o: { regionId?: string }) => {
      const { photoId } = await addCapture({
        species: t.owl ? OWLS[0] : BIRD,
        rating: t.rating,
        takenAt: `${t.year}-06-15T18:00:00Z`,
        animals: t.animals,
        ...o,
      });
      truth.set(photoId, t);
    };
    // 24 groups of 3 to 6 animals, and 6 single animals the detector called a pair.
    for (let i = 0; i < 24; i++)
      await add({ rating: 4, year: 2023, animals: 3 + (i % 4), owl: i % 2 === 0 }, { regionId: COUNTRY_A });
    for (let i = 0; i < 6; i++) await add({ rating: 2, year: 2023, animals: 1, owl: false }, { regionId: COUNTRY_B });
    const reported = new Map<string, number>();
    const list = await suggestions();
    const checks: Record<string, (t: Truth) => boolean> = {
      "best-of-2023": (t) => (t.rating ?? 0) >= 4 && t.year === 2023,
      "groups-of-animals": (t) => t.animals >= 3,
      "group-owls": (t) => t.owl,
    };
    for (const [id, isTrue] of Object.entries(checks)) {
      const s = list.find((x) => x.id === id);
      expect(s, id).toBeDefined();
      const rows = (await call("POST", "/api/albums", { name: id, rules: s!.rules })).json();
      const detail = (await call("GET", `/api/albums/${rows.id}`)).json().items as Array<{ photoId: string }>;
      const good = detail.filter((i) => isTrue(truth.get(i.photoId)!)).length;
      reported.set(id, good / detail.length);
      expect(good / detail.length, id).toBeGreaterThanOrEqual(0.9);
    }
    // Seeded with single animals counted as two: a floor of two would score 24 of 30.
    expect(reported.get("groups-of-animals")).toBe(1);
  });

  it("offers each kind the library supports, most interesting first, capped at 8", async () => {
    await db.query(
      `INSERT INTO species_rarity (species_id, tier) SELECT unnest($1::uuid[]), 'rare'
       ON CONFLICT (species_id) DO UPDATE SET tier = 'rare'`,
      [OWLS],
    );
    await db.query(
      `INSERT INTO trips (id, user_id, name, source_folder, destination_folder) VALUES ($1, $2, 'Osa Peninsula', '/x', '/y')`,
      [TRIP, OWNER],
    );
    // Eight owls: each a lifer, rare, unrated, in groups, in one country.
    for (const owl of OWLS) {
      await addCapture({ species: owl, takenAt: "2021-06-15T18:00:00Z", regionId: COUNTRY_A, animals: 3 });
      await db.query(`INSERT INTO user_species (user_id, species_id, first_collected) VALUES ($1, $2, $3)`, [
        OWNER,
        owl,
        "2021-06-15T18:00:00Z",
      ]);
    }
    // Eight 4-star trip photos with no region, and one more in a second country.
    for (let i = 0; i < 8; i++) await addCapture({ rating: 4, takenAt: "2022-03-01T18:00:00Z", tripId: TRIP });
    await addCapture({ rating: 4, takenAt: "2022-03-01T18:00:00Z", regionId: COUNTRY_B });

    const list = await suggestions();
    expect(list.map((s) => s.id)).toEqual([
      "lifers",
      "best-of-2022",
      `trip-${TRIP}`,
      "rare-and-legendary",
      // Songbirds and owls are each part of the library; owls stand in for raptors, the same photos.
      "group-songbirds",
      `country-${COUNTRY_A}`,
      "groups-of-animals",
      "group-owls",
    ]);
    const by = Object.fromEntries(list.map((s) => [s.id, s]));
    expect(by.lifers).toMatchObject({ kind: "lifers", photoCount: 8, rules: { query: { q: "lifers" } } });
    expect(by["best-of-2022"].photoCount).toBe(9);
    expect(by[`trip-${TRIP}`]).toMatchObject({
      kind: "tripHighlights",
      label: "Osa Peninsula",
      name: "Osa Peninsula highlights",
      photoCount: 8,
    });
    expect(by["rare-and-legendary"].photoCount).toBe(8);
    expect(by["group-owls"]).toMatchObject({ kind: "group", label: "owls", name: "Owls", photoCount: 8 });
    expect(by[`country-${COUNTRY_A}`]).toMatchObject({ kind: "country", name: "Suggestland", photoCount: 8 });
    expect(by["groups-of-animals"].photoCount).toBe(8);

    // A created suggestion holds the photos its card counted, even named after its own search word.
    for (const id of ["lifers", "best-of-2022", "group-owls", `country-${COUNTRY_A}`]) {
      const created = await call("POST", "/api/albums", { name: by[id].name, rules: by[id].rules });
      expect(created.statusCode).toBe(200);
      clearCaches();
      const detail = await call("GET", `/api/albums/${created.json().id}`);
      expect([id, detail.json().items.length]).toEqual([id, by[id].photoCount]);
      await db.query(`DELETE FROM albums WHERE id = $1`, [created.json().id]);
    }

    // Past the cap, the next one moves up once another is taken.
    await call("POST", "/api/albums/suggestions/lifers/dismiss");
    expect((await ids()).at(-1)).toBe("needs-rating");
  });
});
