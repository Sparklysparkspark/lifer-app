// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database. The server side
// (listChanges) and the desktop side (applyChanges) run against the same database as two users:
// what the "server" user has is mirrored under the "desktop" user, then kept in step.
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isoStamp, type CaptureChange, type UserSpeciesRow } from "./changes.js";

const url = process.env.TEST_DATABASE_URL;
const SERVER_USER = "eeeeeeee-0000-4000-8000-000000000701";
const DESKTOP_USER = "eeeeeeee-0000-4000-8000-000000000702";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000070a";
const UNKNOWN_SPECIES = "eeeeeeee-0000-4000-8000-00000000070b";

describe.skipIf(!url)("mirror", () => {
  let db: pg.Pool;
  let dataDir: string;
  let listChanges: typeof import("./changes.js").listChanges;
  let listUserSpecies: typeof import("./changes.js").listUserSpecies;
  let FIRST_CURSOR: typeof import("./changes.js").FIRST_CURSOR;
  let applyChanges: typeof import("./mirror.js").applyChanges;
  let fetchDerivatives: typeof import("./mirror.js").fetchDerivatives;
  let forgetMirrorCursor: typeof import("./mirror.js").forgetMirrorCursor;
  let applyUserSpecies: typeof import("./mirror.js").applyUserSpecies;
  let clearMirror: typeof import("./mirror.js").clearMirror;
  let dropCaptures: typeof import("./mirror.js").dropCaptures;
  const fetched: string[] = [];
  // Both sides share one database here, so the "desktop" gets the server's rows under fresh ids
  // (in real life the ids are the same on both sides, in two databases). The mapping is stable.
  const ids = new Map<string, string>();
  const local = (id: string) => ids.get(id) ?? (ids.set(id, randomUUID()), ids.get(id)!);
  const asDesktop = (items: CaptureChange[]) =>
    items.map((i) => ({ ...i, id: local(i.id), photo: i.photo && { ...i.photo, id: local(i.photo.id) } }));
  const marksAsDesktop = (rows: UserSpeciesRow[]) =>
    rows.map((r) => ({ ...r, coverPhotoId: r.coverPhotoId && local(r.coverPhotoId) }));
  const fetchFile = async (photoId: string, kind: string) => {
    fetched.push(`${kind}:${photoId}`);
    return Buffer.from("webp-bytes");
  };
  // In one transaction, as the pull runs it: pushed_at and updated_at then carry the same now().
  const apply = async (
    items: CaptureChange[],
    derivative: "thumb" | "medium",
    fetcher: (id: string, kind: string) => Promise<Buffer | null> = fetchFile,
  ) => {
    const files = await fetchDerivatives(db, DESKTOP_USER, items, fetcher, derivative);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await applyChanges(client, DESKTOP_USER, items, files, derivative);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = ANY($1)`, [[SERVER_USER, DESKTOP_USER]]);
    await db.query(`DELETE FROM captures_all WHERE user_id = ANY($1)`, [[SERVER_USER, DESKTOP_USER]]);
    await db.query(`DELETE FROM sync_tombstones WHERE user_id = ANY($1)`, [[SERVER_USER, DESKTOP_USER]]);
    await db.query(`DELETE FROM users WHERE id = ANY($1)`, [[SERVER_USER, DESKTOP_USER]]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SPECIES, UNKNOWN_SPECIES]]);
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-mirror-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = dataDir;
    db = new pg.Pool({ connectionString: url });
    ({ listChanges, listUserSpecies, FIRST_CURSOR } = await import("./changes.js"));
    ({ applyChanges, fetchDerivatives, forgetMirrorCursor, applyUserSpecies, clearMirror, dropCaptures } =
      await import("./mirror.js"));
    await cleanup();
    for (const id of [SERVER_USER, DESKTOP_USER])
      await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`, [id, `${id}@test`]);
    await db.query(
      `INSERT INTO species (id, scientific_name, common_name, taxon_class, gbif_key) VALUES ($1, 'Zzmirror testus', 'Mirror Bird', 'aves', 970001)`,
      [SPECIES],
    );
    await db.query(
      `INSERT INTO species (id, scientific_name, common_name, taxon_class, gbif_key) VALUES ($1, 'Zzmirror ignotus', 'Unknown Bird', 'aves', 970002)`,
      [UNKNOWN_SPECIES],
    );
  });
  afterAll(async () => {
    await cleanup();
    await db.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function serverCapture(speciesId: string, fingerprint: string) {
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures (user_id, species_id, fingerprint, taken_at, quality_rating, tags)
       VALUES ($1, $2, $3, '2026-05-01T10:00:00Z', 4, '{owl,night}') RETURNING id`,
      [SERVER_USER, speciesId, fingerprint],
    );
    const p = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path, width, height) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp', 3000, 2000) RETURNING id`,
      [c.rows[0].id],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
    return { captureId: c.rows[0].id, photoId: p.rows[0].id };
  }

  it("mirrors the server's captures under the server's ids, with the thumbnail, then follows edits and trash", async () => {
    const a = await serverCapture(SPECIES, "mirror-a");
    const unknown = await serverCapture(UNKNOWN_SPECIES, "mirror-b");
    // The desktop's catalog lacks the second species: simulate by renaming it out of reach.
    await db.query(`UPDATE species SET scientific_name = 'Zzmirror renamed' WHERE id = $1`, [UNKNOWN_SPECIES]);
    const page = await listChanges(db, SERVER_USER, FIRST_CURSOR, 100);
    expect(page.items.map((i) => i.id)).toEqual([a.captureId, unknown.captureId]);
    expect(page.next).toBeNull();
    await db.query(`UPDATE species SET scientific_name = 'Zzmirror gone' WHERE id = $1`, [UNKNOWN_SPECIES]);
    const items = page.items.map((i) => (i.id === unknown.captureId ? { ...i, scientificName: "Nope nope" } : i));

    const r = await apply(asDesktop(items), "thumb");
    expect(r).toEqual({ applied: 1, removed: 0, kept: 0, skippedSpecies: 1, firstMissing: null });
    const row = (
      await db.query(
        `SELECT origin, species_id, fingerprint, quality_rating, tags, current_photo_id FROM captures_all WHERE id = $1 AND user_id = $2`,
        [local(a.captureId), DESKTOP_USER],
      )
    ).rows[0];
    expect(row).toMatchObject({
      origin: "mirror",
      species_id: SPECIES,
      fingerprint: "mirror-a",
      quality_rating: 4,
      tags: ["owl", "night"],
      current_photo_id: local(a.photoId),
    });
    expect(fetched).toEqual([`thumb:${local(a.photoId)}`]);
    const thumb = path.join(dataDir, "thumb", `${local(a.photoId)}.webp`);
    expect(existsSync(thumb)).toBe(true);
    const photo = (
      await db.query(`SELECT display_path, thumb_path, width FROM photos WHERE id = $1`, [local(a.photoId)])
    ).rows[0];
    expect(photo).toEqual({ display_path: thumb, thumb_path: thumb, width: 3000 });

    // A rating change on the server reaches the mirror; the thumbnail isn't fetched again.
    await db.query(`UPDATE captures_all SET quality_rating = 5 WHERE id = $1`, [a.captureId]);
    const cursor = { since: page.items[1].updatedAt, after: page.items[1].id };
    const edits = await listChanges(db, SERVER_USER, cursor, 100);
    expect(edits.items.map((i) => i.id)).toEqual([a.captureId]);
    await apply(asDesktop(edits.items), "thumb");
    expect(
      (await db.query(`SELECT quality_rating FROM captures_all WHERE id = $1`, [local(a.captureId)])).rows[0]
        .quality_rating,
    ).toBe(5);
    expect(fetched).toHaveLength(1);

    // Trashed on the server: gone from the mirror, file and all.
    await db.query(`UPDATE captures_all SET deleted_at = now() WHERE id = $1`, [a.captureId]);
    const trash = await listChanges(db, SERVER_USER, { since: edits.items[0].updatedAt, after: a.captureId }, 100);
    expect(trash.items[0].deletedAt).not.toBeNull();
    const gone = await apply(asDesktop(trash.items), "thumb");
    expect(gone.removed).toBe(1);
    expect((await db.query(`SELECT 1 FROM captures_all WHERE id = $1`, [local(a.captureId)])).rowCount).toBe(0);
    expect(existsSync(thumb)).toBe(false);
  });

  it("takes the server's species marks and clears the mirror whole", async () => {
    const b = await serverCapture(SPECIES, "mirror-c");
    await db.query(
      `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, first_collected, is_target) VALUES ($1, $2, 'collected', $3, '2026-05-01', true)`,
      [SERVER_USER, SPECIES, b.photoId],
    );
    const page = await listChanges(db, SERVER_USER, FIRST_CURSOR, 100);
    await apply(asDesktop(page.items.filter((i) => !i.deletedAt)), "medium");
    expect(fetched.filter((f) => f.endsWith(local(b.photoId)))).toEqual([
      `thumb:${local(b.photoId)}`,
      `medium:${local(b.photoId)}`,
    ]);
    const n = await applyUserSpecies(db, DESKTOP_USER, marksAsDesktop(await listUserSpecies(db, SERVER_USER)));
    expect(n).toBe(1);
    const mark = (
      await db.query(
        `SELECT state, cover_photo_id, is_target FROM user_species WHERE user_id = $1 AND species_id = $2`,
        [DESKTOP_USER, SPECIES],
      )
    ).rows[0];
    expect(mark).toEqual({ state: "collected", cover_photo_id: local(b.photoId), is_target: true });

    await clearMirror(db, DESKTOP_USER);
    expect(
      (await db.query(`SELECT count(*)::int AS n FROM captures_all WHERE user_id = $1`, [DESKTOP_USER])).rows[0].n,
    ).toBe(0);
    expect(existsSync(path.join(dataDir, "medium", `${local(b.photoId)}.webp`))).toBe(false);
  });

  it("reports a capture whose file failed, takes it on a later try, and switching to medium fetches what's missing", async () => {
    const c = await serverCapture(SPECIES, "mirror-d");
    const items = asDesktop(
      (await listChanges(db, SERVER_USER, FIRST_CURSOR, 100)).items.filter((i) => i.id === c.captureId),
    );
    const failing = async (): Promise<Buffer | null> => null;
    expect((await apply(items, "thumb", failing)).firstMissing).toBe(0);
    expect(
      (await db.query(`SELECT current_photo_id FROM captures_all WHERE id = $1`, [local(c.captureId)])).rows[0]
        .current_photo_id,
    ).toBeNull();
    expect((await apply(items, "thumb")).firstMissing).toBeNull();
    expect(
      (await db.query(`SELECT current_photo_id FROM captures_all WHERE id = $1`, [local(c.captureId)])).rows[0]
        .current_photo_id,
    ).toBe(local(c.photoId));

    const count = async () =>
      (await db.query(`SELECT subject_count FROM captures_all WHERE id = $1`, [local(c.captureId)])).rows[0]
        .subject_count;
    await db.query(`UPDATE captures_all SET subject_count = 3 WHERE id = $1`, [local(c.captureId)]);
    const before = fetched.length;
    await apply(items, "medium");
    expect(fetched.slice(before)).toEqual([`medium:${local(c.photoId)}`]);
    const photo = (await db.query(`SELECT display_path FROM photos WHERE id = $1`, [local(c.photoId)])).rows[0];
    expect(photo.display_path).toBe(path.join(dataDir, "medium", `${local(c.photoId)}.webp`));
    // The same photo keeps its animal count; a different one is counted again.
    expect(await count()).toBe(3);
    await apply([{ ...items[0], photo: { ...items[0].photo!, id: randomUUID() } }], "thumb");
    expect(await count()).toBeNull();
  });

  it("refuses a photo id that isn't a uuid, and forgets the cursor", async () => {
    const c = await serverCapture(SPECIES, "mirror-e");
    const [item] = asDesktop(
      (await listChanges(db, SERVER_USER, FIRST_CURSOR, 100)).items.filter((i) => i.id === c.captureId),
    );
    await expect(apply([{ ...item, photo: { ...item.photo!, id: "../../evil" } }], "thumb")).rejects.toThrow(
      /invalid photo id/,
    );

    await db.query(
      `INSERT INTO install_settings (key, value) VALUES ('mirror_cursor', '{}') ON CONFLICT (key) DO NOTHING`,
    );
    await forgetMirrorCursor(db);
    expect((await db.query(`SELECT 1 FROM install_settings WHERE key = 'mirror_cursor'`)).rowCount).toBe(0);
  });
  // A capture imported on the desktop and pushed: the desktop row keeps its own id with the
  // server's in remote_id, as after a push.
  async function localCopyOf(serverId: string, fingerprint: string) {
    const id = randomUUID();
    await db.query(
      `INSERT INTO captures_all (id, user_id, species_id, fingerprint, quality_rating, remote_id, origin)
       VALUES ($1, $2, $3, $4, 1, $5, 'local')`,
      [id, DESKTOP_USER, SPECIES, fingerprint, local(serverId)],
    );
    await db.query(`UPDATE captures_all SET pushed_at = updated_at WHERE id = $1`, [id]);
    return id;
  }
  const localRow = async (id: string) =>
    (
      await db.query(
        `SELECT quality_rating, deleted_at IS NOT NULL AS trashed, ${isoStamp("remote_updated_at")} AS base,
                updated_at > pushed_at AS due FROM captures_all WHERE id = $1`,
        [id],
      )
    ).rows[0];

  it("leaves a capture edited here and not pushed yet, then takes the server's copy once it is", async () => {
    const s = await serverCapture(SPECIES, "mirror-local");
    const mine = await localCopyOf(s.captureId, "mirror-local");
    await db.query(`UPDATE captures_all SET quality_rating = 2 WHERE id = $1`, [mine]);
    const items = asDesktop(
      (await listChanges(db, SERVER_USER, FIRST_CURSOR, 100)).items.filter((i) => i.id === s.captureId),
    );

    expect(await apply(items, "thumb")).toMatchObject({ applied: 0, kept: 1 });
    expect(await localRow(mine)).toMatchObject({ quality_rating: 2, due: true });
    // The local copy keeps its own files: nothing fetched for it.
    expect(fetched.some((f) => f.endsWith(local(s.photoId)))).toBe(false);

    await db.query(`UPDATE captures_all SET pushed_at = updated_at WHERE id = $1`, [mine]);
    expect(await apply(items, "thumb")).toMatchObject({ applied: 1, kept: 0 });
    expect(await localRow(mine)).toEqual({ quality_rating: 4, trashed: false, base: items[0].updatedAt, due: false });
  });

  it("makes a mirrored capture due for a push once it is edited here, and leaves it alone until then", async () => {
    const s = await serverCapture(SPECIES, "mirror-edit");
    const items = asDesktop(
      (await listChanges(db, SERVER_USER, FIRST_CURSOR, 100)).items.filter((i) => i.id === s.captureId),
    );
    await apply(items, "thumb");
    const due = async () =>
      (
        await db.query(
          `SELECT ((origin = 'local' AND pushed_at IS NULL) OR updated_at > pushed_at) AS due FROM captures_all WHERE id = $1`,
          [local(s.captureId)],
        )
      ).rows[0].due;
    expect(await due()).toBe(false);
    await db.query(`UPDATE captures_all SET tags = '{edited}' WHERE id = $1`, [local(s.captureId)]);
    expect(await due()).toBe(true);
    // The server's copy doesn't replace the edit before it is pushed.
    expect(await apply(items, "thumb")).toMatchObject({ applied: 0, kept: 1 });
  });

  it("trashes a capture imported here when the server trashes or purges it", async () => {
    const s = await serverCapture(SPECIES, "mirror-trash");
    const mine = await localCopyOf(s.captureId, "mirror-trash");
    await db.query(`UPDATE captures_all SET deleted_at = now() WHERE id = $1`, [s.captureId]);
    const items = asDesktop(
      (await listChanges(db, SERVER_USER, FIRST_CURSOR, 100)).items.filter((i) => i.id === s.captureId),
    );
    expect((await apply(items, "thumb")).removed).toBe(1);
    expect(await localRow(mine)).toMatchObject({ trashed: true, due: false });

    // Purged: a desktop that missed the trash still hears of it, from the tombstone.
    const t = await serverCapture(SPECIES, "mirror-purge");
    const before = await listChanges(db, SERVER_USER, FIRST_CURSOR, 100);
    const theirs = await localCopyOf(t.captureId, "mirror-purge");
    await db.query(`DELETE FROM captures_all WHERE id = $1`, [t.captureId]);
    const after = await listChanges(db, SERVER_USER, before.last!, 100);
    expect(after.purged.map((p) => p.id)).toEqual([t.captureId]);
    expect(after.items).toEqual([]);
    expect(after.last).toEqual({ since: after.purged[0].deletedAt, after: t.captureId });
    const removed = await dropCaptures(
      db,
      DESKTOP_USER,
      after.purged.map((p) => ({ id: local(p.id), deletedAt: p.deletedAt, base: null })),
    );
    expect(removed).toBe(1);
    expect(await localRow(theirs)).toMatchObject({ trashed: true, base: null });
  });

  it("drops a mirrored capture the server purged", async () => {
    const s = await serverCapture(SPECIES, "mirror-gone");
    const page = await listChanges(db, SERVER_USER, FIRST_CURSOR, 100);
    await apply(asDesktop(page.items.filter((i) => i.id === s.captureId)), "thumb");
    await db.query(`DELETE FROM captures_all WHERE id = $1`, [s.captureId]);
    const after = await listChanges(db, SERVER_USER, page.last!, 100);
    await dropCaptures(
      db,
      DESKTOP_USER,
      after.purged.map((p) => ({ id: local(p.id), deletedAt: p.deletedAt, base: null })),
    );
    expect((await db.query(`SELECT 1 FROM captures_all WHERE id = $1`, [local(s.captureId)])).rowCount).toBe(0);
  });

  it("drops species marks the server no longer has, unless changed here or backed by a photo here", async () => {
    await db.query(`UPDATE captures_all SET deleted_at = now() WHERE user_id = $1`, [DESKTOP_USER]);
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [DESKTOP_USER]);
    await db.query(`INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'seen')`, [
      DESKTOP_USER,
      SPECIES,
    ]);
    const mark = () => db.query(`SELECT 1 FROM user_species WHERE user_id = $1`, [DESKTOP_USER]);
    // Never pushed: kept for the push.
    await applyUserSpecies(db, DESKTOP_USER, []);
    expect((await mark()).rowCount).toBe(1);
    await db.query(`UPDATE user_species SET pushed_at = updated_at WHERE user_id = $1`, [DESKTOP_USER]);
    await applyUserSpecies(db, DESKTOP_USER, []);
    expect((await mark()).rowCount).toBe(0);
  });

  it("doesn't move the cursor past a write whose transaction is still open", async () => {
    const page = await listChanges(db, SERVER_USER, FIRST_CURSOR, 500);
    const long = await db.connect();
    try {
      await long.query("BEGIN");
      const early = await long.query<{ id: string }>(
        `INSERT INTO captures (user_id, species_id, fingerprint) VALUES ($1, $2, 'mirror-long') RETURNING id`,
        [SERVER_USER, SPECIES],
      );
      // Committed meanwhile, stamped after the open transaction began.
      const later = await serverCapture(SPECIES, "mirror-later");
      expect((await listChanges(db, SERVER_USER, page.last!, 100)).items).toEqual([]);
      await long.query("COMMIT");
      const ids = (await listChanges(db, SERVER_USER, page.last!, 100)).items.map((i) => i.id);
      expect(ids).toEqual([early.rows[0].id, later.captureId]);
    } finally {
      long.release();
    }
  });
});
