// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database. The server side
// of a push: a capture is found by the shared id, else by fingerprint, else it needs the file,
// and an edit made on the server since the desktop's copy wins; deletions both ways; and the
// desktop side's bookkeeping: recording a push doesn't count as a change to push.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asSyncApply, isoStamp } from "./changes.js";
import {
  applyPushedCaptureDeletions,
  applyPushedCaptures,
  applyPushedUserSpecies,
  type PushedCapture,
} from "./pushServer.js";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000801";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000080a";
const SPECIES_B = "eeeeeeee-0000-4000-8000-00000000080b";
const SHARED_ID = "eeeeeeee-0000-4000-8000-000000000811";
const NEW_ID = "eeeeeeee-0000-4000-8000-000000000812";
const DESKTOP_ID = "eeeeeeee-0000-4000-8000-000000000813";

const item = (over: Partial<PushedCapture>): PushedCapture => ({
  id: NEW_ID,
  deletedAt: null,
  hiddenAt: null,
  scientificName: "Zzpush testus",
  fingerprint: "push-new",
  takenAt: "2026-06-01T08:00:00.000Z",
  lat: null,
  lon: null,
  cameraModel: null,
  lens: null,
  focalLengthMm: null,
  aperture: null,
  shutter: null,
  iso: null,
  qualityRating: 3,
  tags: ["push"],
  locationLabel: null,
  regionId: null,
  cullVerdict: null,
  cullLabel: null,
  baseUpdatedAt: null,
  ...over,
});
const stamp = async (db: pg.Pool, id: string) =>
  (await db.query(`SELECT ${isoStamp("updated_at")} AS u FROM captures_all WHERE id = $1`, [id])).rows[0].u as string;

describe.skipIf(!url)("push", () => {
  let db: pg.Pool;
  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM sync_tombstones WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SPECIES, SPECIES_B]]);
  }
  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'push@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, scientific_name, common_name, taxon_class, gbif_key) VALUES ($1, 'Zzpush testus', 'Push Bird', 'aves', 980001), ($2, 'Zzpush alter', 'Other Bird', 'aves', 980002)`,
      [SPECIES, SPECIES_B],
    );
    await db.query(
      `INSERT INTO captures_all (id, user_id, species_id, fingerprint, quality_rating) VALUES ($1, $2, $3, 'push-shared', 1), ($4, $2, $3, 'push-dup', 1)`,
      [SHARED_ID, USER, SPECIES, DESKTOP_ID],
    );
  });
  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  it("updates by shared id, takes a fingerprint match with no base as a conflict, and asks for files it lacks", async () => {
    const { outcomes, speciesIds } = await applyPushedCaptures(db, USER, [
      item({
        id: SHARED_ID,
        fingerprint: "push-shared",
        qualityRating: 5,
        scientificName: "Zzpush alter",
        tags: ["a", "b"],
        hiddenAt: "2026-06-02T00:00:00.000Z",
      }),
      item({ id: NEW_ID, fingerprint: "push-dup" }),
      item({ id: "eeeeeeee-0000-4000-8000-000000000814", fingerprint: "push-missing" }),
      item({ id: "eeeeeeee-0000-4000-8000-000000000815", fingerprint: "push-nospecies", scientificName: "Nope nope" }),
    ]);
    expect(outcomes).toEqual([
      { id: SHARED_ID, status: "updated", updatedAt: await stamp(db, SHARED_ID) },
      {
        id: NEW_ID,
        status: "conflict",
        serverId: DESKTOP_ID,
        current: expect.objectContaining({ id: DESKTOP_ID, fingerprint: "push-dup", qualityRating: 1 }),
      },
      { id: "eeeeeeee-0000-4000-8000-000000000814", status: "needs-file" },
      { id: "eeeeeeee-0000-4000-8000-000000000815", status: "unknown-species" },
    ]);
    expect((await db.query(`SELECT quality_rating FROM captures_all WHERE id = $1`, [DESKTOP_ID])).rows[0]).toEqual({
      quality_rating: 1,
    });
    expect(speciesIds).toEqual({ "Zzpush testus": SPECIES, "Zzpush alter": SPECIES_B, "Nope nope": null });
    const row = (
      await db.query(`SELECT species_id, quality_rating, tags, hidden_at FROM captures_all WHERE id = $1`, [SHARED_ID])
    ).rows[0];
    expect(row).toMatchObject({ species_id: SPECIES_B, quality_rating: 5, tags: ["a", "b"] });
    expect(row.hidden_at).not.toBeNull();
  });

  it("takes species marks, and recording a push leaves updated_at alone", async () => {
    const { count: n, stamps } = await applyPushedUserSpecies(db, USER, [
      {
        scientificName: "Zzpush testus",
        state: "seen",
        coverPhotoId: null,
        firstCollected: null,
        bestQuality: null,
        cardCropX: null,
        cardCropY: null,
        cardCropSize: null,
        isTarget: true,
      },
      {
        scientificName: "Nope nope",
        state: "seen",
        coverPhotoId: null,
        firstCollected: null,
        bestQuality: null,
        cardCropX: null,
        cardCropY: null,
        cardCropSize: null,
        isTarget: false,
      },
    ]);
    expect(n).toBe(1);
    expect(Object.keys(stamps)).toEqual(["Zzpush testus"]);
    const before = (
      await db.query(`SELECT updated_at FROM user_species WHERE user_id = $1 AND species_id = $2`, [USER, SPECIES])
    ).rows[0].updated_at;
    await db.query(`UPDATE user_species SET pushed_at = now() WHERE user_id = $1 AND species_id = $2`, [USER, SPECIES]);
    const after = (
      await db.query(`SELECT updated_at, pushed_at FROM user_species WHERE user_id = $1 AND species_id = $2`, [
        USER,
        SPECIES,
      ])
    ).rows[0];
    expect(after.updated_at).toEqual(before);
    expect(after.pushed_at).not.toBeNull();

    const c0 = (await db.query(`SELECT updated_at FROM captures_all WHERE id = $1`, [SHARED_ID])).rows[0].updated_at;
    await db.query(`UPDATE captures_all SET pushed_at = now(), remote_id = $2 WHERE id = $1`, [SHARED_ID, DESKTOP_ID]);
    expect(
      (await db.query(`SELECT updated_at FROM captures_all WHERE id = $1`, [SHARED_ID])).rows[0].updated_at,
    ).toEqual(c0);
    await db.query(`UPDATE captures_all SET quality_rating = 2 WHERE id = $1`, [SHARED_ID]);
    expect(
      (await db.query(`SELECT updated_at > pushed_at AS due FROM captures_all WHERE id = $1`, [SHARED_ID])).rows[0].due,
    ).toBe(true);
  });

  it("keeps the server link across pushes, and an edit made during a push stays due", async () => {
    process.env.DATABASE_URL = url;
    const { markPushed } = await import("./push.js");
    await db.query(`UPDATE captures_all SET remote_id = NULL, pushed_at = NULL WHERE id = $1`, [DESKTOP_ID]);
    const read = async () =>
      (await db.query(`SELECT updated_at::text AS u FROM captures_all WHERE id = $1`, [DESKTOP_ID])).rows[0]
        .u as string;

    // First push: the server knows the photo by another id and says so. (One database plays both
    // sides here, so the desktop's id as the server sees it is one the server lacks.)
    const asSent = "eeeeeeee-0000-4000-8000-000000000816";
    const first = await applyPushedCaptures(db, USER, [item({ id: asSent, fingerprint: "push-shared" })]);
    const conflict = first.outcomes[0];
    if (conflict.status !== "conflict") throw new Error(`expected a conflict, got ${conflict.status}`);
    expect(conflict.serverId).toBe(SHARED_ID);
    await markPushed(db, DESKTOP_ID, await read(), conflict.serverId, conflict.current!.updatedAt);
    // Second push goes by the server's id with the server's version, so it's written.
    await db.query(`UPDATE captures_all SET quality_rating = 4 WHERE id = $1`, [DESKTOP_ID]);
    const second = await applyPushedCaptures(db, USER, [
      item({ id: SHARED_ID, fingerprint: "push-shared", baseUpdatedAt: conflict.current!.updatedAt }),
    ]);
    expect(second.outcomes[0]).toMatchObject({ id: SHARED_ID, status: "updated" });
    const read2 = await read();
    // An edit lands while the push is out.
    await db.query(`UPDATE captures_all SET quality_rating = 1 WHERE id = $1`, [DESKTOP_ID]);
    await markPushed(db, DESKTOP_ID, read2);

    const row = (
      await db.query(`SELECT remote_id, updated_at > pushed_at AS due FROM captures_all WHERE id = $1`, [DESKTOP_ID])
    ).rows[0];
    expect(row).toEqual({ remote_id: SHARED_ID, due: true });
  });

  it("counts species marks still due as unpushed", async () => {
    process.env.DATABASE_URL = url;
    const { unpushedCount } = await import("./push.js");
    await db.query(`UPDATE user_species SET pushed_at = now() WHERE user_id = $1`, [USER]);
    const before = await unpushedCount(USER, db);
    await db.query(`UPDATE user_species SET pushed_at = NULL WHERE user_id = $1`, [USER]);
    expect(await unpushedCount(USER, db)).toBe(before + 1);
  });
  it("answers a stale push with the server's copy and changes nothing; a current one is written", async () => {
    const base = await stamp(db, SHARED_ID);
    // Edited on the server after the desktop's copy.
    await db.query(`UPDATE captures_all SET quality_rating = 2 WHERE id = $1`, [SHARED_ID]);
    const stale = await applyPushedCaptures(db, USER, [
      item({ id: SHARED_ID, fingerprint: "push-shared", qualityRating: 5, baseUpdatedAt: base }),
    ]);
    expect(stale.outcomes[0]).toMatchObject({ id: SHARED_ID, status: "conflict", current: { qualityRating: 2 } });
    expect((await db.query(`SELECT quality_rating FROM captures_all WHERE id = $1`, [SHARED_ID])).rows[0]).toEqual({
      quality_rating: 2,
    });
    const current = await applyPushedCaptures(db, USER, [
      item({ id: SHARED_ID, fingerprint: "push-shared", qualityRating: 5, baseUpdatedAt: await stamp(db, SHARED_ID) }),
    ]);
    expect(current.outcomes[0]).toEqual({ id: SHARED_ID, status: "updated", updatedAt: await stamp(db, SHARED_ID) });
    expect((await db.query(`SELECT quality_rating FROM captures_all WHERE id = $1`, [SHARED_ID])).rows[0]).toEqual({
      quality_rating: 5,
    });
  });

  it("never brings a capture back from the server's trash unless the desktop saw the trash", async () => {
    const base = await stamp(db, SHARED_ID);
    await db.query(`UPDATE captures_all SET deleted_at = now() WHERE id = $1`, [SHARED_ID]);
    const trashed = async () =>
      (await db.query(`SELECT deleted_at IS NOT NULL AS t FROM captures_all WHERE id = $1`, [SHARED_ID])).rows[0].t;
    for (const baseUpdatedAt of [base, null]) {
      const res = await applyPushedCaptures(db, USER, [
        item({ id: SHARED_ID, fingerprint: "push-shared", baseUpdatedAt }),
      ]);
      expect(res.outcomes[0]).toMatchObject({ status: "conflict", current: { id: SHARED_ID } });
      expect(res.outcomes[0].status === "conflict" && res.outcomes[0].current?.deletedAt).toBeTruthy();
      expect(await trashed()).toBe(true);
    }
    // Restored on the desktop after it had the trashed copy: a newer edit, so it's written.
    const restored = await applyPushedCaptures(db, USER, [
      item({ id: SHARED_ID, fingerprint: "push-shared", baseUpdatedAt: await stamp(db, SHARED_ID) }),
    ]);
    expect(restored.outcomes[0].status).toBe("updated");
    expect(await trashed()).toBe(false);
  });

  it("answers a push of a capture purged here as a conflict with no copy", async () => {
    const gone = "eeeeeeee-0000-4000-8000-000000000817";
    await db.query(
      `INSERT INTO captures_all (id, user_id, species_id, fingerprint, deleted_at) VALUES ($1, $2, $3, 'push-purged', now())`,
      [gone, USER, SPECIES],
    );
    await db.query(`DELETE FROM captures_all WHERE id = $1`, [gone]);
    const res = await applyPushedCaptures(db, USER, [item({ id: gone, fingerprint: "push-purged" })]);
    expect(res.outcomes).toEqual([{ id: gone, status: "conflict", current: null }]);
    expect((await db.query(`SELECT 1 FROM captures_all WHERE id = $1`, [gone])).rowCount).toBe(0);
  });

  it("records deletions as tombstones, but not the ones sync makes itself", async () => {
    const a = "eeeeeeee-0000-4000-8000-000000000818";
    const b = "eeeeeeee-0000-4000-8000-000000000819";
    await db.query(
      `INSERT INTO captures_all (id, user_id, species_id, fingerprint, remote_id, remote_updated_at)
       VALUES ($1, $3, $4, 'push-t1', $5, '2026-06-01T00:00:00Z'), ($2, $3, $4, 'push-t2', NULL, NULL)`,
      [a, b, USER, SPECIES, NEW_ID],
    );
    await db.query(`DELETE FROM captures_all WHERE id = $1`, [a]);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await asSyncApply(client);
      await client.query(`DELETE FROM captures_all WHERE id = $1`, [b]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const rows = (
      await db.query(
        `SELECT ref, base FROM sync_tombstones WHERE user_id = $1 AND kind = 'capture' AND ref = ANY($2)`,
        [USER, [NEW_ID, a, b]],
      )
    ).rows;
    // Recorded under the server's id, with the version the desktop had.
    expect(rows).toEqual([{ ref: NEW_ID, base: new Date("2026-06-01T00:00:00Z") }]);
  });

  it("trashes what the desktop deleted unless the server changed it since, and keeps marks with photos", async () => {
    const kept = "eeeeeeee-0000-4000-8000-00000000081a";
    const trashedHere = "eeeeeeee-0000-4000-8000-00000000081b";
    await db.query(
      `INSERT INTO captures_all (id, user_id, species_id, fingerprint) VALUES ($1, $3, $4, 'push-d1'), ($2, $3, $4, 'push-d2')`,
      [kept, trashedHere, USER, SPECIES_B],
    );
    const staleBase = await stamp(db, kept);
    await db.query(`UPDATE captures_all SET tags = '{edited}' WHERE id = $1`, [kept]);
    const n = await applyPushedCaptureDeletions(db, USER, [
      { id: kept, baseUpdatedAt: staleBase },
      { id: trashedHere, baseUpdatedAt: await stamp(db, trashedHere) },
    ]);
    expect(n).toBe(1);
    const live = (
      await db.query(`SELECT id FROM captures_all WHERE id = ANY($1) AND deleted_at IS NULL`, [[kept, trashedHere]])
    ).rows.map((r) => r.id);
    expect(live).toEqual([kept]);

    // Species B still has a live photo here, so its mark stays; species A's (no live photo) goes.
    await db.query(`UPDATE captures_all SET deleted_at = now() WHERE user_id = $1 AND species_id = $2`, [
      USER,
      SPECIES,
    ]);
    await db.query(
      `INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'seen'), ($1, $3, 'collected')
       ON CONFLICT (user_id, species_id) DO NOTHING`,
      [USER, SPECIES, SPECIES_B],
    );
    await applyPushedUserSpecies(db, USER, [], ["Zzpush testus", "Zzpush alter"]);
    const marks = (await db.query(`SELECT species_id FROM user_species WHERE user_id = $1`, [USER])).rows;
    expect(marks).toEqual([{ species_id: SPECIES_B }]);
  });

  it("writes a pushed mark only if the server's copy is unchanged since its base", async () => {
    const mark = (isTarget: boolean, baseUpdatedAt: string | null) => ({
      scientificName: "Zzpush testus",
      state: "seen" as const,
      coverPhotoId: null,
      firstCollected: null,
      bestQuality: null,
      cardCropX: null,
      cardCropY: null,
      cardCropSize: null,
      isTarget,
      baseUpdatedAt,
    });
    const first = await applyPushedUserSpecies(db, USER, [mark(true, null)]);
    const base = first.stamps["Zzpush testus"];
    const fresh = await applyPushedUserSpecies(db, USER, [mark(false, base)]);
    expect(fresh.count).toBe(1);
    // The same base again is stale now: nothing written, the server's mark comes back.
    const stale = await applyPushedUserSpecies(db, USER, [mark(true, base)]);
    expect(stale.count).toBe(0);
    expect(stale.conflicts).toMatchObject([{ scientificName: "Zzpush testus", isTarget: false }]);
  });
});
