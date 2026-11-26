// What a paired phone needs beyond the sync feeds: the photos of each smart album (the feeds carry
// only its rules), every album's cover as the desktop shows it, and the reference photo of a species with none of the person's own. Routes take
// a device key ("companion"); a species goes by its scientific name with every character outside
// letters, digits and "-" turned into "_", the only form the desktop listener passes in a path.
import { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { downloadAndCacheImage } from "@lifer/core/species/lazyEnrich.js";
import { requireScope } from "../auth/session.js";
import { albumMembers, autoCover } from "../albums/routes.js";
import { AUTO_COVER_ORDER } from "../lib/bestPhotoOrder.js";
import { Nullable, Open, replies, withSchemas } from "../lib/schema.js";
import { queueReferenceDownload, sendReferenceFile } from "../species/referencePhotos.js";

const scope = requireScope("sync", ["companion"]);
const NameParams = Type.Object({ id: Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }) });
const SLUG = "regexp_replace(scientific_name, '[^A-Za-z0-9-]', '_', 'g')";

interface RefRow {
  id: string;
  display_path: string | null;
  thumb_path: string | null;
  photo_url: string | null;
  credit: string | null;
  license: string | null;
}

const findReference = async (slug: string): Promise<RefRow | undefined> =>
  (
    await pool.query<RefRow>(
      `SELECT id, reference_display_path AS display_path, reference_thumb_path AS thumb_path, reference_photo AS photo_url,
              reference_credit AS credit, reference_license AS license
         FROM species WHERE ${SLUG} = $1 AND (reference_photo IS NOT NULL OR reference_display_path IS NOT NULL) LIMIT 1`,
      [slug],
    )
  ).rows[0];

export async function phoneLibraryRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get(
    "/companion/v1/albums/smart",
    {
      preValidation: scope,
      schema: {
        response: replies(
          Open({
            albums: Type.Array(Type.Object({ id: Type.String(), captureIds: Type.Array(Type.String()) })),
            covers: Type.Array(Type.Object({ id: Type.String(), coverPhotoId: Nullable(Type.String()) }), {
              description:
                "Every album's cover as the desktop shows it: the stored pick (the user's or Lifer's own), else Lifer's live choice",
            }),
          }),
        ),
      },
    },
    async (request) => {
      const userId = request.user!.id;
      // Mirrors GET /albums without its clean-up writes: a pick whose capture is trashed, or that a
      // smart album's rules no longer match, gives way to the automatic cover.
      const rows = (
        await pool.query<{
          id: string;
          smart: boolean;
          picked: string | null;
          picked_capture: string | null;
          fallback: string | null;
        }>(
          `SELECT a.id, a.rules IS NOT NULL AS smart, cover_p.id AS picked, cover_p.capture_id AS picked_capture,
                  fallback.photo_id AS fallback
             FROM albums a
             LEFT JOIN LATERAL (
               SELECT p.id, c.id AS capture_id FROM photos p JOIN captures c ON c.id = p.capture_id WHERE p.id = a.cover_photo_id
             ) cover_p ON true
             LEFT JOIN LATERAL (
               SELECT c.current_photo_id AS photo_id FROM album_captures ac JOIN captures c ON c.id = ac.capture_id
                WHERE ac.album_id = a.id AND c.current_photo_id IS NOT NULL
                ORDER BY ${AUTO_COVER_ORDER} LIMIT 1
             ) fallback ON true
            WHERE a.user_id = $1 ORDER BY a.id`,
          [userId],
        )
      ).rows;
      const albums = [];
      const covers = [];
      for (const r of rows) {
        if (!r.smart) {
          covers.push({ id: r.id, coverPhotoId: r.picked ?? r.fallback });
          continue;
        }
        const items = await albumMembers(r.id, userId);
        albums.push({ id: r.id, captureIds: items.map((i) => i.capture_id) });
        const picked = r.picked && items.some((i) => i.capture_id === r.picked_capture) ? r.picked : null;
        covers.push({ id: r.id, coverPhotoId: picked ?? autoCover(items) });
      }
      return { albums, covers };
    },
  );

  app.get(
    "/companion/v1/reference/:id",
    {
      preValidation: scope,
      schema: {
        params: NameParams,
        response: replies(Open({ credit: Nullable(Type.String()), license: Nullable(Type.String()) })),
      },
    },
    async (request, reply) => {
      const r = await findReference(request.params.id);
      if (!r) return reply.code(404).send({ error: "Reference photo not found" });
      return { credit: r.credit, license: r.license };
    },
  );

  for (const kind of ["thumb", "display"] as const) {
    app.get(
      `/companion/v1/reference/:id/${kind}`,
      { preValidation: scope, schema: { params: NameParams } },
      async (request, reply) => {
        const r = await findReference(request.params.id);
        if (!r) return reply.code(404).send({ error: "Reference photo not found" });
        const file = kind === "thumb" ? r.thumb_path : r.display_path;
        if (file && existsSync(file)) return sendReferenceFile(request, reply, file, "Reference photo not found");
        // The file is not on this machine (a catalog seed built elsewhere): fetch it for next time.
        if (r.photo_url)
          void queueReferenceDownload(`species:${r.id}`, async () => {
            const got = await downloadAndCacheImage(r.photo_url!, r.id);
            if (got)
              await pool.query(
                `UPDATE species SET reference_display_path = $1, reference_thumb_path = $2 WHERE id = $3`,
                [got.displayPath, got.thumbPath, r.id],
              );
          });
        return reply.code(404).send({ error: "Reference photo not found" });
      },
    );
  }
}
