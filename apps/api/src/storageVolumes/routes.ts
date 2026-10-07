// Storage volumes: external drives (desktop, registered here) and library roots (server, from
// LIFER_LIBRARY_ROOTS). Listing works everywhere; changing drives is desktop only. Connection
// state is computed on every GET, never stored.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool, withTransaction } from "@lifer/core/db.js";
import { IdParams, Ok, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";
import { requireAuth } from "../auth/session.js";
import { desktopOnly } from "../settings/requireDesktopMode.js";
import { listMountedVolumes, mountPathFor, getVolumeId, isSameVolumeAsDataDir } from "./volumeIdentity.js";
import { isReadableDir } from "./resolve.js";
import { DATA_DIR } from "@lifer/core/config.js";
import path from "node:path";

// A label must have something besides spaces, since it's trimmed before saving.
const Label = Type.String({ pattern: "\\S" });
const driveNotFound = notFoundOnInvalidId("Drive not found");

export async function storageVolumesRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get("/storage-volumes", { preValidation: requireAuth, schema: {} }, async (request) => {
    const rows = await pool.query<{
      id: string;
      kind: "drive" | "root";
      label: string;
      platform_volume_id: string | null;
      root_path: string | null;
      last_known_mount_path: string;
      last_seen_at: string;
      is_default: boolean;
    }>(
      `SELECT id, kind, label, platform_volume_id, root_path, last_known_mount_path, last_seen_at, is_default
       FROM storage_volumes
       WHERE (user_id = $1 OR kind = 'root') AND removed_at IS NULL
       ORDER BY kind DESC, label`,
      [request.user!.id],
    );

    // Drive detection shells out, so only when there's a drive to check.
    const mounted = rows.rows.some((r) => r.kind === "drive") ? await listMountedVolumes() : [];
    const results = [];
    for (const row of rows.rows) {
      if (row.kind === "root") {
        results.push({
          id: row.id,
          label: row.label,
          kind: row.kind,
          mountPath: row.root_path!,
          rootPath: row.root_path,
          connected: isReadableDir(row.root_path!),
          lastSeenAt: row.last_seen_at,
          isDefault: false,
          managedByEnv: true,
        });
        continue;
      }
      const match = mounted.find((v) => v.platformVolumeId === row.platform_volume_id);
      const connected = match !== undefined;
      // Refresh the stored mount path while it's known to be connected, so a renamed mount is
      // corrected.
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
        kind: row.kind,
        mountPath: connected ? match!.mountPath : row.last_known_mount_path,
        rootPath: null,
        connected,
        lastSeenAt: connected ? new Date().toISOString() : row.last_seen_at,
        isDefault: row.is_default,
        managedByEnv: false,
      });
    }
    return { volumes: results };
  });

  app.post(
    "/storage-volumes",
    {
      preValidation: [requireAuth, desktopOnly],
      schema: {
        // Absolute is checked in the handler, where path.isAbsolute knows this platform's rules.
        body: Type.Object({ path: Type.String({ minLength: 1 }), label: Label }, { additionalProperties: false }),
      },
    },
    async (request, reply) => {
      const { path: folderPath, label } = request.body;
      if (!path.isAbsolute(folderPath)) {
        return reply.code(400).send({ error: "path must be an absolute folder path" });
      }

      const mountPath = await mountPathFor(folderPath);
      const platformVolumeId = await getVolumeId(mountPath);
      if (!platformVolumeId) {
        return reply.code(400).send({
          error: ["darwin", "linux", "win32"].includes(process.platform)
            ? "Couldn't identify that drive. Is it a real external volume?"
            : "Multi-drive support isn't available on this operating system yet",
        });
      }
      if (await isSameVolumeAsDataDir(mountPath, DATA_DIR)) {
        return reply.code(400).send({
          error:
            "That folder is on the same drive as your main Lifer storage, so there's no need to register it separately",
        });
      }

      const res = await pool.query<{ id: string }>(
        `INSERT INTO storage_volumes (user_id, label, platform_volume_id, last_known_mount_path)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, platform_volume_id) WHERE kind = 'drive' DO UPDATE SET
         label = EXCLUDED.label, last_known_mount_path = EXCLUDED.last_known_mount_path, last_seen_at = now()
       RETURNING id`,
        [request.user!.id, label.trim(), platformVolumeId, mountPath],
      );
      const volumeId = res.rows[0].id;

      // Re-adopts this user's untagged originals whose ref is under this mount path (a removed drive
      // added back). Files that moved elsewhere need a library reimport.
      const readopted = await pool.query(
        `UPDATE originals o
       SET volume_id = $1, volume_relative_path = substring(o.ref from length($2::text) + 1)
       WHERE o.volume_id IS NULL
         AND left(o.ref, length($2::text) + 1) = $2::text || '/'
         AND (o.user_id = $3 OR EXISTS (SELECT 1 FROM captures c WHERE c.id = o.capture_id AND c.user_id = $3))`,
        [volumeId, mountPath, request.user!.id],
      );

      return reply
        .code(201)
        .send({ id: volumeId, label: label.trim(), mountPath, connected: true, readopted: readopted.rowCount ?? 0 });
    },
  );

  // A partial unique index allows one default, so clear the others first.
  app.put(
    "/storage-volumes/:id/default",
    // No body: the web app sends `{}`, which is ignored.
    {
      preValidation: [requireAuth, desktopOnly],
      config: driveNotFound,
      schema: { params: IdParams, response: replies(Ok) },
    },
    async (request, reply) => {
      const res = await withTransaction(async (client) => {
        await client.query(`UPDATE storage_volumes SET is_default = false WHERE user_id = $1`, [request.user!.id]);
        return client.query(`UPDATE storage_volumes SET is_default = true WHERE id = $1 AND user_id = $2`, [
          request.params.id,
          request.user!.id,
        ]);
      });
      if (res.rowCount === 0) return reply.code(404).send({ error: "Drive not found" });
      return { ok: true };
    },
  );

  app.put(
    "/storage-volumes/:id",
    {
      preValidation: [requireAuth, desktopOnly],
      config: driveNotFound,
      schema: {
        params: IdParams,
        body: Type.Object({ label: Label }, { additionalProperties: false }),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const label = request.body.label.trim();
      const res = await pool.query(`UPDATE storage_volumes SET label = $1 WHERE id = $2 AND user_id = $3`, [
        label,
        request.params.id,
        request.user!.id,
      ]);
      if (res.rowCount === 0) return reply.code(404).send({ error: "Drive not found" });
      return { ok: true };
    },
  );

  // Unregistering touches no files: volume_id goes NULL and those originals resolve as plain paths.
  app.delete(
    "/storage-volumes/:id",
    {
      preValidation: [requireAuth, desktopOnly],
      config: driveNotFound,
      schema: { params: IdParams, response: replies(Ok) },
    },
    async (request) => {
      await pool.query(`DELETE FROM storage_volumes WHERE id = $1 AND user_id = $2`, [
        request.params.id,
        request.user!.id,
      ]);
      return { ok: true };
    },
  );
}
