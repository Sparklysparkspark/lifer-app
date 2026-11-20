// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// A portfolio exports as a folder and serves from a revocable link, and no page or file carries a
// coordinate or an outside address.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const OWNER = "eeeeeeee-0000-4000-8000-000000000b01";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000b0a";
const TOKEN = "lifer_test_portfolio_owner_b01";

describe.skipIf(!url)("portfolio", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let exportRoot: string;
  let cookieName: string;
  let albumId: string;
  let photoId: string;
  let job: typeof import("./routes.js").portfolioExportJob;

  const call = (method: "GET" | "POST" | "PUT" | "DELETE", route: string, payload?: unknown) =>
    app.inject({ method, url: route, payload: payload as object, cookies: { [cookieName]: TOKEN } });
  const visit = (route: string) => app.inject({ method: "GET", url: route });

  async function cleanup() {
    await db.query(`DELETE FROM albums WHERE user_id = $1`, [OWNER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [OWNER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [OWNER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-portfolio-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    exportRoot = mkdtempSync(path.join(tmpdir(), "lifer-portfolio-root-"));
    process.env.LIFER_LIBRARY_ROOTS = exportRoot;
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { portfolioRoutes, portfolioExportJob } = await import("./routes.js");
    job = portfolioExportJob;

    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'portfolio@test', 'x')`, [OWNER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      OWNER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 920801, 'Testus portfolius', 'Portfolio Bird', 'aves')`,
      [SPECIES],
    );
    const src = path.join(dataDir, "source");
    mkdirSync(src);
    writeFileSync(path.join(src, "d.webp"), "display bytes");
    writeFileSync(path.join(src, "t.webp"), "thumb bytes");
    const captureId = (
      await db.query<{ id: string }>(
        `INSERT INTO captures (user_id, species_id, fingerprint, lat, lon) VALUES ($1, $2, 'portfolio-1', 49.2827, -123.1207) RETURNING id`,
        [OWNER, SPECIES],
      )
    ).rows[0].id;
    photoId = (
      await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path, width, height) VALUES ($1, $2, $3, 400, 300) RETURNING id`,
        [captureId, path.join(src, "d.webp"), path.join(src, "t.webp")],
      )
    ).rows[0].id;
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [photoId, captureId]);
    await db.query(
      `INSERT INTO user_species (user_id, species_id, state, first_collected) VALUES ($1, $2, 'collected', '2021-05-01')`,
      [OWNER, SPECIES],
    );
    albumId = (
      await db.query<{ id: string }>(`INSERT INTO albums (user_id, name) VALUES ($1, 'Show') RETURNING id`, [OWNER])
    ).rows[0].id;
    await db.query(`INSERT INTO album_captures (album_id, capture_id) VALUES ($1, $2)`, [albumId, captureId]);

    app = Fastify();
    await app.register(cookie);
    await app.register(portfolioRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await cleanup();
      await db.end();
    }
    for (const dir of [dataDir, exportRoot]) if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("saves what goes in and refuses a malformed body", async () => {
    expect((await call("PUT", "/api/portfolio", { title: 5 })).statusCode).toBe(400);
    const spec = { title: "My birds", albumIds: [albumId], speciesIds: [], lifeList: true };
    expect((await call("PUT", "/api/portfolio", spec)).statusCode).toBe(200);
    expect((await call("GET", "/api/portfolio")).json()).toMatchObject({ spec, shared: false });
  });

  it("exports a folder with the pages and metadata-free copies, and no location", async () => {
    const dest = mkdtempSync(path.join(exportRoot, "site-"));
    const res = await call("POST", "/api/portfolio/export", { destination: dest });
    expect(res.statusCode, res.body).toBe(200);
    await job.settled();
    expect(job.status.error).toBeNull();
    expect(readdirSync(path.join(dest, "photos")).sort()).toEqual([`${photoId}-thumb.webp`, `${photoId}.webp`]);
    const index = readFileSync(path.join(dest, "index.html"), "utf8");
    const life = readFileSync(path.join(dest, "life-list.html"), "utf8");
    expect(index).toContain(`photos/${photoId}-thumb.webp`);
    expect(life).toContain("2021");
    for (const html of [index, life]) {
      expect(html).not.toMatch(/https?:\/\//);
      expect(html).not.toMatch(/49\.28|123\.12/);
    }
    // Into the library itself would be found again as more photos.
    expect((await call("POST", "/api/portfolio/export", { destination: "relative/dir" })).statusCode).toBe(400);
  });

  it("serves the pages and photos from a link, and a revoked or replaced link stops", async () => {
    const { token } = (await call("POST", "/api/portfolio/share")).json();
    expect(token).toHaveLength(43);
    const page = await visit(`/api/p/${token}`);
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toMatch(/text\/html/);
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.body).toContain(`/api/p/${token}/photos/${photoId}-thumb.webp`);
    expect((await visit(`/api/p/${token}/life-list`)).statusCode).toBe(200);
    const img = await visit(`/api/p/${token}/photos/${photoId}.webp`);
    expect(img.statusCode).toBe(200);
    expect(img.body).toBe("display bytes");
    // A photo that isn't in the portfolio is never served, whatever its id.
    expect((await visit(`/api/p/${token}/photos/eeeeeeee-0000-4000-8000-000000000bff.webp`)).statusCode).toBe(404);
    expect((await visit(`/api/p/not-a-token`)).statusCode).toBe(404);

    const { token: next } = (await call("POST", "/api/portfolio/share")).json();
    expect((await visit(`/api/p/${token}`)).statusCode).toBe(404);
    expect((await visit(`/api/p/${next}`)).statusCode).toBe(200);
    expect((await call("DELETE", "/api/portfolio/share")).statusCode).toBe(200);
    expect((await visit(`/api/p/${next}`)).statusCode).toBe(404);
    expect((await visit(`/api/p/${next}/photos/${photoId}.webp`)).statusCode).toBe(404);
    expect(existsSync(exportRoot)).toBe(true);
  });
});
