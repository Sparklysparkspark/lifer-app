// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Importing a folder again: the batch lookup, the memory of left-out photos and the desktop's
// remembered folders, against real files in a temp folder.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const LOCAL_EMAIL = "local@lifer.app";
const LAUNCH_TOKEN = "known-files-test-launch-token";

/** The web's fingerprint (lib/fileFingerprint.ts), written out independently. */
function webQuickHash(bytes: Buffer): string {
  const edge = 64 * 1024;
  const parts = [Buffer.from(String(bytes.length)), bytes.subarray(0, edge)];
  if (bytes.length > edge) parts.push(bytes.subarray(Math.max(edge, bytes.length - edge)));
  return createHash("sha1").update(Buffer.concat(parts)).digest("hex");
}

describe.skipIf(!url)("importing a folder again", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dir: string;
  let userId: string;
  let localUserExisted = false;

  const call = (method: "GET" | "POST", u: string, payload?: object) =>
    app.inject({ method, url: `/api${u}`, headers: { "x-lifer-launch-token": LAUNCH_TOKEN }, payload });

  const photo = (name: string, bytes: Buffer) => {
    const p = path.join(dir, "folder", name);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, bytes);
    return p;
  };

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "lifer-known-files-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dir;
    process.env.APP_DATA_DIR = path.join(dir, "app-data");
    process.env.SINGLE_USER_MODE = "1";
    process.env.LIFER_LAUNCH_TOKEN = LAUNCH_TOKEN;
    process.env.LIFER_ALLOW_UNTOKENED_DESKTOP = "0";
    db = new pg.Pool({ connectionString: url });
    localUserExisted = (await db.query(`SELECT 1 FROM users WHERE email = $1`, [LOCAL_EMAIL])).rows.length > 0;
    const { knownFilesRoutes } = await import("./knownFilesRoutes.js");
    app = Fastify();
    await app.register(knownFilesRoutes, { prefix: "/api" });
    await app.ready();
    // The first request provisions the desktop user.
    await call("GET", "/uploads/skipped");
    userId = (await db.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [LOCAL_EMAIL])).rows[0].id;
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM originals WHERE user_id = $1`, [userId]);
      for (const t of ["import_skipped_files", "import_source_folders", "import_source_files"])
        await db.query(`DELETE FROM ${t} WHERE user_id = $1`, [userId]);
      if (!localUserExisted) await db.query(`DELETE FROM users WHERE email = $1`, [LOCAL_EMAIL]);
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("records an imported file's hash as picked, and the batch lookup finds it", async () => {
    // Bigger than two edges, so the tail is read too.
    const bytes = Buffer.alloc(200 * 1024, 7);
    bytes.write("imported", 150 * 1024);
    const file = photo("imported.cr3", bytes);
    const { insertOriginal } = await import("./captureRows.js");
    const { pool } = await import("@lifer/core/db.js");
    await insertOriginal(pool, {
      userId,
      captureId: null,
      kind: "raw",
      ref: file,
      managed: false,
      contentHash: "c".repeat(64),
      fileSize: bytes.length,
    });
    const fp = webQuickHash(bytes);
    const other = webQuickHash(Buffer.from("never seen"));
    const res = await call("POST", "/uploads/known", { fingerprints: [fp, other] });
    // Not linked to a photo, so there's none to show beside it.
    expect(res.json()).toEqual({ known: [{ fingerprint: fp, status: "imported", reason: null, match: null }] });
  });

  it("remembers left-out photos idempotently, lists them and forgets them", async () => {
    const fp = webQuickHash(Buffer.from("a blurry leaf"));
    const body = { files: [{ fingerprint: fp, name: "leaf.jpg", size: 13, reason: "not_wildlife" }] };
    expect((await call("POST", "/uploads/skipped", body)).statusCode).toBe(200);
    expect((await call("POST", "/uploads/skipped", body)).statusCode).toBe(200);
    const list = (await call("GET", "/uploads/skipped")).json();
    expect(list.total).toBe(1);
    expect(list.files[0]).toMatchObject({ fingerprint: fp, name: "leaf.jpg", reason: "not_wildlife" });
    expect((await call("POST", "/uploads/known", { fingerprints: [fp] })).json().known).toEqual([
      { fingerprint: fp, status: "skipped", reason: "not_wildlife", match: null },
    ]);
    await call("POST", "/uploads/skipped/forget", { fingerprints: [fp] });
    expect((await call("POST", "/uploads/known", { fingerprints: [fp] })).json().known).toEqual([]);
  });

  it("refuses a malformed or oversized batch", async () => {
    expect((await call("POST", "/uploads/known", { fingerprints: ["nope"] })).statusCode).toBe(400);
    const tooMany = Array.from({ length: 2001 }, (_, i) => createHash("sha1").update(String(i)).digest("hex"));
    expect((await call("POST", "/uploads/known", { fingerprints: tooMany })).statusCode).toBe(400);
  });

  it("scans a folder: known by content even when renamed, new, edited in place, left out", async () => {
    const folder = path.join(dir, "folder");
    const known = Buffer.alloc(100 * 1024, 1);
    photo("renamed-copy.jpg", known);
    await db.query(
      `INSERT INTO import_skipped_files (user_id, fingerprint, reason, name, size) VALUES ($1,$2,'removed','x.jpg',3)`,
      [userId, webQuickHash(Buffer.from("xyz"))],
    );
    photo("left-out.jpg", Buffer.from("xyz"));
    photo("new.jpg", Buffer.from("brand new"));
    photo("notes.txt", Buffer.from("not a photo"));
    const { pool } = await import("@lifer/core/db.js");
    const { insertOriginal } = await import("./captureRows.js");
    const elsewhere = path.join(dir, "elsewhere.jpg");
    writeFileSync(elsewhere, known);
    await insertOriginal(pool, {
      userId,
      captureId: null,
      kind: "raw",
      ref: elsewhere,
      managed: false,
      contentHash: "d".repeat(64),
      fileSize: known.length,
    });

    const first = (await call("POST", "/uploads/source-folders/scan", { path: folder })).json();
    const by = (name: string) => first.files.find((f: { name: string }) => f.name === name);
    expect(first.files.map((f: { name: string }) => f.name).sort()).toEqual([
      "imported.cr3",
      "left-out.jpg",
      "new.jpg",
      "renamed-copy.jpg",
    ]);
    expect(by("imported.cr3").status).toBe("imported");
    expect(by("renamed-copy.jpg").status).toBe("imported");
    expect(by("left-out.jpg").status).toBe("skipped");
    expect(by("new.jpg")).toMatchObject({ status: "new", edited: false });

    const folders = (await call("GET", "/uploads/source-folders")).json().folders;
    expect(folders).toEqual([expect.objectContaining({ path: folder, photoCount: 2 })]);

    // Stat-only: one new file and one edit in place count as new, without reading anything.
    photo("another.jpg", Buffer.from("added later"));
    const edited = photo("renamed-copy.jpg", Buffer.concat([known, Buffer.from("edited")]));
    utimesSync(edited, new Date(), new Date(Date.now() + 5000));
    expect((await call("POST", "/uploads/source-folders/new-count", { path: folder })).json()).toEqual({
      available: true,
      newCount: 3,
    });
    const second = (await call("POST", "/uploads/source-folders/scan", { path: folder })).json();
    expect(second.files.find((f: { name: string }) => f.name === "renamed-copy.jpg")).toMatchObject({
      status: "new",
      edited: true,
    });
    // Idempotent: scanning again changes nothing.
    const third = (await call("POST", "/uploads/source-folders/scan", { path: folder })).json();
    expect(third.files.map((f: { status: string }) => f.status).sort()).toEqual(
      second.files.map((f: { status: string }) => f.status).sort(),
    );
  });

  it("serves a file only from a remembered folder", async () => {
    const inside = path.join(dir, "folder", "new.jpg");
    const ok = await call("GET", `/uploads/source-folders/file?path=${encodeURIComponent(inside)}`);
    expect([ok.statusCode, ok.body]).toEqual([200, "brand new"]);
    const outside = await call(
      "GET",
      `/uploads/source-folders/file?path=${encodeURIComponent(path.join(dir, "elsewhere.jpg"))}`,
    );
    expect(outside.statusCode).toBe(403);
    const sneaky = await call(
      "GET",
      `/uploads/source-folders/file?path=${encodeURIComponent(path.join(dir, "folder", "..", "elsewhere.jpg"))}`,
    );
    expect(sneaky.statusCode).toBe(403);
  });
});
