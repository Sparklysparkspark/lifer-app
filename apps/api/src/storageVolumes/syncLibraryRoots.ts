// Mirrors LIFER_LIBRARY_ROOTS into storage_volumes (kind 'root') at startup, so an admin-declared
// folder behaves like any other volume everywhere else (uploads, reimport, the 409 "not
// connected" responses). Roots dropped from the env are soft-removed, never deleted: their files
// keep their volume and read as "not connected" until the path is declared again.
import { pool } from "../db.js";
import { LIBRARY_ROOTS, type LibraryRoot } from "../config.js";

export async function syncLibraryRootsFromEnv(roots: LibraryRoot[] = LIBRARY_ROOTS): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const root of roots) {
      const res = await client.query<{ inserted: boolean }>(
        `INSERT INTO storage_volumes (kind, label, root_path, last_known_mount_path, last_seen_at, removed_at)
         VALUES ('root', $1, $2, $2, now(), NULL)
         ON CONFLICT (root_path) WHERE kind = 'root'
         DO UPDATE SET label = EXCLUDED.label, last_known_mount_path = EXCLUDED.root_path, last_seen_at = now(), removed_at = NULL
         RETURNING (xmax = 0) AS inserted`,
        [root.label, root.path],
      );
      if (res.rows[0]?.inserted) console.log(`[library-roots] added "${root.label}" at ${root.path}`);
    }
    const removed = await client.query<{ label: string; root_path: string }>(
      `UPDATE storage_volumes SET removed_at = now()
       WHERE kind = 'root' AND removed_at IS NULL AND NOT (root_path = ANY($1::text[]))
       RETURNING label, root_path`,
      [roots.map((r) => r.path)],
    );
    for (const r of removed.rows) {
      console.log(`[library-roots] "${r.label}" (${r.root_path}) is no longer in LIFER_LIBRARY_ROOTS; its files will show as not connected`);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
