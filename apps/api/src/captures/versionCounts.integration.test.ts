// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test npx vitest run versionCounts
// The stack badge's count: a RAW-only capture is a file of its photo, not a version.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000003101";
const OTHER = "eeeeeeee-0000-4000-8000-000000003102";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000310a";
const TOKEN = "lifer_test_version_counts_3101";
const OTHER_TOKEN = "lifer_test_version_counts_3102";

describe.skipIf(!url)("version counts", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;
  const ids: Record<string, string> = {};

  const counts = async (token = TOKEN) =>
    (await app.inject({ method: "GET", url: "/api/captures/version-counts", cookies: { [cookieName]: token } })).json()
      .counts;

  // A capture with one file per kind, e.g. ["raw"] or ["jpeg", "raw"].
  async function addCapture(key: string, kinds: string[], user = USER) {
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures (user_id, species_id, fingerprint, taken_at) VALUES ($1, $2, $3, now()) RETURNING id`,
      [user, SPECIES, `counts-${key}`],
    );
    for (const kind of kinds) {
      await db.query(
        `INSERT INTO originals (user_id, capture_id, kind, ref_type, ref, managed, content_hash, file_size)
         VALUES ($1, $2, $3, 'path', $4, false, $5, 1000)`,
        [user, c.rows[0].id, kind, `/lib/${key}.${kind}`, `counts-hash-${key}-${kind}`],
      );
    }
    ids[key] = c.rows[0].id;
  }
  const link = (key: string, group: string, user = USER) =>
    db.query(
      `INSERT INTO capture_versions (capture_id, group_capture_id, user_id, evidence, state)
       VALUES ($1, $2, $3, 'manual', 'linked')`,
      [ids[key], ids[group], user],
    );

  async function cleanup() {
    await db.query(`DELETE FROM captures_all WHERE user_id = ANY($1::uuid[])`, [[USER, OTHER]]);
    await db.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[USER, OTHER]]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { captureRoutes } = await import("./routes.js");

    await cleanup();
    await db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'counts@test', 'x'), ($2, 'counts2@test', 'x')`,
      [USER, OTHER],
    );
    await db.query(
      `INSERT INTO sessions (id, user_id, expires_at)
       VALUES ($1, $2, now() + interval '1 day'), ($3, $4, now() + interval '1 day')`,
      [hashToken(TOKEN), USER, hashToken(OTHER_TOKEN), OTHER],
    );
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 923101, 'Alces countus', 'Counting Moose', 'mammalia')`,
      [SPECIES],
    );

    // A RAW with its edited JPG linked behind it (an edit imported after its RAW).
    await addCapture("raw", ["raw"]);
    await addCapture("rawEdit", ["jpeg"]);
    await link("rawEdit", "raw");
    // The same, with a print too.
    await addCapture("raw2", ["raw"]);
    await addCapture("raw2Edit", ["jpeg"]);
    await addCapture("raw2Print", ["jpeg"]);
    await link("raw2Edit", "raw2");
    await link("raw2Print", "raw2");
    // Only JPG versions.
    await addCapture("jpg", ["jpeg"]);
    await addCapture("jpgBw", ["jpeg"]);
    await addCapture("jpgPano", ["jpeg"]);
    await link("jpgBw", "jpg");
    await link("jpgPano", "jpg");
    // A RAW and its JPG on one capture, with an export linked, and a RAW of its own linked too.
    await addCapture("pair", ["jpeg", "raw"]);
    await addCapture("pairExport", ["jpeg"]);
    await addCapture("pairRaw", ["raw"]);
    await link("pairExport", "pair");
    await link("pairRaw", "pair");
    // A RAW alone.
    await addCapture("solo", ["raw"]);
    // Another user's group.
    await addCapture("theirs", ["raw"], OTHER);
    await addCapture("theirsEdit", ["jpeg"], OTHER);
    await addCapture("theirsPrint", ["jpeg"], OTHER);
    await link("theirsEdit", "theirs", OTHER);
    await link("theirsPrint", "theirs", OTHER);

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

  it("counts only members with a file other than a RAW", async () => {
    expect(await counts()).toEqual({
      // 1 shows no badge.
      [ids.raw]: 1,
      [ids.raw2]: 2,
      [ids.jpg]: 3,
      [ids.pair]: 2,
    });
  });

  it("answers each user with their own groups only", async () => {
    expect(await counts(OTHER_TOKEN)).toEqual({ [ids.theirs]: 2 });
    const theirs = await app.inject({
      method: "GET",
      url: `/api/captures/${ids.raw}/versions`,
      cookies: { [cookieName]: OTHER_TOKEN },
    });
    expect(theirs.statusCode).toBe(404);
  });

  it("still lists the RAW as a version to switch to, marked as RAW only", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/captures/${ids.rawEdit}/versions`,
      cookies: { [cookieName]: TOKEN },
    });
    const body = res.json();
    expect(body.groupCaptureId).toBe(ids.raw);
    expect(body.files).toHaveLength(2);
    expect(
      Object.fromEntries(body.versions.map((v: { captureId: string; rawOnly: boolean }) => [v.captureId, v.rawOnly])),
    ).toEqual({ [ids.raw]: true, [ids.rawEdit]: false });
    // A RAW beside a JPG on one capture is that capture's file, not a RAW-only version.
    const pair = (
      await app.inject({ method: "GET", url: `/api/captures/${ids.pair}/versions`, cookies: { [cookieName]: TOKEN } })
    ).json();
    expect(
      pair.versions.filter((v: { rawOnly: boolean }) => v.rawOnly).map((v: { captureId: string }) => v.captureId),
    ).toEqual([ids.pairRaw]);
  });
});
