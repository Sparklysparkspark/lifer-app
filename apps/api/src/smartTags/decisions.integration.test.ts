// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:5432/lifer_test npx vitest run decisions
// Smart tag decisions: accepting makes an ordinary tag at the facet path that stays out of files
// while the switch is off; rejecting sticks through a re-run; batches undo once; a 5,000-photo term
// pages; hidden terms and decisions are in what sync sends; each route asks for its scope.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const DIR = vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const dir = `${process.env.TMPDIR ?? "/tmp"}/lifer-smart-tag-decisions-test`;
  process.env.DATA_DIR = dir;
  process.env.APP_DATA_DIR = `${dir}/app`;
  process.env.LIFER_CACHE_DIR = `${dir}/app`;
  return dir;
});

const url = process.env.TEST_DATABASE_URL;
const USER = "abcdabcd-0000-4000-8000-000000000f01";
const OTHER = "abcdabcd-0000-4000-8000-000000000f02";
const SPECIES = "abcdabcd-0000-4000-8000-000000000f0a";

// Scopes come from a test header, so each route's scope is checked without real keys.
vi.mock("../auth/session.js", () => {
  const scoped =
    (scope: string) =>
    async (
      request: { headers: Record<string, unknown>; user?: unknown },
      reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    ) => {
      const have = String(request.headers["x-scopes"] ?? "photos.read photos.write").split(" ");
      if (!have.includes(scope)) return reply.code(403).send({ error: "Missing scope", code: "missing_scope" });
      request.user = { id: USER, email: "st3@test" };
    };
  return { requireAuth: scoped("photos.write"), requireScope: scoped };
});

describe.skipIf(!url)("smart tag decisions", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let managed: string;
  let managedFile: string;
  let sunny: string;
  let othersPhoto: string;
  const bulk: string[] = [];

  async function cleanup() {
    for (const u of [USER, OTHER]) {
      await db.query(`DELETE FROM originals WHERE capture_id IN (SELECT id FROM captures_all WHERE user_id = $1)`, [u]);
      await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM sync_tombstones WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM install_settings WHERE key = $1`, [`file_writing:${u}`]);
      await db.query(`DELETE FROM users WHERE id = $1`, [u]);
    }
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
  }
  const call = (method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH", path: string, payload?: object, scopes?: string) =>
    app.inject({ method, url: `/api${path}`, payload, headers: scopes ? { "x-scopes": scopes } : {} });
  const capture = async (id: string) =>
    (
      await db.query<{ tags: string[]; accepted: Record<string, string>; rejected: string[] }>(
        `SELECT tags, smart_tags_accepted AS accepted, smart_tags_rejected AS rejected FROM captures_all WHERE id = $1`,
        [id],
      )
    ).rows[0];
  const suggest = (captureId: string, termId: string, score = 0.9) =>
    db.query(
      `INSERT INTO capture_smart_suggestions (capture_id, term_id, score, source) VALUES ($1, $2, $3, 'computed')
       ON CONFLICT DO NOTHING`,
      [captureId, termId, score],
    );
  async function subjectOf(file: string): Promise<string[]> {
    const { readExifTags } = await import("../uploads/exif.js");
    return ((await readExifTags(file)) as unknown as { Subject?: string[] }).Subject ?? [];
  }
  const add = async (user: string, fingerprint: string, extra = "") =>
    (
      await db.query<{ id: string }>(
        `INSERT INTO captures_all (user_id, species_id, fingerprint ${extra ? ", taken_at, lat, lon, taken_at_zoned" : ""})
         VALUES ($1, $2, $3 ${extra}) RETURNING id`,
        [user, SPECIES, fingerprint],
      )
    ).rows[0].id;

  beforeAll(async () => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    for (const [u, email] of [
      [USER, "st3@test"],
      [OTHER, "st3-other@test"],
    ])
      await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`, [u, email]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 920911, 'Decisus etiquetus', 'Decision Bird', 'aves')`,
      [SPECIES],
    );
    managedFile = path.join(DIR, "managed.jpg");
    await sharp({ create: { width: 16, height: 16, channels: 3, background: "#375" } })
      .jpeg()
      .toFile(managedFile);
    managed = await add(USER, "st3-managed");
    await db.query(
      `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size)
       VALUES ($1, 'jpeg', 'path', $2, true, 'st3-managed', 1)`,
      [managed, managedFile],
    );
    sunny = await add(USER, "st3-sunny", ", '2026-06-21T12:00:00Z', 51.5, -0.1, true");
    othersPhoto = await add(OTHER, "st3-other");
    await suggest(managed, "color.green-tones");
    await suggest(othersPhoto, "color.green-tones");
    const rows = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint)
       SELECT $1, $2, 'st3-bulk-' || i FROM generate_series(1, 5000) i RETURNING id`,
      [USER, SPECIES],
    );
    bulk.push(...rows.rows.map((r) => r.id));
    await db.query(
      `INSERT INTO capture_smart_suggestions (capture_id, term_id, score, source)
       SELECT id, 'habitat.wetland', (row_number() OVER (ORDER BY id)) % 97 / 100.0, 'scene' FROM unnest($1::uuid[]) id`,
      [bulk],
    );
    const { smartTagRoutes } = await import("./routes.js");
    const { captureTagRoutes } = await import("../captures/tags.js");
    app = Fastify();
    await app.register(smartTagRoutes, { prefix: "/api" });
    await app.register(captureTagRoutes, { prefix: "/api" });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (db) {
      await cleanup();
      await db.end();
    }
    const { closeExiftool } = await import("../uploads/exif.js");
    await closeExiftool();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(DIR, { recursive: true, force: true });
  });

  it("asks for photos.read to read and photos.write to decide", async () => {
    expect((await call("GET", "/smart-tags/terms", undefined, "photos.write")).statusCode).toBe(403);
    expect((await call("GET", `/smart-tags/captures/${managed}`, undefined, "photos.write")).statusCode).toBe(403);
    const body = { termId: "color.green-tones", captureIds: [managed] };
    for (const [method, url] of [
      ["POST", "/smart-tags/accept"],
      ["POST", "/smart-tags/reject"],
      ["POST", "/smart-tags/facets/time/accept"],
      ["POST", "/smart-tags/undo"],
      ["PUT", "/smart-tags/hidden/habitat.wetland"],
      ["DELETE", "/smart-tags/hidden/habitat.wetland"],
    ] as const)
      expect(
        (await call(method, url, url.endsWith("undo") ? { token: managed } : body, "photos.read")).statusCode,
      ).toBe(403);
    expect((await capture(managed)).tags).toEqual([]);
  });

  it("refuses unknown terms and an ambiguous body", async () => {
    const unknown = await call("POST", "/smart-tags/accept", { termId: "habitat.moon", captureIds: [managed] });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe("not_found");
    const both = await call("POST", "/smart-tags/accept", {
      termId: "color.green-tones",
      captureIds: [managed],
      allPending: {},
    });
    expect(both.statusCode).toBe(400);
    expect(both.json().code).toBe("invalid_request");
  });

  it("accepts as an ordinary tag at the facet path, idempotently, without touching the file", async () => {
    const before = readFileSync(managedFile);
    const res = await call("POST", "/smart-tags/accept", { termId: "color.green-tones", captureIds: [managed] });
    expect(res.statusCode).toBe(200);
    expect(res.json().updated).toBe(1);
    expect(res.json().undoToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(await capture(managed)).toEqual({
      tags: ["Color|Green tones"],
      accepted: { "color.green-tones": "Color|Green tones" },
      rejected: [],
    });
    expect(readFileSync(managedFile).equals(before)).toBe(true);
    // Again: nothing changes, so nothing to undo.
    expect(
      (await call("POST", "/smart-tags/accept", { termId: "color.green-tones", captureIds: [managed] })).json(),
    ).toEqual({ updated: 0, undoToken: null });
    // Shown in the reader's spelling; the suggestion is no longer pending.
    const strip = (await call("GET", `/smart-tags/captures/${managed}?locale=en-GB`)).json();
    expect(strip.suggestions).toEqual([]);
    expect(strip.accepted.map((t: { path: string }) => t.path)).toEqual(["Colour|Green tones"]);
    // Another user's photo is out of reach.
    expect(
      (await call("POST", "/smart-tags/accept", { termId: "color.green-tones", captureIds: [othersPhoto] })).json(),
    ).toEqual({ updated: 0, undoToken: null });
    expect((await capture(othersPhoto)).tags).toEqual([]);
  });

  it("keeps accepted smart tags out of files until the switch is on", async () => {
    const set = await call("PATCH", `/captures/${managed}/tags`, { tags: ["Color|Green tones", "flight shot"] });
    expect(set.statusCode).toBe(200);
    const subject = await subjectOf(managedFile);
    expect(subject).toContain("flight shot");
    expect(subject).not.toContain("Color|Green tones");

    await db.query(`INSERT INTO install_settings (key, value) VALUES ($1, '{"smartTags": true}')`, [
      `file_writing:${USER}`,
    ]);
    const { syncCaptureXmpSidecars } = await import("../uploads/xmpSidecarSync.js");
    await syncCaptureXmpSidecars(USER, managed);
    expect(await subjectOf(managedFile)).toContain("Color|Green tones");
    await db.query(`DELETE FROM install_settings WHERE key = $1`, [`file_writing:${USER}`]);
    await syncCaptureXmpSidecars(USER, managed);
    expect(await subjectOf(managedFile)).not.toContain("Color|Green tones");
  });

  it("treats an accepted tag the user removed as rejected", async () => {
    await call("PATCH", `/captures/${managed}/tags`, { tags: ["flight shot"] });
    expect(await capture(managed)).toEqual({ tags: ["flight shot"], accepted: {}, rejected: ["color.green-tones"] });
    expect((await call("GET", `/smart-tags/captures/${managed}`)).json().suggestions).toEqual([]);
    // A sync sender that leaves the decisions out keeps them.
    await db.query(`UPDATE captures_all SET smart_tags_rejected = NULL, smart_tags_accepted = NULL WHERE id = $1`, [
      managed,
    ]);
    expect((await capture(managed)).rejected).toEqual(["color.green-tones"]);
  });

  it("never suggests a rejected term again, even after a version bump re-run", async () => {
    const { planSmartTags } = await import("@lifer/core/smartTags/suggest.js");
    const { evaluateSmartTags } = await import("./suggestionPass.js");
    const plan = planSmartTags({ imageModel: "x", textModel: "y", clip: false });
    await evaluateSmartTags([sunny], { plan, vectors: null, framing: null });
    const pending = async () =>
      (await call("GET", `/smart-tags/captures/${sunny}`)).json().suggestions.map((s: { id: string }) => s.id);
    expect(await pending()).toContain("season.summer");
    const rejected = await call("POST", "/smart-tags/reject", { termId: "season.summer", captureIds: [sunny] });
    expect(rejected.json().updated).toBe(1);
    await evaluateSmartTags([sunny], {
      plan: { ...plan, version: `${plan.version}/bumped` },
      vectors: null,
      framing: null,
    });
    const row = await db.query(
      `SELECT 1 FROM capture_smart_suggestions WHERE capture_id = $1 AND term_id = 'season.summer'`,
      [sunny],
    );
    expect(row.rowCount).toBe(1);
    expect(await pending()).not.toContain("season.summer");
  });

  it("undoes a batch exactly once, and refuses an unknown token", async () => {
    const acc = (
      await call("POST", "/smart-tags/accept", { termId: "time-of-day.midday", captureIds: [sunny] })
    ).json();
    expect((await capture(sunny)).tags).toEqual(["Time of day|Midday"]);
    // Rejecting the accepted tag takes it off; undoing that puts it back.
    const rej = (
      await call("POST", "/smart-tags/reject", { termId: "time-of-day.midday", captureIds: [sunny] })
    ).json();
    expect((await capture(sunny)).tags).toEqual([]);
    expect((await call("POST", "/smart-tags/undo", { token: rej.undoToken })).json()).toEqual({ restored: 1 });
    expect((await capture(sunny)).accepted).toEqual({ "time-of-day.midday": "Time of day|Midday" });
    expect((await call("POST", "/smart-tags/undo", { token: rej.undoToken })).json()).toEqual({ restored: 0 });
    expect((await call("POST", "/smart-tags/undo", { token: acc.undoToken })).json()).toEqual({ restored: 1 });
    expect(await capture(sunny)).toEqual({ tags: [], accepted: {}, rejected: ["season.summer"] });
    const gone = await call("POST", "/smart-tags/undo", { token: "00000000-0000-4000-8000-000000000000" });
    expect(gone.statusCode).toBe(410);
    expect(gone.json().code).toBe("undo_expired");
  });

  it("accepts a computed facet in one click, and only a computed one", async () => {
    const habitat = await call("POST", "/smart-tags/facets/habitat/accept");
    expect(habitat.statusCode).toBe(400);
    expect(habitat.json().code).toBe("not_computed");
    const time = (await call("POST", "/smart-tags/facets/time/accept")).json();
    expect(time.updated).toBe(1);
    expect((await capture(sunny)).tags).toEqual(["Time of day|Midday"]);
    await call("POST", "/smart-tags/undo", { token: time.undoToken });
  });

  it("pages a 5,000-photo term and accepts all of it but the deselected, in one undo step", async () => {
    const terms = (await call("GET", "/smart-tags/terms")).json();
    expect(terms.terms.find((t: { id: string }) => t.id === "habitat.wetland").pending).toBe(5000);
    const seen: string[] = [];
    let after: string | null = null;
    let scores: number[] = [];
    do {
      const q: string = after ? `&after=${encodeURIComponent(after)}` : "";
      const page = (await call("GET", `/smart-tags/terms/habitat.wetland/photos?limit=500${q}`)).json();
      expect(page.total).toBe(5000);
      seen.push(...page.items.map((i: { captureId: string }) => i.captureId));
      scores = scores.concat(page.items.map((i: { score: number }) => i.score));
      after = page.next;
    } while (after);
    expect(seen.length).toBe(5000);
    expect(new Set(seen).size).toBe(5000);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));

    const except = bulk.slice(0, 3);
    const res = await call("POST", "/smart-tags/accept", {
      termId: "habitat.wetland",
      allPending: { asOf: terms.asOf, except },
    });
    expect(res.json().updated).toBe(4997);
    const left = (await call("GET", "/smart-tags/terms/habitat.wetland/photos")).json();
    expect(left.items.map((i: { captureId: string }) => i.captureId).sort()).toEqual([...except].sort());
    expect((await capture(bulk[4])).tags).toEqual(["Habitat|Wetland"]);
    expect((await call("POST", "/smart-tags/undo", { token: res.json().undoToken })).json()).toEqual({
      restored: 4997,
    });
    expect((await capture(bulk[4])).tags).toEqual([]);
    expect((await call("GET", "/smart-tags/terms/habitat.wetland/photos?limit=1")).json().total).toBe(5000);
  }, 60_000);

  it("hides a term for every photo, and the change is in the sync feed with a tombstone", async () => {
    const { listLibraryChanges, FIRST_LIBRARY_CURSOR } = await import("../sync/library.js");
    const { pool } = await import("@lifer/core/db.js");
    expect((await call("PUT", "/smart-tags/hidden/habitat.wetland")).json()).toEqual({ ok: true });
    expect((await call("PUT", "/smart-tags/hidden/habitat.wetland")).json()).toEqual({ ok: true });
    const terms = (await call("GET", "/smart-tags/terms")).json();
    expect(terms.terms.some((t: { id: string }) => t.id === "habitat.wetland")).toBe(false);
    expect(terms.hidden.map((t: { id: string }) => t.id)).toEqual(["habitat.wetland"]);
    const feed = await listLibraryChanges(pool, USER, "smartTagHidden", FIRST_LIBRARY_CURSOR, 50);
    expect(feed.items).toEqual([{ termId: "habitat.wetland", updatedAt: expect.any(String) }]);

    await call("DELETE", "/smart-tags/hidden/habitat.wetland");
    const after = await listLibraryChanges(pool, USER, "smartTagHidden", FIRST_LIBRARY_CURSOR, 50);
    expect(after.items).toEqual([]);
    expect(after.purged.map((p) => p.ref)).toEqual(["habitat.wetland"]);
    expect((await call("GET", "/smart-tags/terms")).json().hidden).toEqual([]);
  });

  it("sends decisions with the capture in the sync feed", async () => {
    const { capturesById } = await import("../sync/changes.js");
    const { pool } = await import("@lifer/core/db.js");
    const sent = (await capturesById(pool, USER, [managed, sunny])).get(managed)!;
    expect(sent.tags).toEqual(["flight shot"]);
    expect(sent.smartTagsAccepted).toEqual({});
    expect(sent.smartTagsRejected).toEqual(["color.green-tones"]);
  });
});
