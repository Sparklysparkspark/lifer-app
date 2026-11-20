// Runs only with TEST_DATABASE_URL set. Journeys E and G from desktop-server-sync.md: a laptop
// and a desktop linked to one server, each with its own database (three scratch databases next to
// TEST_DATABASE_URL's, created and migrated here). The desktops run the real mirror and push
// code; the transport calls the server's feed and push functions on the server's database.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LinkedServer } from "./serverLink.js";

const transport = vi.hoisted(() => ({ fetch: null as null | ((p: string) => Promise<Response>) }));
vi.mock("./serverLink.js", () => ({
  serverFetch: (_server: unknown, p: string) => transport.fetch!(p),
  assertStillLinked: () => {},
}));

const url = process.env.TEST_DATABASE_URL;
const NAMES = { server: "lifer_test_sync_server", laptop: "lifer_test_sync_a", desktop: "lifer_test_sync_b" };
const urlFor = (db: string) => {
  const u = new URL(url!);
  u.pathname = `/${db}`;
  return u.toString();
};
const MIGRATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../packages/data-pipeline/src/migrate.ts");

// Each install has its own user id; the protocol never sends one.
const USER = {
  server: "eeeeeeee-0000-4000-8000-00000000e501",
  laptop: "eeeeeeee-0000-4000-8000-00000000e502",
  desktop: "eeeeeeee-0000-4000-8000-00000000e503",
};
const SPECIES = "eeeeeeee-0000-4000-8000-00000000e50a";
const CAPTURE = "eeeeeeee-0000-4000-8000-00000000e511";
const ALBUM = "eeeeeeee-0000-4000-8000-00000000e521";
const TRIP = "eeeeeeee-0000-4000-8000-00000000e531";
const MOVED_LOCAL = "eeeeeeee-0000-4000-8000-00000000e541";
const MOVED_SERVER = "eeeeeeee-0000-4000-8000-00000000e542";
const SERVER: LinkedServer = { instanceId: "journey-e-server" } as LinkedServer;

type Lib = typeof import("./libraryMirror.js");
interface Install {
  lib: Lib;
  push: typeof import("./push.js");
  pool: pg.Pool;
  user: string;
}

describe.skipIf(!url)("journeys E and G: two desktops on one server", () => {
  let server: pg.Pool;
  let feed: typeof import("./library.js");
  const installs: Record<"laptop" | "desktop", Install> = {} as never;

  async function seed(db: pg.Pool, user: string, captureOrigin: "server" | "mirror") {
    await db.query(`DELETE FROM install_settings WHERE key LIKE 'mirror_cursor_%'`);
    await db.query(`DELETE FROM albums WHERE user_id = $1`, [user]);
    await db.query(`DELETE FROM trips WHERE user_id = $1`, [user]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [user]);
    await db.query(`DELETE FROM sync_tombstones WHERE user_id = $1`, [user]);
    await db.query(`DELETE FROM users WHERE id = $1`, [user]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'journey-e@test', 'x')`, [user]);
    await db.query(
      `INSERT INTO species (id, scientific_name, common_name, taxon_class, gbif_key) VALUES ($1, 'Zzjourney etestus', 'Journey Bird', 'aves', 980501)`,
      [SPECIES],
    );
    // The same photo everywhere: the server's own row, a mirrored copy on each desktop.
    if (captureOrigin === "server")
      await db.query(`INSERT INTO captures_all (id, user_id, species_id, fingerprint) VALUES ($1, $2, $3, 'je-1')`, [
        CAPTURE,
        user,
        SPECIES,
      ]);
    else
      await db.query(
        `INSERT INTO captures_all (id, user_id, species_id, fingerprint, remote_id, origin, pushed_at)
         VALUES (gen_random_uuid(), $1, $2, 'je-1', $3, 'mirror', now())`,
        [user, SPECIES, CAPTURE],
      );
  }

  async function open(name: "laptop" | "desktop"): Promise<Install> {
    // A fresh module graph per desktop, so each one's pool reaches its own database.
    process.env.DATABASE_URL = urlFor(NAMES[name]);
    vi.resetModules();
    const lib = await import("./libraryMirror.js");
    const push = await import("./push.js");
    const { pool } = await import("@lifer/core/db.js");
    return { lib, push, pool, user: USER[name] };
  }

  const push = async (i: Install) => {
    const send = async (body: Parameters<Parameters<Lib["pushLibraryRows"]>[1]>[0]) =>
      feed.applyPushedLibrary(server, USER.server, body as never, (body.deleted ?? {}) as never);
    await i.lib.pushLibraryDeletions(i.user, send);
    await i.lib.pushLibraryRows(i.user, send);
    await i.lib.pushLibraryMembers(i.user, send);
  };
  const pull = async (i: Install) => {
    await i.lib.pullLibraryRows(SERVER, i.user);
    await i.lib.pullLibraryMembers(SERVER, i.user);
  };
  const one = async (i: Install, sql: string, args: unknown[] = []) => (await i.pool.query(sql, args)).rows[0];

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    for (const db of Object.values(NAMES)) {
      const there = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [db]);
      if (there.rowCount === 0) await admin.query(`CREATE DATABASE ${db}`);
      execFileSync(process.execPath, ["--import", "tsx", MIGRATE], {
        env: { ...process.env, DATABASE_URL: urlFor(db) },
        stdio: "ignore",
      });
    }
    await admin.end();
    const before = process.env.DATABASE_URL;
    server = new pg.Pool({ connectionString: urlFor(NAMES.server) });
    feed = await import("./library.js");
    installs.laptop = await open("laptop");
    installs.desktop = await open("desktop");
    process.env.DATABASE_URL = before;
    await seed(server, USER.server, "server");
    await seed(installs.laptop.pool, USER.laptop, "mirror");
    await seed(installs.desktop.pool, USER.desktop, "mirror");
    transport.fetch = async (p) => {
      const u = new URL(p, "http://server");
      const name = {
        "/sync/albums": "albums",
        "/sync/trips": "trips",
        "/sync/saved-spots": "savedSpots",
        "/sync/album-captures": "albumCaptures",
        "/sync/album-exclusions": "albumExclusions",
        "/sync/species-split-kept": "speciesSplitKept",
      }[u.pathname] as import("./library.js").EntityName;
      const q = u.searchParams;
      const page = await feed.listLibraryChanges(
        server,
        USER.server,
        name,
        { since: q.get("since")!, after: q.get("after") ?? "" },
        Number(q.get("limit") ?? 200),
      );
      return new Response(JSON.stringify(page), { headers: { "content-type": "application/json" } });
    };
  }, 120_000);

  afterAll(async () => {
    await server?.end();
    for (const i of Object.values(installs)) await i?.pool.end();
  });

  it("an album and trip made on the laptop reach the desktop through the server", async () => {
    const { laptop, desktop } = installs;
    await laptop.pool.query(`INSERT INTO albums (id, user_id, name) VALUES ($1, $2, 'Owls')`, [ALBUM, laptop.user]);
    await laptop.pool.query(
      `INSERT INTO trips (id, user_id, name, source_folder, destination_folder) VALUES ($1, $2, 'Coast', '/in', '/out')`,
      [TRIP, laptop.user],
    );
    await push(laptop);
    await pull(desktop);
    expect((await one(desktop, `SELECT name FROM albums WHERE id = $1`, [ALBUM])).name).toBe("Owls");
    expect((await one(desktop, `SELECT name FROM trips WHERE id = $1`, [TRIP])).name).toBe("Coast");
    // Taking the server's copy is not an edit to send back.
    expect(await desktop.lib.unpushedLibraryCount(desktop.user)).toBe(0);
  });

  it("renamed on both while apart: the version the server took first wins on both, no clocks compared", async () => {
    const { laptop, desktop } = installs;
    await laptop.pool.query(`UPDATE albums SET name = 'Owls of the coast' WHERE id = $1`, [ALBUM]);
    await desktop.pool.query(`UPDATE albums SET name = 'Night owls' WHERE id = $1`, [ALBUM]);
    await push(laptop);
    await push(desktop);
    await pull(laptop);
    await pull(desktop);
    for (const i of [laptop, desktop]) {
      expect((await one(i, `SELECT name FROM albums WHERE id = $1`, [ALBUM])).name).toBe("Owls of the coast");
      expect(await i.lib.unpushedLibraryCount(i.user)).toBe(0);
    }
    expect((await server.query(`SELECT name FROM albums WHERE id = $1`, [ALBUM])).rows[0].name).toBe(
      "Owls of the coast",
    );
  });

  it("membership and a species correction made on the desktop reach the laptop", async () => {
    const { laptop, desktop } = installs;
    const local = (await one(desktop, `SELECT id FROM captures_all WHERE remote_id = $1`, [CAPTURE])).id;
    await desktop.pool.query(`INSERT INTO album_captures (album_id, capture_id) VALUES ($1, $2)`, [ALBUM, local]);
    await desktop.pool.query(`INSERT INTO species_split_kept (capture_id) VALUES ($1)`, [local]);
    await push(desktop);
    expect((await server.query(`SELECT 1 FROM species_split_kept WHERE capture_id = $1`, [CAPTURE])).rowCount).toBe(1);
    await pull(laptop);
    const mine = (await one(laptop, `SELECT id FROM captures_all WHERE remote_id = $1`, [CAPTURE])).id;
    expect(await one(laptop, `SELECT 1 AS x FROM album_captures WHERE album_id = $1 AND capture_id = $2`, [ALBUM, mine]))
      .toBeTruthy();
    expect(await one(laptop, `SELECT 1 AS x FROM species_split_kept WHERE capture_id = $1`, [mine])).toBeTruthy();
    // The desktop pulling its own change back changes nothing and sends nothing.
    await pull(desktop);
    for (const i of [laptop, desktop]) expect(await i.lib.unpushedLibraryCount(i.user)).toBe(0);
  });

  it("deleted on one desktop, gone from the other, and nothing echoes", async () => {
    const { laptop, desktop } = installs;
    const mine = (await one(laptop, `SELECT id FROM captures_all WHERE remote_id = $1`, [CAPTURE])).id;
    await laptop.pool.query(`DELETE FROM trips WHERE id = $1`, [TRIP]);
    await laptop.pool.query(`DELETE FROM species_split_kept WHERE capture_id = $1`, [mine]);
    await push(laptop);
    await pull(desktop);
    expect(await one(desktop, `SELECT 1 AS x FROM trips WHERE id = $1`, [TRIP])).toBeUndefined();
    expect(
      await one(desktop, `SELECT 1 AS x FROM species_split_kept k JOIN captures_all c ON c.id = k.capture_id WHERE c.remote_id = $1`, [
        CAPTURE,
      ]),
    ).toBeUndefined();
    await pull(laptop);
    for (const i of [laptop, desktop]) {
      expect(await i.lib.unpushedLibraryCount(i.user)).toBe(0);
      expect((await one(i, `SELECT count(*)::int AS n FROM sync_tombstones WHERE user_id = $1`, [i.user])).n).toBe(0);
    }
  });

  it("journey G: a photo the old Migrate already copied is matched by fingerprint, not uploaded again", async () => {
    const { laptop } = installs;
    const { applyPushedCaptures } = await import("./pushServer.js");
    await server.query(`INSERT INTO captures_all (id, user_id, species_id, fingerprint) VALUES ($1, $2, $3, 'je-moved')`, [
      MOVED_SERVER,
      USER.server,
      SPECIES,
    ]);
    // Imported on the laptop, copied up by the old Migrate, never pushed by sync.
    await laptop.pool.query(
      `INSERT INTO captures_all (id, user_id, species_id, fingerprint, origin) VALUES ($1, $2, $3, 'je-moved', 'local')`,
      [MOVED_LOCAL, laptop.user, SPECIES],
    );
    await laptop.pool.query(
      `INSERT INTO capture_migrations (capture_id, server_url, status) VALUES ($1, 'http://old', 'migrated')`,
      [MOVED_LOCAL],
    );
    const { outcomes } = await applyPushedCaptures(server, USER.server, [
      {
        id: MOVED_LOCAL,
        deletedAt: null,
        hiddenAt: null,
        scientificName: "Zzjourney etestus",
        fingerprint: "je-moved",
        takenAt: null,
        lat: null,
        lon: null,
        cameraModel: null,
        lens: null,
        focalLengthMm: null,
        aperture: null,
        shutter: null,
        iso: null,
        qualityRating: null,
        tags: [],
        locationLabel: null,
        regionId: null,
        cullVerdict: null,
        cullLabel: null,
        baseUpdatedAt: null,
      } as never,
    ]);
    expect(outcomes[0]).toMatchObject({ id: MOVED_LOCAL, status: "conflict", serverId: MOVED_SERVER });
    const at = (await one(laptop, `SELECT updated_at::text AS u FROM captures_all WHERE id = $1`, [MOVED_LOCAL])).u;
    await laptop.push.markPushed(laptop.pool, MOVED_LOCAL, at, MOVED_SERVER);
    expect(await one(laptop, `SELECT remote_id FROM captures_all WHERE id = $1`, [MOVED_LOCAL])).toEqual({
      remote_id: MOVED_SERVER,
    });
    expect(await laptop.push.waitingCounts(laptop.user, laptop.pool)).toMatchObject({ photos: 0 });
  });
});
