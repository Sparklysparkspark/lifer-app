// Desktop-only: register/list/remove external drives that hold part of the user's photo
// library (see ~/.claude/plans/multi-drive-storage.md). A registered volume's live
// connected/disconnected state is always computed fresh on GET, never cached in the DB —
// whether a drive is plugged in right now is exactly the kind of thing that changes between
// one request and the next.
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";
import { requireDesktopMode } from "../settings/routes.js";
import { listMountedVolumes, mountPathFor, getVolumeId, isSameVolumeAsDataDir } from "./volumeIdentity.js";
import { DATA_DIR } from "../config.js";
import path from "node:path";

export async function storageVolumesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/storage-volumes", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    const rows = await pool.query<{
      id: string;
      label: string;
      platform_volume_id: string;
      last_known_mount_path: string;
      last_seen_at: string;
      is_default: boolean;
    }>(
      `SELECT id, label, platform_volume_id, last_known_mount_path, last_seen_at, is_default FROM storage_volumes WHERE user_id = $1 ORDER BY label`,
      [request.user!.id],
    );

    const mounted = listMountedVolumes();
    const results = [];
    for (const row of rows.rows) {
      const match = mounted.find((v) => v.platformVolumeId === row.platform_volume_id);
      const connected = match !== undefined;
      // Refresh last_known_mount_path/last_seen_at while we already know it's connected —
      // keeps the stored path from going stale for anything reading it directly, and means a
      // drive that changed its mount name since last seen is corrected here rather than
      // silently drifting.
      if (connected && match!.mountPath !== row.last_known_mount_path) {
        await pool.query(`UPDATE storage_volumes SET last_known_mount_path = $1, last_seen_at = now() WHERE id = $2`, [
          match!.mountPath,
          row.id,
        ]);
      } else if (connected) {
        await pool.query(`UPDATE storage_volumes SET last_seen_at = now() WHERE id = $1`, [row.id]);
      }
      results.push({
        id: row.id,
        label: row.label,
        mountPath: connected ? match!.mountPath : row.last_known_mount_path,
        connected,
        lastSeenAt: connected ? new Date().toISOString() : row.last_seen_at,
        isDefault: row.is_default,
      });
    }
    return { volumes: results };
  });

  app.post<{ Body: { path?: string; label?: string } }>("/storage-volumes", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    const { path: folderPath, label } = request.body ?? {};
    if (!folderPath || !path.isAbsolute(folderPath)) {
      return reply.code(400).send({ error: "path must be an absolute folder path" });
    }
    if (!label?.trim()) return reply.code(400).send({ error: "label is required" });

    const mountPath = mountPathFor(folderPath);
    const platformVolumeId = getVolumeId(mountPath);
    if (!platformVolumeId) {
      return reply.code(400).send({
        error: ["darwin", "linux", "win32"].includes(process.platform)
          ? "Couldn't identify that drive — is it a real external volume?"
          : "Multi-drive support isn't available on this operating system yet",
      });
    }
    if (isSameVolumeAsDataDir(mountPath, DATA_DIR)) {
      return reply.code(400).send({ error: "That folder is on the same drive as your main Lifer storage — no need to register it separately" });
    }

    const res = await pool.query<{ id: string }>(
      `INSERT INTO storage_volumes (user_id, label, platform_volume_id, last_known_mount_path)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, platform_volume_id) DO UPDATE SET
         label = EXCLUDED.label, last_known_mount_path = EXCLUDED.last_known_mount_path, last_seen_at = now()
       RETURNING id`,
      [request.user!.id, label.trim(), platformVolumeId, mountPath],
    );
    const volumeId = res.rows[0].id;

    // Re-adopts any originals orphaned by a previous "Remove" on this exact drive (removing a
    // volume only clears volume_id — see this file's own DELETE handler comment — it never
    // touches `ref`, which still holds the file's last-known absolute path). Re-registering the
    // same physical drive at the same mount path is common (undoing an accidental removal, or
    // re-adding after using the drive elsewhere) — matching on `ref` still starting with this
    // mount path recognizes that without needing any record of which volume used to own them.
    // Only relinks rows this user actually owns, and only ones with no volume_id already (never
    // steals an original that's legitimately tagged to some OTHER still-registered drive). Files
    // that moved to a different mount path since being orphaned aren't caught by this — that
    // needs a real re-scan (Settings → Reimport library), not a plain path-prefix match.
    const readopted = await pool.query(
      `UPDATE originals o
       SET volume_id = $1, volume_relative_path = substring(o.ref from ${mountPath.length + 1})
       WHERE o.volume_id IS NULL
         AND o.ref LIKE $2
         AND (o.user_id = $3 OR EXISTS (SELECT 1 FROM captures c WHERE c.id = o.capture_id AND c.user_id = $3))`,
      [volumeId, `${mountPath}/%`, request.user!.id],
    );

    return reply.code(201).send({ id: volumeId, label: label.trim(), mountPath, connected: true, readopted: readopted.rowCount ?? 0 });
  });

  // Only one volume can be the default at a time (enforced by the partial unique index in
  // migration 051) — clearing every other row first means this never conflicts with itself.
  app.put<{ Params: { id: string } }>("/storage-volumes/:id/default", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE storage_volumes SET is_default = false WHERE user_id = $1`, [request.user!.id]);
      const res = await client.query(`UPDATE storage_volumes SET is_default = true WHERE id = $1 AND user_id = $2`, [
        request.params.id,
        request.user!.id,
      ]);
      await client.query("COMMIT");
      if (res.rowCount === 0) return reply.code(404).send({ error: "Drive not found" });
      return { ok: true };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  app.put<{ Params: { id: string }; Body: { label?: string } }>("/storage-volumes/:id", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    const label = request.body?.label?.trim();
    if (!label) return reply.code(400).send({ error: "label is required" });
    const res = await pool.query(`UPDATE storage_volumes SET label = $1 WHERE id = $2 AND user_id = $3`, [
      label,
      request.params.id,
      request.user!.id,
    ]);
    if (res.rowCount === 0) return reply.code(404).send({ error: "Drive not found" });
    return { ok: true };
  });

  // Unregistering a volume doesn't touch any files or captures — originals.volume_id just goes
  // back to NULL (ON DELETE SET NULL), which means those files fall back to being resolved as
  // plain absolute paths again (the same as any original that was never volume-tagged), not
  // deleted or hidden.
  app.delete<{ Params: { id: string } }>("/storage-volumes/:id", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    await pool.query(`DELETE FROM storage_volumes WHERE id = $1 AND user_id = $2`, [request.params.id, request.user!.id]);
    return { ok: true };
  });
}
