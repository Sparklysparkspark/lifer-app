// Species reference photos: the list for import suggestion cards, and the cached files
// themselves (re-downloaded in the background when missing on this machine).
import { existsSync } from "node:fs";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { pool } from "@lifer/core/db.js";
import { Type } from "typebox";
import { IdParams, Uuid, notFoundOnInvalidId, withSchemas } from "../lib/schema.js";
import { requireScope } from "../auth/session.js";
import { downloadAndCacheImage } from "@lifer/core/species/lazyEnrich.js";
import { MEDIA_CACHE_BUST } from "@lifer/core/config.js";
import { createLimiter } from "@lifer/core/lib/concurrency.js";
import { sendCachedImage, statFile } from "../lib/cachedFile.js";
import { log } from "@lifer/core/lib/log.js";

// Cache misses are re-downloaded at most 3 at a time, and concurrent misses for the same photo
// share one download.
const referenceDownloadLimit = createLimiter(3);
const inFlightReferenceDownloads = new Map<string, Promise<void>>();

export function queueReferenceDownload(key: string, run: () => Promise<void>): Promise<void> {
  const existing = inFlightReferenceDownloads.get(key);
  if (existing) return existing;
  const task = referenceDownloadLimit(run)
    .catch((err) => log.error({ err, key }, "Background reference photo download failed"))
    .finally(() => inFlightReferenceDownloads.delete(key));
  inFlightReferenceDownloads.set(key, task);
  return task;
}

// A reference photo's file can be replaced in place (a re-fetch, a new pack, a catalog update)
// under the same URL, so it's rechecked after five minutes rather than the user's own photos' hour,
// still shown at once from the browser's copy while the recheck (a 304 when unchanged) runs.
async function sendReferenceFile(request: FastifyRequest, reply: FastifyReply, filePath: string, notFound: string) {
  const st = await statFile(filePath);
  if (!st) return reply.code(404).send({ error: notFound });
  return sendCachedImage(request, reply, filePath, st, {
    cacheControl: "private, max-age=300, stale-while-revalidate=604800",
  });
}

export async function referencePhotoRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  const listOptions = {
    preValidation: requireScope("species.read"),
    config: notFoundOnInvalidId("Species not found"),
    schema: { params: IdParams },
  };

  // Every reference photo (main and gallery) of one species, for flipping through on an import
  // suggestion card. Never triggers enrichment: a suggested species is already enriched.
  app.get("/species/:id/reference-photos", listOptions, async (request, reply) => {
    const { id } = request.params;
    const speciesRes = await pool.query<{
      reference_photo: string | null;
      reference_display_path: string | null;
      reference_credit: string | null;
    }>(`SELECT reference_photo, reference_display_path, reference_credit FROM species WHERE id = $1`, [id]);
    const species = speciesRes.rows[0];
    if (!species) return reply.code(404).send({ error: "Species not found" });

    const galleryRes = await pool.query<{
      id: string;
      photo_url: string;
      credit: string | null;
      has_cached_photo: boolean;
    }>(
      `SELECT id, photo_url, credit, display_path IS NOT NULL AS has_cached_photo
       FROM species_reference_photos WHERE species_id = $1 ORDER BY sort_order`,
      [id],
    );

    const photos: Array<{ url: string; credit: string | null }> = [];
    if (species.reference_photo || species.reference_display_path) {
      photos.push({
        url: species.reference_display_path
          ? `/api/species/${id}/reference-photo/display?v=${MEDIA_CACHE_BUST}`
          : species.reference_photo!,
        credit: species.reference_credit,
      });
    }
    for (const g of galleryRes.rows) {
      photos.push({
        url: g.has_cached_photo
          ? `/api/species/reference-gallery-photo/${g.id}/display?v=${MEDIA_CACHE_BUST}`
          : g.photo_url,
        credit: g.credit,
      });
    }
    return { photos };
  });

  // Reference photos aren't private to anyone, so there's no ownership check.
  for (const kind of ["display", "thumb"] as const) {
    const column = kind === "display" ? "reference_display_path" : "reference_thumb_path";
    // The ?v= cache buster isn't read, so there's no querystring schema.
    const photoOptions = {
      preValidation: requireScope("species.read"),
      config: notFoundOnInvalidId("Reference photo not found"),
      schema: { params: IdParams },
    };
    app.get(`/species/:id/reference-photo/${kind}`, photoOptions, async (request, reply) => {
      const res = await pool.query<{ path: string | null; photo_url: string | null }>(
        `SELECT ${column} AS path, reference_photo AS photo_url FROM species WHERE id = $1`,
        [request.params.id],
      );
      const filePath = res.rows[0]?.path;
      const photoUrl = res.rows[0]?.photo_url;
      if (!filePath || !existsSync(filePath)) {
        // The column pointed at a file that isn't on THIS machine (commonly a catalog seed built
        // elsewhere). The original remote URL is still known, so re-download it in the
        // background and 404 now; the web app shows its placeholder and the next view hits.
        const speciesId = request.params.id;
        queueReferenceDownload(`species:${speciesId}`, async () => {
          const recovered = photoUrl ? await downloadAndCacheImage(photoUrl, speciesId) : null;
          if (recovered) {
            await pool.query(
              `UPDATE species SET reference_display_path = $1, reference_thumb_path = $2 WHERE id = $3`,
              [recovered.displayPath, recovered.thumbPath, speciesId],
            );
          } else if (filePath) {
            await pool.query(
              `UPDATE species SET reference_display_path = NULL, reference_thumb_path = NULL WHERE id = $1`,
              [speciesId],
            );
          }
        });
        return reply.code(404).send({ error: "Reference photo not found" });
      }
      return sendReferenceFile(request, reply, filePath, "Reference photo not found");
    });

    const galleryColumn = kind === "display" ? "display_path" : "thumb_path";
    app.get(
      `/species/reference-gallery-photo/:photoId/${kind}`,
      {
        preValidation: requireScope("species.read"),
        config: notFoundOnInvalidId("Gallery photo not found"),
        schema: { params: Type.Object({ photoId: Uuid() }) },
      },
      async (request, reply) => {
        const res = await pool.query<{ path: string | null; photo_url: string }>(
          `SELECT ${galleryColumn} AS path, photo_url FROM species_reference_photos WHERE id = $1`,
          [request.params.photoId],
        );
        const filePath = res.rows[0]?.path;
        const photoUrl = res.rows[0]?.photo_url;
        if (!filePath || !existsSync(filePath)) {
          const photoId = request.params.photoId;
          queueReferenceDownload(`gallery:${photoId}`, async () => {
            const recovered = photoUrl ? await downloadAndCacheImage(photoUrl, photoId) : null;
            if (recovered) {
              await pool.query(`UPDATE species_reference_photos SET display_path = $1, thumb_path = $2 WHERE id = $3`, [
                recovered.displayPath,
                recovered.thumbPath,
                photoId,
              ]);
            } else if (filePath) {
              await pool.query(
                `UPDATE species_reference_photos SET display_path = NULL, thumb_path = NULL WHERE id = $1`,
                [photoId],
              );
            }
          });
          return reply.code(404).send({ error: "Gallery photo not found" });
        }
        return sendReferenceFile(request, reply, filePath, "Gallery photo not found");
      },
    );
  }
}
