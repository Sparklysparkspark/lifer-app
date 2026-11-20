// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Link an Immich server, sync an album against recorded API answers, sync again (nothing new),
// then write species tags back. fetch is mocked, so nothing leaves the test.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fixture from "./__fixtures__/immich-api.json" with { type: "json" };

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000861";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000862";
const TOKEN = "lifer_test_immich_routes_861";
const SERVER = "http://192.168.1.50:2283";
const ALBUM = "a1b2c3d4-0000-4000-8000-000000000001";
const id = (letter: string) => `0e9a7f10-0000-4000-8000-00000000000${letter}`;

const originals = new Map<string, Buffer>();
const calls: { method: string; path: string; body: unknown }[] = [];
let version = fixture["GET /api/server/version"];

async function fakeImmich(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const u = new URL(String(input));
  const method = init.method ?? "GET";
  calls.push({ method, path: u.pathname, body: init.body ? JSON.parse(String(init.body)) : null });
  if ((init.headers as Record<string, string>)["x-api-key"] !== "immich-key")
    return new Response("{}", { status: 401 });
  const original = /^\/api\/assets\/([^/]+)\/original$/.exec(u.pathname);
  if (original) return new Response(new Uint8Array(originals.get(original[1])!));
  if (method === "GET" && u.pathname === "/api/server/version") return Response.json(version);
  if (/^\/api\/tags\/[^/]+\/assets$/.test(u.pathname)) return Response.json([]);
  const recorded = (fixture as Record<string, unknown>)[`${method} ${u.pathname}`];
  return recorded === undefined ? new Response("{}", { status: 404 }) : Response.json(recorded);
}

const jpeg = (r: number, g: number, b: number) =>
  sharp({ create: { width: 64, height: 48, channels: 3, background: { r, g, b } } })
    .jpeg()
    .toBuffer();

describe.skipIf(!url)("immich routes", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName: string;
  let existingCapture: string;

  const call = (method: "GET" | "POST" | "PUT" | "DELETE", route: string, payload?: object) =>
    app.inject({ method, url: `/api${route}`, payload, cookies: { [cookieName]: TOKEN } });

  async function syncAndWait() {
    const started = await call("POST", "/immich/sync");
    expect(started.statusCode).toBe(202);
    const { syncJob } = await import("./sync.js");
    await syncJob(USER).settled();
    return { ...(await call("GET", "/immich/status")).json(), job: (await call("GET", "/immich/sync/status")).json() };
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-immich-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    vi.stubGlobal("fetch", vi.fn(fakeImmich));
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { immichRoutes } = await import("./routes.js");
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'immich-routes@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 990000861, 'Immichia testensis', 'Immich Test Heron', 'aves')`,
      [SPECIES],
    );
    originals.set(id("a"), await jpeg(200, 40, 40));
    originals.set(id("d"), await jpeg(40, 200, 40));
    originals.set(id("e"), await jpeg(40, 40, 200));
    // A photo the user already has in Lifer, byte for byte the same as asset e.
    existingCapture = (
      await db.query<{ id: string }>(
        `INSERT INTO captures_all (user_id, species_id, fingerprint) VALUES ($1, $2, $3) RETURNING id`,
        [
          USER,
          SPECIES,
          createHash("sha256")
            .update(originals.get(id("e"))!)
            .digest("hex"),
        ],
      )
    ).rows[0].id;
    app = Fastify();
    await app.register(cookie);
    await app.register(immichRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllGlobals();
    if (db) {
      await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
      await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
      await db.end();
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("sends nothing to Immich before a server is linked", async () => {
    const status = (await call("GET", "/immich/status")).json();
    expect(status.linked).toBe(false);
    expect((await call("POST", "/immich/sync")).statusCode).toBe(404);
    expect(calls).toEqual([]);
  });

  it("refuses an Immich older than the minimum version", async () => {
    version = { major: 1, minor: 100, patch: 0 };
    const res = await call("POST", "/immich/link", { serverUrl: SERVER, apiKey: "immich-key" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("immich_too_old");
    version = fixture["GET /api/server/version"];
  });

  it("refuses a key Immich doesn't accept", async () => {
    const res = await call("POST", "/immich/link", { serverUrl: SERVER, apiKey: "wrong" });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/API key/);
  });

  it("links with the key stored encrypted, and lists albums", async () => {
    const res = await call("POST", "/immich/link", { serverUrl: `${SERVER}/api/`, apiKey: "immich-key" });
    expect(res.statusCode).toBe(200);
    const row = (await db.query(`SELECT server_url, api_key FROM immich_links WHERE user_id = $1`, [USER])).rows[0];
    expect(row.server_url).toBe(SERVER);
    expect(row.api_key).toMatch(/^lifer-enc:v1:/);
    expect(row.api_key).not.toContain("immich-key");
    const albums = (await call("GET", "/immich/albums")).json();
    expect(albums.map((a: { name: string }) => a.name)).toEqual(["Birds 2024", "Family"]);
  });

  it("brings in an album by reference, with duplicates and videos handled", async () => {
    expect((await call("PUT", "/immich/settings", { albumIds: [ALBUM] })).statusCode).toBe(200);
    const status = await syncAndWait();
    expect(status.job.error).toBeNull();
    expect(status.job.result).toMatchObject({ imported: 1, duplicates: 2, unrecognized: 1, skipped: 1, failed: 0 });
    expect(status.counts).toEqual({ imported: 3, unrecognized: 1, skipped: 1 });
    expect(status.lastSyncAt).not.toBeNull();

    const links = (
      await db.query(`SELECT immich_asset_id, capture_id, outcome FROM immich_assets WHERE user_id = $1`, [USER])
    ).rows;
    const by = Object.fromEntries(links.map((r) => [r.immich_asset_id, r]));
    expect(by[id("a")].outcome).toBe("imported");
    // Same checksum as a: linked to a's capture without downloading it.
    expect(by[id("b")]).toMatchObject({ outcome: "duplicate", capture_id: by[id("a")].capture_id });
    expect(by[id("e")]).toMatchObject({ outcome: "duplicate", capture_id: existingCapture });
    expect(calls.some((c) => c.path === `/api/assets/${id("b")}/original`)).toBe(false);
    expect(calls.some((c) => c.path === `/api/assets/${id("c")}/original`)).toBe(false);

    // The derivatives are in Lifer; the original isn't (no originals row).
    const photo = (
      await db.query(
        `SELECT p.display_path, c.species_id, (SELECT count(*)::int FROM originals o WHERE o.capture_id = c.id) AS originals
           FROM captures_all c JOIN photos p ON p.id = c.current_photo_id WHERE c.id = $1`,
        [by[id("a")].capture_id],
      )
    ).rows[0];
    expect(photo.species_id).toBe(SPECIES);
    expect(photo.originals).toBe(0);
    expect(existsSync(photo.display_path)).toBe(true);
  });

  it("imports nothing new on a rerun", async () => {
    const before = calls.length;
    const status = await syncAndWait();
    expect(status.job.result).toMatchObject({ imported: 0, duplicates: 0, unrecognized: 0, skipped: 0 });
    expect(calls.slice(before).filter((c) => c.path.endsWith("/original"))).toEqual([]);
    const count = await db.query(`SELECT count(*)::int AS n FROM captures_all WHERE user_id = $1`, [USER]);
    expect(count.rows[0].n).toBe(2);
  });

  it("writes no tags until the user turns it on, then tags confirmed species only", async () => {
    expect(calls.some((c) => c.path.startsWith("/api/tags"))).toBe(false);
    await call("PUT", "/immich/settings", { writeTags: true });
    const status = await syncAndWait();
    expect(status.writeTags).toBe(true);
    expect(status.job.result.tagged).toBe(3);
    const tagged = calls.find((c) => c.method === "PUT" && c.path.endsWith("/assets"));
    expect(tagged?.body).toEqual({ ids: expect.arrayContaining([id("a"), id("b"), id("e")]) });
    expect(calls.find((c) => c.method === "PUT" && c.path === "/api/tags")?.body).toEqual({
      tags: ["Lifer/Immich Test Heron"],
    });
  });

  it("only ever reads from Immich, apart from its own tags", () => {
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(w.path).toMatch(/^\/api\/tags(\/[^/]+\/assets)?$/);
  });

  it("unlinks, keeping the photos already brought in", async () => {
    expect((await call("DELETE", "/immich/link")).statusCode).toBe(200);
    expect((await call("GET", "/immich/status")).json().linked).toBe(false);
    const count = await db.query(`SELECT count(*)::int AS n FROM captures_all WHERE user_id = $1`, [USER]);
    expect(count.rows[0].n).toBe(2);
  });
});
