// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// The archive health pass against real files: what it flags, what it quietly accepts, and what it
// leaves for later.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const LOCAL_EMAIL = "local@lifer.app";
const LAUNCH_TOKEN = "health-test-launch-token";
const HEADERS = { "x-lifer-launch-token": LAUNCH_TOKEN };
const FAST = 1e12;

const sha = (data: string) => createHash("sha256").update(data).digest("hex");

describe.skipIf(!url)("archive health", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dir: string;
  let userId: string;
  let localUserExisted = false;
  let health: typeof import("./health.js");

  const get = async (route: string) => (await app.inject({ method: "GET", url: route, headers: HEADERS })).json();
  const row = async (id: string) =>
    (
      await db.query<{ health: string | null; checked_at: Date | null; verified_hash: string | null; stale: boolean }>(
        `SELECT health, checked_at, verified_hash, stale FROM originals WHERE id = $1`,
        [id],
      )
    ).rows[0];

  // A file on disk plus its row, baselined as of now unless told otherwise.
  async function addFile(
    name: string,
    content: string,
    opts: { baseline?: boolean; volumeId?: string; stale?: boolean } = {},
  ): Promise<{ id: string; file: string; mtime: Date }> {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    const mtime = new Date("2022-03-04T05:06:07.000Z");
    utimesSync(file, mtime, mtime);
    const baseline = opts.baseline ?? true;
    const res = await db.query<{ id: string }>(
      `INSERT INTO originals (user_id, kind, ref_type, ref, managed, content_hash, file_size,
         verified_hash, verified_mtime, volume_id, volume_relative_path, stale)
       VALUES ($1, 'jpeg', 'path', $2, true, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        userId,
        file,
        sha(content),
        content.length,
        baseline ? sha(content) : null,
        baseline ? mtime : null,
        opts.volumeId ?? null,
        opts.volumeId ? `/${name}` : null,
        opts.stale ?? false,
      ],
    );
    return { id: res.rows[0].id, file, mtime };
  }

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "lifer-health-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dir;
    process.env.APP_DATA_DIR = path.join(dir, "app-data");
    process.env.SINGLE_USER_MODE = "1";
    process.env.LIFER_LAUNCH_TOKEN = LAUNCH_TOKEN;
    process.env.LIFER_ALLOW_UNTOKENED_DESKTOP = "0";
    db = new pg.Pool({ connectionString: url });
    localUserExisted = (await db.query(`SELECT 1 FROM users WHERE email = $1`, [LOCAL_EMAIL])).rows.length > 0;
    health = await import("./health.js");
    const { originalsRoutes } = await import("./routes.js");
    app = Fastify();
    await app.register(originalsRoutes, { prefix: "/api" });
    await app.ready();
    // Signs in (and creates) the desktop user, and makes sure the check is on.
    const on = await app.inject({
      method: "PUT",
      url: "/api/originals/health",
      headers: HEADERS,
      payload: { enabled: true },
    });
    expect(on.statusCode).toBe(200);
    await health.archiveHealthJob.settled();
    userId = (await db.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [LOCAL_EMAIL])).rows[0].id;
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM originals WHERE starts_with(ref, $1)`, [dir]);
      await db.query(`DELETE FROM storage_volumes WHERE label = 'Health test drive'`);
      if (!localUserExisted) await db.query(`DELETE FROM users WHERE email = $1`, [LOCAL_EMAIL]);
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });

  it("re-baselines an edit with a new modification time without flagging it", async () => {
    const { id, file } = await addFile("edited.jpg", "original bytes");
    writeFileSync(file, "edited in Lightroom");
    await health.startArchiveHealthPass(FAST);
    const r = await row(id);
    expect(r.health).toBeNull();
    expect(r.verified_hash).toBe(sha("edited in Lightroom"));
    expect(r.checked_at).not.toBeNull();
  });

  it("flags different bytes under the same modification time as changed", async () => {
    const { id, file, mtime } = await addFile("rotted.jpg", "good bytes");
    writeFileSync(file, "badd bytes");
    utimesSync(file, mtime, mtime);
    await health.startArchiveHealthPass(FAST);
    expect((await row(id)).health).toBe("changed");
    const list = await get("/api/originals/health/problems");
    expect(list.items).toContainEqual(expect.objectContaining({ id, path: file, problem: "changed" }));
  });

  it("flags unreadable and missing files, and skips a file whose whole folder is gone", async () => {
    const unreadable = await addFile("locked.jpg", "locked");
    chmodSync(unreadable.file, 0o000);
    const missing = await addFile("gone.jpg", "gone");
    unlinkSync(missing.file);
    const folderGone = await addFile("unplugged/a.jpg", "a");
    rmSync(path.dirname(folderGone.file), { recursive: true });
    await health.startArchiveHealthPass(FAST);
    chmodSync(unreadable.file, 0o644);
    expect((await row(unreadable.id)).health).toBe("unreadable");
    expect((await row(missing.id)).health).toBe("missing");
    expect(await row(folderGone.id)).toMatchObject({ health: null, checked_at: null });
  });

  it("lists files the trip scan marked stale as missing", async () => {
    const { id } = await addFile("stale.jpg", "stale", { stale: true });
    const list = await get("/api/originals/health/problems");
    expect(list.items).toContainEqual(expect.objectContaining({ id, problem: "missing" }));
  });

  it("Ignore accepts a changed file's contents as its new baseline", async () => {
    const { id, file, mtime } = await addFile("accepted.jpg", "first");
    writeFileSync(file, "secnd");
    utimesSync(file, mtime, mtime);
    await health.startArchiveHealthPass(FAST);
    expect((await row(id)).health).toBe("changed");
    const res = await app.inject({ method: "POST", url: `/api/originals/${id}/health/ignore`, headers: HEADERS });
    expect(res.statusCode).toBe(200);
    expect((await get("/api/originals/health/problems")).items.map((i: { id: string }) => i.id)).not.toContain(id);
    await health.startArchiveHealthPass(FAST);
    expect(await row(id)).toMatchObject({ health: null, verified_hash: sha("secnd") });
  });

  it("Ignore hides a missing file until it comes back, then clears itself", async () => {
    const { id, file } = await addFile("away.jpg", "away");
    unlinkSync(file);
    await health.startArchiveHealthPass(FAST);
    await app.inject({ method: "POST", url: `/api/originals/${id}/health/ignore`, headers: HEADERS });
    expect((await row(id)).health).toBe("ignored");
    expect((await get("/api/originals/health")).problemCount).toBe((await get("/api/originals/health/problems")).total);

    writeFileSync(file, "away");
    // Missing and ignored files are looked at again daily.
    await db.query(`UPDATE originals SET checked_at = now() - interval '2 days' WHERE id = $1`, [id]);
    await health.startArchiveHealthPass(FAST);
    expect((await row(id)).health).toBeNull();
  });

  it("Ignore all clears every problem in one go, past the list's limit", async () => {
    const { id: changedId, file, mtime } = await addFile("all-changed.jpg", "first");
    writeFileSync(file, "secnd");
    utimesSync(file, mtime, mtime);
    await health.startArchiveHealthPass(FAST);
    // More than the list shows, as a failing drive would flag.
    await db.query(
      `INSERT INTO originals (user_id, kind, ref_type, ref, managed, content_hash, file_size, stale)
       SELECT $1, 'jpeg', 'path', $2 || n || '.jpg', true, md5(n::text), 1, true FROM generate_series(1, 2500) n`,
      [userId, path.join(dir, "many", "f")],
    );
    expect((await get("/api/originals/health")).problemCount).toBeGreaterThan(2500);
    const res = await app.inject({ method: "POST", url: "/api/originals/health/ignore-all", headers: HEADERS });
    expect(res.json().ignored).toBeGreaterThan(2500);
    expect((await get("/api/originals/health")).problemCount).toBe(0);
    expect((await get("/api/originals/health/problems")).total).toBe(0);
    // A changed file is accepted as it is now, as with a single Ignore.
    expect(await row(changedId)).toMatchObject({ health: null, verified_hash: null });
    await db.query(`DELETE FROM originals WHERE starts_with(ref, $1)`, [path.join(dir, "many")]);
  });

  it("skips files on a disconnected drive and says how many wait for it", async () => {
    const volume = await db.query<{ id: string }>(
      `INSERT INTO storage_volumes (user_id, kind, label, root_path, last_known_mount_path)
       VALUES (NULL, 'root', 'Health test drive', $1, $1)
       RETURNING id`,
      [path.join(dir, "not-mounted")],
    );
    const { id } = await addFile("on-drive.jpg", "drive", { volumeId: volume.rows[0].id });
    await health.startArchiveHealthPass(FAST);
    expect((await row(id)).checked_at).toBeNull();
    const summary = await get("/api/originals/health");
    expect(summary.notChecked).toContainEqual({ label: "Health test drive", count: 1 });
  });

  it("resumes where it stopped", async () => {
    const files = [await addFile("r1.jpg", "1"), await addFile("r2.jpg", "2"), await addFile("r3.jpg", "3")];
    const ids = files.map((f) => f.id);
    const checked = async () =>
      Number(
        (await db.query(`SELECT count(*) AS n FROM originals WHERE id = ANY($1) AND checked_at IS NOT NULL`, [ids]))
          .rows[0].n,
      );
    // One byte a second: the pass sleeps after its first file, long enough to stop it there.
    const pass = health.startArchiveHealthPass(1);
    while ((await checked()) === 0) await new Promise((r) => setTimeout(r, 20));
    health.archiveHealthJob.cancel();
    await pass;
    expect(await checked()).toBe(1);
    await health.startArchiveHealthPass(FAST);
    expect(await checked()).toBe(3);
  });

  // Last: an import makes the pass wait a minute for imports to settle.
  it("stores a baseline when a file is imported", async () => {
    const { insertOriginal } = await import("../uploads/captureRows.js");
    const file = path.join(dir, "imported.jpg");
    writeFileSync(file, "imported");
    const id = await insertOriginal(db, {
      userId,
      captureId: null,
      kind: "jpeg",
      ref: file,
      managed: true,
      contentHash: sha("imported"),
      fileSize: 8,
    });
    const r = await db.query<{ verified_hash: string; verified_mtime: Date; checked_at: Date | null }>(
      `SELECT verified_hash, verified_mtime, checked_at FROM originals WHERE id = $1`,
      [id],
    );
    expect(r.rows[0].verified_hash).toBe(sha("imported"));
    expect(r.rows[0].verified_mtime.getTime()).toBe(statSync(file).mtime.getTime());
    expect(r.rows[0].checked_at).not.toBeNull();
  });
});
