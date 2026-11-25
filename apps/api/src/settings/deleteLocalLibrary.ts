// The explicit "delete the local files now that they're on the server" step, for a desktop
// library linked to a server (sync/push.ts). Allowed only once every capture here has been
// pushed, so nothing the server lacks is deleted.
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { Type } from "typebox";
import { pool, withTransaction } from "@lifer/core/db.js";
import { requireAuth } from "../auth/session.js";
import { DATA_DIR, ORIGINALS_DIR, LEGACY_ORIGINALS_DIR, APP_DATA_DIR } from "@lifer/core/config.js";
import { isWithinResolved } from "@lifer/core/lib/pathContainment.js";
import { removeEmptyDirsUpward } from "../lib/fsCleanup.js";
import { findSidecarPath } from "../uploads/exif.js";
import { invalidateUserVectors } from "@lifer/core/species/embeddings.js";
import { deleteLocalLibraryBlockedReason } from "./deleteLibraryGate.js";
import { Ok, replies, withSchemas } from "../lib/schema.js";
import { desktopOnly } from "./requireDesktopMode.js";
import { pushJob } from "../sync/push.js";
import { readServerLink } from "../sync/serverLink.js";
import { unpushedCount } from "../sync/push.js";
import { forgetMirrorCursor } from "../sync/mirror.js";
import { asSyncApply } from "../sync/changes.js";

/** Deletes the user's library rows unless something unpushed is there; the count of unpushed
 *  captures (0 when deleted). Captures stay locked from the count to the delete, so an import
 *  running alongside either lands first and is counted, or waits. */
export async function deleteLibraryRows(client: PoolClient, userId: string): Promise<number> {
  await client.query(`LOCK TABLE captures_all IN SHARE ROW EXCLUSIVE MODE`);
  const unpushed = await unpushedCount(userId, client);
  if (unpushed > 0) return unpushed;
  // Everything is on the server, which keeps it: no deletions to send.
  await asSyncApply(client);
  await client.query(`DELETE FROM user_species WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM captures WHERE user_id = $1`, [userId]);
  // The mirror went with the rows: the next pull fetches it all again.
  await forgetMirrorCursor(client);
  return 0;
}

export async function deleteLocalLibraryRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.post(
    "/settings/delete-local-library",
    {
      preValidation: [requireAuth, desktopOnly],
      schema: {
        body: Type.Object({ confirm: Type.Literal(true) }, { additionalProperties: false }),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const blocked = deleteLocalLibraryBlockedReason({
        linked: readServerLink() !== null,
        pushRunning: pushJob.status.running,
        lastPushError: pushJob.status.error,
        unpushed: await unpushedCount(userId),
      });
      if (blocked) return reply.code(409).send({ error: blocked });

      // In the flat layout the library folder is one the user chose, and may hold their own files
      // too: delete only the originals Lifer saved there (listed before their rows go), never the
      // folder itself. The older "Lifer Photos" subfolder is Lifer's alone and is cleared whole.
      const ownsWholeFolder = ORIGINALS_DIR === LEGACY_ORIGINALS_DIR;
      const managedFiles = ownsWholeFolder
        ? []
        : (
            await pool.query<{ ref: string }>(
              `SELECT o.ref FROM originals o JOIN captures_all c ON c.id = o.capture_id
               WHERE c.user_id = $1 AND o.managed = true AND o.ref_type = 'path'`,
              [userId],
            )
          ).rows.map((r) => r.ref);

      const unpushed = await withTransaction((client) => deleteLibraryRows(client, userId));
      if (unpushed > 0) {
        const reason = deleteLocalLibraryBlockedReason({
          linked: true,
          pushRunning: false,
          lastPushError: null,
          unpushed,
        });
        return reply.code(409).send({ error: reason! });
      }
      invalidateUserVectors(userId);

      // The rows cascaded, but the files didn't: clear the derivative and original folders,
      // recreated empty since the next photo still needs them.
      const clearedDirs = [
        path.join(APP_DATA_DIR, "display"),
        path.join(APP_DATA_DIR, "medium"),
        path.join(APP_DATA_DIR, "phone"),
        path.join(APP_DATA_DIR, "thumb"),
        path.join(APP_DATA_DIR, "card"),
        path.join(APP_DATA_DIR, "hdr"),
      ];
      if (ownsWholeFolder) clearedDirs.unshift(ORIGINALS_DIR);
      for (const dir of clearedDirs) {
        await rm(dir, { recursive: true, force: true });
        await mkdir(dir, { recursive: true });
      }
      for (const file of managedFiles) {
        if (!isWithinResolved(ORIGINALS_DIR, file)) continue;
        const sidecar = await findSidecarPath(file);
        await rm(file, { force: true });
        if (sidecar) await rm(sidecar, { force: true });
        await removeEmptyDirsUpward(path.dirname(file), ORIGINALS_DIR);
      }
      // Old derivative caches under DATA_DIR that migrateDerivativesLocation couldn't move. Not
      // recreated: nothing writes there anymore.
      if (DATA_DIR !== APP_DATA_DIR) {
        for (const sub of ["display", "thumb"]) await rm(path.join(DATA_DIR, sub), { recursive: true, force: true });
      }

      return { ok: true };
    },
  );
}
