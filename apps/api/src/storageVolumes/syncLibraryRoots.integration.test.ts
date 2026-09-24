// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run syncLibraryRoots.integration
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "bbbbbbbb-0000-4000-8000-000000000104";

describe.skipIf(!url)("syncLibraryRootsFromEnv (integration)", () => {
  const pool = new pg.Pool({ connectionString: url });
  vi.doMock("../db.js", () => ({ pool }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  afterAll(async () => {
    await pool.query(`DELETE FROM storage_volumes WHERE kind = 'root' OR user_id = $1`, [USER]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM storage_volumes WHERE kind = 'root' OR user_id = $1`, [USER]);
    await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'roots@test', 'x') ON CONFLICT DO NOTHING`, [USER]);
  });

  async function roots() {
    const res = await pool.query<{ id: string; label: string; root_path: string; removed: boolean }>(
      `SELECT id, label, root_path, removed_at IS NOT NULL AS removed FROM storage_volumes WHERE kind = 'root' ORDER BY root_path`,
    );
    return res.rows;
  }

  it("adds, relabels, soft-removes, and revives roots without touching drives", async () => {
    const { syncLibraryRootsFromEnv } = await import("./syncLibraryRoots.js");
    await pool.query(
      `INSERT INTO storage_volumes (user_id, label, platform_volume_id, last_known_mount_path, is_default)
       VALUES ($1, 'Desk drive', 'UUID-ROOTS', '/Volumes/Desk', true)`,
      [USER],
    );

    await syncLibraryRootsFromEnv([
      { label: "NAS", path: "/library/nas" },
      { label: "Archive", path: "/library/archive" },
    ]);
    const first = await roots();
    expect(first.map((r) => [r.label, r.removed])).toEqual([
      ["Archive", false],
      ["NAS", false],
    ]);

    await syncLibraryRootsFromEnv([{ label: "Photos", path: "/library/nas" }]);
    const second = await roots();
    const nas = second.find((r) => r.root_path === "/library/nas")!;
    expect(nas.id).toBe(first.find((r) => r.root_path === "/library/nas")!.id);
    expect(nas.label).toBe("Photos");
    expect(second.find((r) => r.root_path === "/library/archive")!.removed).toBe(true);

    await syncLibraryRootsFromEnv([
      { label: "Photos", path: "/library/nas" },
      { label: "Archive", path: "/library/archive" },
    ]);
    expect((await roots()).every((r) => !r.removed)).toBe(true);

    await syncLibraryRootsFromEnv([]);
    expect((await roots()).every((r) => r.removed)).toBe(true);

    const drive = await pool.query(`SELECT kind, is_default FROM storage_volumes WHERE user_id = $1`, [USER]);
    expect(drive.rows).toEqual([{ kind: "drive", is_default: true }]);
  });

  it("rejects a root that claims to be someone's default", async () => {
    await expect(
      pool.query(
        `INSERT INTO storage_volumes (kind, label, root_path, last_known_mount_path, is_default) VALUES ('root', 'x', '/x', '/x', true)`,
      ),
    ).rejects.toThrow(/storage_volumes_root_never_default/);
  });
});
