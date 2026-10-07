// The species page: GET /species/:id and the per-species lists and marks around it.
import { existsSync } from "node:fs";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { IdParams, Ok, Uuid, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";
import { requireAuth, requireScope } from "../auth/session.js";
import {
  enrichSpecies,
  persistEnrichment,
  fetchAnyGallery,
  persistGalleryPromotingMainIfMissing,
  fillDescriptionIfUnchecked,
} from "@lifer/core/species/lazyEnrich.js";
import { MEDIA_CACHE_BUST, EMBEDDING_MODEL_VERSION } from "@lifer/core/config.js";
import { resolveOriginalPath } from "../storageVolumes/resolve.js";
import { clusterIntoEncounters } from "../lib/clusterEncounters.js";
import { cosineSimilarity } from "@lifer/core/species/embeddings.js";
import { BURST_MAX_GAP_MS, BURST_SIMILARITY } from "./bursts.js";
import { computeSharpness } from "../lib/sharpness.js";
import { log } from "@lifer/core/lib/log.js";
import { bboxDiagonalDegrees, ringBoundingBox, type BoundingBox } from "@lifer/core/lib/geometry.js";
import { SENSITIVE_CLUSTER_DIAGONAL_KM } from "@lifer/core/species/sensitiveSpecies.js";

const speciesNotFound = notFoundOnInvalidId("Species not found");
// Marking routes take no body: the web app sends none.
const markOptions = {
  preValidation: requireAuth,
  config: speciesNotFound,
  schema: { params: IdParams, response: replies(Ok) },
};
const readOptions = {
  preValidation: requireScope("species.read"),
  config: speciesNotFound,
  schema: { params: IdParams },
};

export async function speciesDetailRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get(
    "/species/:id",
    {
      preValidation: requireScope("species.read"),
      config: speciesNotFound,
      schema: {
        params: IdParams,
        querystring: Type.Object({ regionId: Type.Optional(Uuid({ description: "Region context" })) }),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const userId = request.user!.id;

      // Without ?regionId= (most ways onto this page), use a region that has data for this
      // species so seasonality, local tier and the hotspot map still show. Hotspot clusters only
      // exist per province, so a region with clusters is preferred over the busiest checklist row.
      const regionId =
        (request.query.regionId || undefined) ??
        (
          await pool.query<{ region_id: string }>(
            `SELECT region_id FROM region_species_hotspots WHERE species_id = $1
             GROUP BY region_id ORDER BY SUM(point_count) DESC LIMIT 1`,
            [id],
          )
        ).rows[0]?.region_id ??
        (
          await pool.query<{ region_id: string }>(
            `SELECT region_id FROM region_species WHERE species_id = $1 ORDER BY local_frequency DESC NULLS LAST LIMIT 1`,
            [id],
          )
        ).rows[0]?.region_id ??
        null;

      // The hotspot map may need a different region than the one navigated to. A country never
      // has clusters, so it borrows the busiest province. A province with none for this species
      // shows no map rather than another province's clusters. Seasonality keeps the given region.
      const givenRegionHasHotspots =
        regionId != null &&
        (
          await pool.query(`SELECT 1 FROM region_species_hotspots WHERE region_id = $1 AND species_id = $2 LIMIT 1`, [
            regionId,
            id,
          ])
        ).rowCount! > 0;
      const givenRegionIsCountry =
        regionId != null &&
        (await pool.query(`SELECT 1 FROM regions WHERE id = $1 AND sovereignty_group IS NOT NULL`, [regionId]))
          .rowCount! > 0;
      const hotspotRegionId = givenRegionHasHotspots
        ? regionId
        : givenRegionIsCountry
          ? ((
              await pool.query<{ region_id: string }>(
                `SELECT region_id FROM region_species_hotspots WHERE species_id = $1
                 GROUP BY region_id ORDER BY SUM(point_count) DESC LIMIT 1`,
                [id],
              )
            ).rows[0]?.region_id ?? regionId)
          : null;

      let speciesRes = await pool.query(
        `SELECT s.*, t.*, r.tier, r.composite
         FROM species s
         LEFT JOIN species_traits t ON t.species_id = s.id
         LEFT JOIN species_rarity r ON r.species_id = s.id
         WHERE s.id = $1`,
        [id],
      );
      let species = speciesRes.rows[0];
      if (!species) return reply.code(404).send({ error: "Species not found" });

      // Lazy enrichment (lazyEnrich.ts): the first view fetches the reference photo, blurb and
      // gallery. enriched_at means "already tried". A species a downloaded pack covers
      // (pack_species) never makes a live call, so a pack stays fully offline on any install.
      const packCoverageRes = await pool.query(`SELECT 1 FROM pack_species WHERE species_id = $1 LIMIT 1`, [id]);
      const liveCallsAllowed = (packCoverageRes.rowCount ?? 0) === 0;

      if (!species.enriched_at && liveCallsAllowed) {
        // A full enrichment includes the gallery, so gallery_backfilled_at is set right away.
        const enrichment = await enrichSpecies(species);
        await persistEnrichment(id, enrichment);
        await pool.query(`UPDATE species SET gallery_backfilled_at = now() WHERE id = $1`, [id]);
        speciesRes = await pool.query(
          `SELECT s.*, t.*, r.tier, r.composite
           FROM species s
           LEFT JOIN species_traits t ON t.species_id = s.id
           LEFT JOIN species_rarity r ON r.species_id = s.id
           WHERE s.id = $1`,
          [id],
        );
        species = speciesRes.rows[0];
      } else if (!species.gallery_backfilled_at && liveCallsAllowed) {
        // The bulk pass (enrich-all-species.ts) skips the slow gallery fallback, so the first view
        // fills it in the background without holding up the page. gallery_backfilled_at stays
        // unset on failure, so a later view retries.
        fetchAnyGallery(species)
          .then((gallery) => persistGalleryPromotingMainIfMissing(id, gallery, !!species.reference_photo))
          .then(() => pool.query(`UPDATE species SET gallery_backfilled_at = now() WHERE id = $1`, [id]))
          .catch((err) => log.error({ err, speciesId: id }, "Background gallery backfill failed"));
      }

      // enriched_at only says a photo lookup ran: an offline pack's photos or the photo store set
      // it without reading any text. A species no text source was ever read for gets one try
      // here (description_checked_at, migration 128). Best effort: the page never fails on it.
      if (
        species.enriched_at &&
        !species.description &&
        !species.description_checked_at &&
        species.inat_taxon_id &&
        liveCallsAllowed
      ) {
        try {
          const text = await fillDescriptionIfUnchecked(id, species.inat_taxon_id);
          if (text) {
            species.description = text.description;
            species.description_credit = text.descriptionCredit;
            species.description_source_url = text.descriptionSourceUrl;
          }
        } catch (err) {
          log.warn({ err, speciesId: id }, "Couldn't fetch this species' description");
        }
      }

      // Independent queries, run together.
      const [
        capturesRes,
        userSpeciesRes,
        archivedRes,
        referencePhotosRes,
        regionSpeciesRes,
        regionNameRes,
        endemicRes,
        hotspotsRes,
        regionBboxRes,
      ] = await Promise.all([
        pool.query(
          `SELECT c.*, p.id AS photo_id, p.display_path, p.thumb_path, p.width, p.height,
                    p.kind AS photo_kind, p.duration_seconds, reg.name AS region_name,
                    o.ref AS original_ref, o.managed AS original_managed, o.kind AS original_kind,
                    o.volume_id AS original_volume_id, o.volume_relative_path AS original_volume_relative_path,
                    EXISTS (SELECT 1 FROM originals ro WHERE ro.capture_id = c.id AND ro.kind = 'raw') AS has_raw_original,
                    -- Shown by name in the photo viewer, so you can find the RAW on disk yourself.
                    (SELECT rr.ref FROM originals rr WHERE rr.capture_id = c.id AND rr.kind = 'raw' LIMIT 1) AS raw_ref
             FROM captures c
             LEFT JOIN photos p ON p.id = c.current_photo_id
             LEFT JOIN regions reg ON reg.id = c.region_id
             -- One original per capture (the JPEG when there is one), so a capture with a RAW
             -- isn't listed twice. has_raw_original above still reports the RAW.
             LEFT JOIN LATERAL (
               SELECT * FROM originals o WHERE o.capture_id = c.id ORDER BY (o.kind = 'jpeg') DESC LIMIT 1
             ) o ON true
             WHERE c.user_id = $1
               AND (c.species_id = $2 OR EXISTS (SELECT 1 FROM capture_species cs WHERE cs.capture_id = c.id AND cs.species_id = $2))
             ORDER BY c.taken_at DESC NULLS LAST, c.created_at DESC`,
          [userId, id],
        ),
        pool.query(`SELECT * FROM user_species WHERE user_id = $1 AND species_id = $2`, [userId, id]),
        pool.query(`SELECT 1 FROM user_archived_species WHERE user_id = $1 AND species_id = $2`, [userId, id]),
        pool.query(
          `SELECT id, photo_url, credit, license, display_path IS NOT NULL AS has_cached_photo, focal_x, focal_y
             FROM species_reference_photos WHERE species_id = $1 ORDER BY sort_order`,
          [id],
        ),
        // Monthly and weekly observation data and local rarity only mean something per region.
        regionId
          ? pool.query(
              `SELECT seasonality, local_tier, is_vagrant, is_invasive, weekly_frequency FROM region_species WHERE region_id = $1 AND species_id = $2`,
              [regionId, id],
            )
          : Promise.resolve(null),
        // Shown beside those charts so they don't read as global data.
        regionId ? pool.query(`SELECT name FROM regions WHERE id = $1`, [regionId]) : Promise.resolve(null),
        // Endemic country (species_traits.endemic_country_iso3), resolved to its current name.
        species.endemic_country_iso3
          ? pool.query(`SELECT name FROM regions WHERE external_codes = ARRAY[$1]::text[]`, [
              species.endemic_country_iso3,
            ])
          : Promise.resolve(null),
        // Hotspot clusters (migration 074): which town, park or lake, not just which province.
        hotspotRegionId
          ? pool.query(
              `SELECT centroid_lat, centroid_lon, point_count, bbox_diagonal_km, last_seen_year, distinct_years
                 FROM region_species_hotspots WHERE region_id = $1 AND species_id = $2
                 ORDER BY point_count DESC`,
              [hotspotRegionId, id],
            )
          : Promise.resolve(null),
        // The hotspot region's extent, to tell "widespread" from "many spots in one corner".
        hotspotRegionId
          ? pool.query(`SELECT boundary_geojson FROM regions WHERE id = $1`, [hotspotRegionId])
          : Promise.resolve(null),
      ]);
      const isArchived = archivedRes.rows.length > 0;
      const seasonality: number[] | null = regionSpeciesRes?.rows[0]?.seasonality ?? null;
      // Rarity ranked against this region's own checklist, alongside the global tier.
      const localTier: string | null = regionSpeciesRes?.rows[0]?.local_tier ?? null;
      const isVagrant = regionSpeciesRes?.rows[0]?.is_vagrant === true;
      const isInvasive = regionSpeciesRes?.rows[0]?.is_invasive === true;
      const weeklyFrequency: number[] | null = regionSpeciesRes?.rows[0]?.weekly_frequency ?? null;
      const weeklyRegionName: string | null = regionNameRes?.rows[0]?.name ?? null;
      const hotspots = hotspotsRes?.rows ?? [];

      // Whether each original is still reachable, checked live and concurrently. A volume-tagged
      // one is resolved first, so an unplugged drive shows its label instead of "missing".
      const originalStatuses = await Promise.all(
        capturesRes.rows.map(async (c): Promise<{ available: boolean | null; volumeLabel: string | null }> => {
          if (!c.original_ref) return { available: null, volumeLabel: null };
          const resolved = await resolveOriginalPath({
            ref: c.original_ref,
            volume_id: c.original_volume_id,
            volume_relative_path: c.original_volume_relative_path,
          });
          if (!resolved.connected) return { available: false, volumeLabel: resolved.volumeLabel ?? null };
          const exists = resolved.path
            ? await fsAccess(resolved.path).then(
                () => true,
                () => false,
              )
            : false;
          return { available: exists, volumeLabel: null };
        }),
      );
      const captures = capturesRes.rows.map((c, i) => ({
        ...c,
        original_available: originalStatuses[i].available,
        original_volume_label: originalStatuses[i].volumeLabel,
      }));

      const endemicCountryName: string | null = endemicRes?.rows[0]?.name ?? null;
      const endemicLabel: string | null = species.endemic_region_label ?? endemicCountryName;

      // The cached local copy when there is one, else the original external URL. File paths
      // never leave the server.
      const referencePhotoUrl = species.reference_display_path
        ? `/api/species/${id}/reference-photo/display?v=${MEDIA_CACHE_BUST}`
        : species.reference_photo;
      const referencePhotos = referencePhotosRes.rows.map((p) => ({
        ...p,
        photo_url: p.has_cached_photo
          ? `/api/species/reference-gallery-photo/${p.id}/display?v=${MEDIA_CACHE_BUST}`
          : p.photo_url,
      }));

      return {
        species: { ...species, reference_photo_url: referencePhotoUrl },
        captures,
        userSpecies: userSpeciesRes.rows[0] ?? null,
        referencePhotos,
        seasonality,
        weeklyFrequency,
        weeklyRegionName,
        localTier,
        isVagrant,
        isInvasive,
        endemicCountryName: endemicLabel,
        isArchived,
        regionBoundaryGeoJson: regionBboxRes?.rows[0]?.boundary_geojson ?? null,
        ...(() => {
          const totalPoints = hotspots.reduce((sum: number, h) => sum + h.point_count, 0);
          const topShare = hotspots.length > 0 ? hotspots[0].point_count / totalPoints : 0;
          // Widespread needs many clusters with none dominant, spread over most of the region.
          let spanRatio = 1; // no region bbox available: assume it could span the whole thing
          const bbox = regionBboxRes?.rows[0]?.boundary_geojson?.bbox as [number, number, number, number] | undefined;
          if (bbox && hotspots.length > 1) {
            const regionDiagonal = bboxDiagonalDegrees({
              minLon: bbox[0],
              minLat: bbox[1],
              maxLon: bbox[2],
              maxLat: bbox[3],
            });
            const centroidBbox: BoundingBox = ringBoundingBox(
              hotspots.map((h): [number, number] => [h.centroid_lon, h.centroid_lat]),
            );
            const centroidSpread = bboxDiagonalDegrees(centroidBbox);
            spanRatio = regionDiagonal > 0 ? centroidSpread / regionDiagonal : 1;
          }
          const isWidespread = hotspots.length >= 6 && topShare < 0.25 && spanRatio >= 0.6;
          // A reliable cluster recurs over 3+ separate years and is nearly as recent as the
          // freshest record this species has in the region (not judged against today's date).
          const RELIABLE_MIN_DISTINCT_YEARS = 3;
          const RELIABLE_MAX_YEARS_BEHIND_FRESHEST = 5;
          const freshestYear = hotspots.reduce<number | null>(
            (max, h) => (h.last_seen_year != null && (max == null || h.last_seen_year > max) ? h.last_seen_year : max),
            null,
          );
          return {
            hotspotDistribution: hotspots.length > 0 ? (isWidespread ? "widespread" : "clustered") : null,
            hotspots: hotspots.map((h) => ({
              centroidLat: h.centroid_lat,
              centroidLon: h.centroid_lon,
              pointCount: h.point_count,
              bboxDiagonalKm: h.bbox_diagonal_km,
              // Exactly this size means the location was blurred for a sensitive species.
              isSensitive: h.bbox_diagonal_km === SENSITIVE_CLUSTER_DIAGONAL_KM,
              lastSeenYear: h.last_seen_year,
              distinctYears: h.distinct_years,
              recordShare: totalPoints > 0 ? h.point_count / totalPoints : 0,
              // A vagrant has no repeating pattern here, so no cluster of it is reliable.
              isReliable:
                !isVagrant &&
                h.distinct_years != null &&
                h.distinct_years >= RELIABLE_MIN_DISTINCT_YEARS &&
                h.last_seen_year != null &&
                freshestYear != null &&
                freshestYear - h.last_seen_year <= RELIABLE_MAX_YEARS_BEHIND_FRESHEST,
            })),
          };
        })(),
      };
    },
  );

  // Marking "seen" never overwrites `collected`, and unmarking only clears a `seen` row.
  app.patch("/species/:id/seen", markOptions, async (request) => {
    const { id: speciesId } = request.params;
    const userId = request.user!.id;
    await pool.query(
      `INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'seen')
       ON CONFLICT (user_id, species_id) DO NOTHING`,
      [userId, speciesId],
    );
    return { ok: true };
  });

  app.delete("/species/:id/seen", markOptions, async (request) => {
    const { id: speciesId } = request.params;
    const userId = request.user!.id;
    await pool.query(`DELETE FROM user_species WHERE user_id = $1 AND species_id = $2 AND state = 'seen'`, [
      userId,
      speciesId,
    ]);
    return { ok: true };
  });

  // is_target (migration 090) is independent of `state`, so a collected species can be a target.
  app.patch("/species/:id/target", markOptions, async (request) => {
    const { id: speciesId } = request.params;
    const userId = request.user!.id;
    await pool.query(
      `INSERT INTO user_species (user_id, species_id, is_target) VALUES ($1, $2, true)
       ON CONFLICT (user_id, species_id) DO UPDATE SET is_target = true`,
      [userId, speciesId],
    );
    return { ok: true };
  });

  app.delete("/species/:id/target", markOptions, async (request) => {
    const { id: speciesId } = request.params;
    const userId = request.user!.id;
    await pool.query(`UPDATE user_species SET is_target = false WHERE user_id = $1 AND species_id = $2`, [
      userId,
      speciesId,
    ]);
    // A row with no state and no target is removed, so "no row" still means "unseen".
    await pool.query(
      `DELETE FROM user_species WHERE user_id = $1 AND species_id = $2 AND state IS NULL AND is_target = false`,
      [userId, speciesId],
    );
    return { ok: true };
  });

  // RAWs filed straight into this species' folder by /uploads/raw (no capture) get their own list.
  app.get("/species/:id/unmatched-raws", readOptions, async (request) => {
    const res = await pool.query<{ id: string; ref: string; file_size: string; last_seen_at: string }>(
      `SELECT id, ref, file_size, last_seen_at FROM originals
       WHERE species_id = $1 AND user_id = $2 AND capture_id IS NULL AND kind = 'raw'
       ORDER BY last_seen_at DESC`,
      [request.params.id, request.user!.id],
    );
    return {
      rawFiles: res.rows.map((r) => ({
        id: r.id,
        filename: r.ref.split("/").pop(),
        fileSize: Number(r.file_size),
        addedAt: r.last_seen_at,
        previewUrl: `/api/originals/${r.id}/preview`,
        downloadUrl: `/api/originals/${r.id}/download`,
      })),
    };
  });

  // The stat line: photos, videos, encounters (clusterIntoEncounters), locations, cameras, lenses.
  app.get("/species/:id/encounters", readOptions, async (request) => {
    const res = await pool.query<{
      id: string;
      taken_at: string | null;
      region_id: string | null;
      camera_model: string | null;
      lens: string | null;
      kind: string | null;
    }>(
      `SELECT c.id, c.taken_at, c.region_id, c.camera_model, c.lens, p.kind
       FROM captures c LEFT JOIN photos p ON p.id = c.current_photo_id
       WHERE c.species_id = $1 AND c.user_id = $2`,
      [request.params.id, request.user!.id],
    );
    const encounters = clusterIntoEncounters(res.rows.map((r) => ({ id: r.id, takenAt: r.taken_at })));
    const takenDates = res.rows.map((r) => r.taken_at).filter((t): t is string => t !== null);
    // Videos are counted apart from photos (kind lives on photos, migration 230).
    const videoCount = res.rows.filter((r) => r.kind === "video").length;
    return {
      totalPhotos: res.rows.length - videoCount,
      videoCount,
      encounterCount: encounters.length,
      locationCount: new Set(res.rows.map((r) => r.region_id).filter(Boolean)).size,
      cameraCount: new Set(res.rows.map((r) => r.camera_model).filter(Boolean)).size,
      lensCount: new Set(res.rows.map((r) => r.lens).filter(Boolean)).size,
      firstPhotographedAt: takenDates.length ? takenDates.reduce((a, b) => (a < b ? a : b)) : null,
      lastPhotographedAt: takenDates.length ? takenDates.reduce((a, b) => (a > b ? a : b)) : null,
    };
  });

  // Bursts of 3+ near-identical frames, each with its sharpest frame (lib/sharpness.ts) as the
  // representative.
  app.get("/species/:id/sequences", readOptions, async (request) => {
    const res = await pool.query<{
      photo_id: string;
      taken_at: string | null;
      display_path: string | null;
      embedding: number[] | null;
    }>(
      `SELECT p.id AS photo_id, c.taken_at, p.display_path, ce.embedding
       FROM captures c
       JOIN photos p ON p.id = c.current_photo_id
       LEFT JOIN capture_embeddings ce ON ce.capture_id = c.id AND ce.model_version = $3
       WHERE c.species_id = $1 AND c.user_id = $2 AND c.taken_at IS NOT NULL
       ORDER BY c.taken_at`,
      [request.params.id, request.user!.id, EMBEDDING_MODEL_VERSION],
    );

    const groups: (typeof res.rows)[number][][] = [];
    for (const row of res.rows) {
      const prevGroup = groups[groups.length - 1];
      const prev = prevGroup?.[prevGroup.length - 1];
      const gapMs = prev ? new Date(row.taken_at!).getTime() - new Date(prev.taken_at!).getTime() : Infinity;
      const similar =
        prev?.embedding && row.embedding && cosineSimilarity(prev.embedding, row.embedding) > BURST_SIMILARITY;
      if (prevGroup && similar && gapMs <= BURST_MAX_GAP_MS) prevGroup.push(row);
      else groups.push([row]);
    }

    const burstGroups = groups.filter((g) => g.length >= 3);
    const sequences = await Promise.all(
      burstGroups.map(async (group) => {
        const scored = await Promise.all(
          group.map(async (row) => {
            if (!row.display_path || !existsSync(row.display_path)) return { photoId: row.photo_id, sharpness: 0 };
            try {
              const buffer = await fsReadFile(row.display_path);
              return { photoId: row.photo_id, sharpness: await computeSharpness(buffer) };
            } catch {
              return { photoId: row.photo_id, sharpness: 0 };
            }
          }),
        );
        const best = scored.reduce((a, b) => (b.sharpness > a.sharpness ? b : a));
        return { photoIds: group.map((r) => r.photo_id), bestPhotoId: best.photoId, count: group.length };
      }),
    );
    return { sequences };
  });

  // Which registered drives already hold this species' photos, for the import destination
  // picker's recommended drive. Every drive in use is returned, busiest first.
  app.get("/species/:id/volume-usage", readOptions, async (request) => {
    const res = await pool.query<{ volume_id: string | null; label: string | null; count: string }>(
      `SELECT sv.id AS volume_id, sv.label, COUNT(*) AS count
       FROM captures c
       JOIN originals o ON o.capture_id = c.id AND o.kind = 'jpeg'
       LEFT JOIN storage_volumes sv ON sv.id = o.volume_id
       WHERE c.user_id = $1 AND c.species_id = $2
       GROUP BY sv.id, sv.label
       ORDER BY count DESC`,
      [request.user!.id, request.params.id],
    );
    return {
      volumes: res.rows.map((r) => ({ volumeId: r.volume_id, label: r.label, count: Number(r.count) })),
    };
  });
}
