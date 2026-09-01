import { createReadStream, existsSync, statSync } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";
import {
  enrichSpecies,
  persistEnrichment,
  fetchAnyGallery,
  persistGalleryPromotingMainIfMissing,
  downloadAndCacheImage,
} from "./lazyEnrich.js";
import { MEDIA_CACHE_BUST, SINGLE_USER_MODE } from "../config.js";
import { resolveOriginalPath } from "../storageVolumes/resolve.js";

interface SearchQuery {
  q?: string;
}

export async function speciesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: SearchQuery }>("/species", { preHandler: requireAuth }, async (request) => {
    const q = (request.query.q ?? "").trim();
    const userId = request.user!.id;

    if (!q) {
      // No query yet: pin the user's most recently photographed species first.
      const recent = await pool.query(
        `SELECT DISTINCT ON (s.id) s.id, s.scientific_name, s.common_name, MAX(c.created_at) OVER (PARTITION BY s.id) AS last_used
         FROM captures c
         JOIN species s ON s.id = c.species_id
         WHERE c.user_id = $1
         ORDER BY s.id, last_used DESC
         LIMIT 10`,
        [userId],
      );
      return { results: recent.rows };
    }

    // pg_trgm similarity search across common + scientific name (spec §9 Phase 2: fuzzy search),
    // every known alias (common_name_aliases — e.g. "Peacock" finds "Indian Peafowl",
    // "Coin-Bearing Frogfish" finds "Spotfin Frogfish") so a search only matching the ONE name
    // our tie-break logic picked as primary doesn't come up empty for someone who knows the
    // species by a different real name, AND genus/family — so typing "Anas" (a genus) or
    // "Anatidae" (a family) surfaces every species in it, not just an exact species match.
    // Genus/family matches rank below a real name/alias match (ILIKE prefix only, no trigram
    // fuzziness — "Anas" fuzzy-matching some unrelated genus that merely LOOKS similar would be
    // a worse experience than requiring the exact rank name here) so searching a common bird's
    // actual name still surfaces it first even if it also happens to share a genus prefix with
    // something else. A fully extinct species (no living individual anywhere, wild or captive —
    // see species_traits.fully_extinct's own comment) can never be photographed, so it's
    // excluded from the picker entirely rather than offered as a choice.
    const res = await pool.query(
      `SELECT s.id, s.scientific_name, s.common_name,
              GREATEST(
                similarity(s.common_name, $1),
                similarity(s.scientific_name, $1),
                COALESCE((SELECT MAX(similarity(a, $1)) FROM unnest(s.common_name_aliases) a), 0),
                CASE WHEN s.genus ILIKE $1 || '%' OR s.family ILIKE $1 || '%' THEN 0.3 ELSE 0 END
              ) AS rank
       FROM species s
       LEFT JOIN species_traits t ON t.species_id = s.id
       WHERE (
         s.common_name % $1 OR s.scientific_name % $1 OR s.common_name ILIKE '%' || $1 || '%'
         OR EXISTS (SELECT 1 FROM unnest(s.common_name_aliases) a WHERE a % $1 OR a ILIKE '%' || $1 || '%')
         OR s.genus ILIKE $1 || '%' OR s.family ILIKE $1 || '%'
       )
         AND COALESCE(t.fully_extinct, false) = false
       ORDER BY rank DESC
       LIMIT 20`,
      [q],
    );
    return { results: res.rows };
  });

  app.get<{ Params: { id: string }; Querystring: { regionId?: string } }>(
    "/species/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params;
      const { regionId } = request.query;
      const userId = request.user!.id;

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

      // Lazy enrichment (see lazyEnrich.ts) — on first view of a species, fetch its
      // reference photo + blurb + gallery now instead of the full ~11,000-species backbone
      // having fetched all of them eagerly (8+ hours for species that may never be viewed).
      // enriched_at means "already tried," regardless of outcome, so a species with nothing
      // usable isn't re-fetched on every view. SINGLE_USER_MODE (the desktop build — see
      // api.rs) blocks this path ONLY for a species some downloaded pack actually claims to
      // cover (pack_species, migration 054) — that species missing pack data should read as
      // "pack not installed," never as a live call the "fully offline" install wasn't supposed
      // to make for it. A species NOT covered by any downloaded pack at all (e.g. photographed
      // somewhere with no offline pack downloaded yet, or a taxon group with no pack built yet)
      // has no offline promise to keep in the first place, so a live call for THAT species is
      // a real improvement (a real photo/gallery instead of a permanently blank page), not a
      // violation of the guarantee.
      const packCoverageRes = SINGLE_USER_MODE
        ? await pool.query(`SELECT 1 FROM pack_species WHERE species_id = $1 LIMIT 1`, [id])
        : null;
      const liveCallsAllowed = !SINGLE_USER_MODE || (packCoverageRes?.rowCount ?? 0) === 0;

      if (!species.enriched_at && liveCallsAllowed) {
        // No skipGallery here (unlike enrich-all-species.ts's bulk pass), so this always runs
        // the full gallery fetch including the slow Wikipedia/Commons fallback — safe to mark
        // gallery_backfilled_at done immediately rather than leaving it for the branch below.
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
        // Backfills the gallery for species the bulk overnight pass (enrich-all-species.ts)
        // already marked enriched_at on but deliberately skipped the slow Wikipedia fallback
        // for (see lazyEnrich.ts's skipGallery comment) — paid once, on-demand, the first
        // time someone actually opens this page, same as the lazy path above was already
        // designed to do. No longer gated on wikipedia_title — the primary gallery source
        // (iNaturalist) doesn't need one.
        //
        // Gated on gallery_backfilled_at (migration 035), NOT a live species_reference_photos
        // row count — a species with genuinely zero photos anywhere (no iNaturalist gallery,
        // no Wikipedia article, or the Commons fallback found nothing usable) has a row count
        // of 0 forever, so a count-based check re-ran this fetch on every single page view.
        //
        // Deliberately NOT awaited — this is the common case (most species already went
        // through the bulk pass, so they already have a real reference_photo/description; the
        // gallery is the only thing missing). Blocking the whole page response on it added a
        // real, avoidable couple-second delay to the FIRST view of every one of those species,
        // for something the page can show perfectly well without yet (an empty/short gallery
        // that fills in on the next visit). Errors are swallowed here for the same reason
        // enrichSpecies's own gallery step doesn't fail the request — a bad fetch just leaves
        // gallery_backfilled_at unset, so it's retried on a later view instead of stuck.
        fetchAnyGallery(species)
          .then((gallery) => persistGalleryPromotingMainIfMissing(id, gallery, !!species.reference_photo))
          .then(() => pool.query(`UPDATE species SET gallery_backfilled_at = now() WHERE id = $1`, [id]))
          .catch((err) => console.error(`[species] background gallery backfill failed for ${id}:`, err));
      }

      // These five queries are all independent of each other (only the species row already
      // fetched above feeds any of them) — firing them together instead of one-at-a-time
      // turns 5 sequential DB round-trips into 1 wait for the slowest, which is most of what
      // made this "everything's local" page feel slower than it had any reason to.
      const [capturesRes, userSpeciesRes, archivedRes, referencePhotosRes, regionSpeciesRes, endemicRes] =
        await Promise.all([
          pool.query(
            `SELECT c.*, p.id AS photo_id, p.display_path, p.thumb_path, p.width, p.height,
                    o.ref AS original_ref, o.managed AS original_managed, o.kind AS original_kind,
                    o.volume_id AS original_volume_id, o.volume_relative_path AS original_volume_relative_path,
                    EXISTS (SELECT 1 FROM originals ro WHERE ro.capture_id = c.id AND ro.kind = 'raw') AS has_raw_original
             FROM captures c
             LEFT JOIN photos p ON p.id = c.current_photo_id
             -- A capture can have both a jpeg and a raw original — picking one per capture here
             -- (jpeg preferred, it's the viewable one) instead of a plain LEFT JOIN, which would
             -- otherwise duplicate the capture into two rows and show it twice on the page.
             -- has_raw_original (above) is a separate EXISTS check specifically so a RAW sibling
             -- is never hidden just because the JPEG won this LATERAL join's tiebreak.
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
          // 12-monthly observation bar (see migration 009 — GBIF only facets by month, not
          // week-of-year, so this is monthly resolution, not the 52-week sparkline the
          // original spec sketch imagined). Only meaningful in a region context — a species'
          // seasonality in BC differs from Canada-wide — so this is null unless the caller is
          // viewing the species from a specific region page.
          regionId
            ? pool.query(
                `SELECT seasonality, local_tier, is_vagrant FROM region_species WHERE region_id = $1 AND species_id = $2`,
                [regionId, id],
              )
            : Promise.resolve(null),
          // Endemic — species_traits.endemic_country_iso3 is set by apply-rarity-phase4.ts
          // from the same 258-country GBIF crawl elusiveness already uses; resolved to a
          // display name here rather than stored denormalized, so a region rename never goes
          // stale. verify-and-label-endemics.ts re-verifies this against a direct per-species
          // GBIF country facet (clearing it if the species turns out to be real in more than
          // one country) and, for species that verify as truly single-country, tries to
          // extract a richer named-place label from the species' own description text
          // (endemic_region_label, e.g. "the Nile" or "Lake Baikal in Russia") — shown instead
          // of the plain country name when present, since it's strictly more specific and was
          // only ever extracted for a species already confirmed to belong to exactly that one
          // country.
          species.endemic_country_iso3
            ? pool.query(`SELECT name FROM regions WHERE external_codes = ARRAY[$1]::text[]`, [
                species.endemic_country_iso3,
              ])
            : Promise.resolve(null),
        ]);
      const isArchived = archivedRes.rows.length > 0;
      const seasonality: number[] | null = regionSpeciesRes?.rows[0]?.seasonality ?? null;
      // Region-scoped rarity — ranked against other species actually on this region's own
      // checklist, alongside (not instead of) the fixed global tier.
      const localTier: string | null = regionSpeciesRes?.rows[0]?.local_tier ?? null;
      const isVagrant = regionSpeciesRes?.rows[0]?.is_vagrant === true;

      // 7c "unavailable original" state — a link-mode original's path can go stale (moved,
      // renamed, drive unmounted) independently of Lifer's own DB row, so this is checked
      // live rather than trusted from the `originals` row alone. Checked concurrently rather
      // than via synchronous existsSync() in a .map() — that blocked Node's whole event loop
      // on one filesystem stat call at a time, serially, for every photo in the gallery, which
      // is exactly the kind of thing that makes an "everything's local" page feel slow.
      //
      // A volume-tagged original (see ~/.claude/plans/multi-drive-storage.md) is resolved via
      // resolveOriginalPath first — a plain fsAccess on the stored `ref` alone can't tell "the
      // drive isn't plugged in right now" apart from "this file is actually gone", and only the
      // former has a helpful volumeLabel to show. `ref` also goes stale if the drive remounts
      // under a different name; resolveOriginalPath always recomputes the current real path.
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

      // Ready-to-use URLs, decided server-side (same pattern as collectionItem.ts's
      // coverPhotoUrl) — prefer the cached local copy, fall back to the original external
      // URL only when nothing's been cached for it (a fresh species not yet enriched, or a
      // best-effort download that failed). Raw filesystem paths never leave the server.
      const referencePhotoUrl = species.reference_display_path
        ? `/api/species/${id}/reference-photo/display?v=${MEDIA_CACHE_BUST}`
        : species.reference_photo;
      const referencePhotos = referencePhotosRes.rows.map((p) => ({
        ...p,
        photo_url: p.has_cached_photo ? `/api/species/reference-gallery-photo/${p.id}/display?v=${MEDIA_CACHE_BUST}` : p.photo_url,
      }));

      return {
        species: { ...species, reference_photo_url: referencePhotoUrl },
        captures,
        userSpecies: userSpeciesRes.rows[0] ?? null,
        referencePhotos,
        seasonality,
        localTier,
        isVagrant,
        endemicCountryName: endemicLabel,
        isArchived,
      };
    },
  );

  // Manual "seen" marking — until now only eBird CSV import (Phase 3) could set this state.
  // Mirrors the CSV import's own never-downgrade rule: marking never overwrites `collected`,
  // and unmarking only clears a `seen` row, never a `collected` one.
  app.patch<{ Params: { id: string } }>("/species/:id/seen", { preHandler: requireAuth }, async (request) => {
    const { id: speciesId } = request.params;
    const userId = request.user!.id;
    await pool.query(
      `INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'seen')
       ON CONFLICT (user_id, species_id) DO NOTHING`,
      [userId, speciesId],
    );
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/species/:id/seen", { preHandler: requireAuth }, async (request) => {
    const { id: speciesId } = request.params;
    const userId = request.user!.id;
    await pool.query(`DELETE FROM user_species WHERE user_id = $1 AND species_id = $2 AND state = 'seen'`, [
      userId,
      speciesId,
    ]);
    return { ok: true };
  });

  // A lightweight, enrichment-side-effect-free list of every reference photo (main + gallery)
  // for one species — used by the species-suggestion cards during import so a user can flip
  // through every photo this app has of a candidate species to visually compare against their
  // own new photo, instead of judging off a single thumbnail. Deliberately doesn't trigger
  // enrichSpecies/fetchAnyGallery like GET /species/:id does — by the time embedding-based
  // suggestions surface a species at all, it's already been enriched (the reference embedding
  // that made the match possible is itself derived from these same cached photos).
  app.get<{ Params: { id: string } }>("/species/:id/reference-photos", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params;
    const speciesRes = await pool.query<{
      reference_photo: string | null;
      reference_display_path: string | null;
      reference_credit: string | null;
    }>(`SELECT reference_photo, reference_display_path, reference_credit FROM species WHERE id = $1`, [id]);
    const species = speciesRes.rows[0];
    if (!species) return reply.code(404).send({ error: "Species not found" });

    const galleryRes = await pool.query<{ id: string; photo_url: string; credit: string | null; has_cached_photo: boolean }>(
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
        url: g.has_cached_photo ? `/api/species/reference-gallery-photo/${g.id}/display?v=${MEDIA_CACHE_BUST}` : g.photo_url,
        credit: g.credit,
      });
    }
    return { photos };
  });

  // RAWs filed directly into this species' RAW folder by /uploads/raw's unmatched-fallback
  // (species_id set, capture_id null) have no capture to show up alongside in the normal
  // captures list, so they get their own small listing instead of silently existing only on
  // disk.
  app.get<{ Params: { id: string } }>("/species/:id/unmatched-raws", { preHandler: requireAuth }, async (request) => {
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

  // Powers the import destination picker's "recommended drive" hint (see
  // ~/.claude/plans/multi-drive-storage.md) — which registered drives already hold photos of
  // this species, so a new upload can default to keeping them together rather than scattering
  // one species across drives by accident. A species can legitimately have photos split
  // across more than one drive (e.g. shot on different trips), so this returns every drive in
  // use, not just a single "the" answer — the frontend picks the top one as the default.
  app.get<{ Params: { id: string } }>("/species/:id/volume-usage", { preHandler: requireAuth }, async (request) => {
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

  // Unlike a user's own capture (keyed by an immutable photo id — its file content never
  // changes after upload), a reference photo's path can end up pointing at genuinely
  // different bytes over time: species.reference_display_path/reference_thumb_path is
  // overwritten in place whenever a species' reference photo gets re-fetched/restored (see
  // scripts/fix-portrait-*) or re-extracted from a newly-downloaded pack — all while the API
  // process (and its MEDIA_CACHE_BUST-versioned URL) keeps running, so the URL itself doesn't
  // change to signal that. no-cache (NOT no-store) forces the browser to always ask again
  // rather than blindly trusting a local hit, but with no validator that "ask again" was a
  // full re-download every single time, which is what made repeat views feel slow instead of
  // instant. An ETag from the file's own mtime+size gives the browser something to compare —
  // unchanged file, unchanged ETag, and this returns a 304 in place of the image bytes.
  function sendCachedFile(request: FastifyRequest, reply: FastifyReply, filePath: string) {
    const stat = statSync(filePath);
    const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
    reply.header("Content-Type", "image/webp");
    reply.header("Cache-Control", "no-cache");
    reply.header("ETag", etag);
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();
    return reply.send(createReadStream(filePath));
  }

  // Cached reference photos — same public-content-for-every-user reasoning as the rest of
  // this file's read routes, just serving a local file instead of a DB row's JSON.
  // requireAuth only (no ownership check needed, unlike photos/routes.ts' user-photo
  // serving — a species' reference photo isn't private to anyone).
  for (const kind of ["display", "thumb"] as const) {
    const column = kind === "display" ? "reference_display_path" : "reference_thumb_path";
    app.get<{ Params: { id: string } }>(`/species/:id/reference-photo/${kind}`, { preHandler: requireAuth }, async (request, reply) => {
      const res = await pool.query<{ path: string | null; photo_url: string | null }>(
        `SELECT ${column} AS path, reference_photo AS photo_url FROM species WHERE id = $1`,
        [request.params.id],
      );
      let filePath = res.rows[0]?.path;
      const photoUrl = res.rows[0]?.photo_url;
      if (!filePath || !existsSync(filePath)) {
        // The column pointed at a file that isn't on THIS machine — either genuinely gone, or
        // (the common case: a catalog seed built on one machine baking in that machine's own
        // cache path) never existed here in the first place. Since reference_photo (the
        // original remote URL) is still known, this is a cheap one-time image re-download —
        // not a live iNaturalist metadata search — so it's safe to do inline on a cache miss
        // rather than leaving the species permanently photo-less until a bulk pass revisits it.
        const recovered = photoUrl && (await downloadAndCacheImage(photoUrl, request.params.id));
        if (recovered) {
          await pool.query(
            `UPDATE species SET reference_display_path = $1, reference_thumb_path = $2 WHERE id = $3`,
            [recovered.displayPath, recovered.thumbPath, request.params.id],
          );
          filePath = recovered[column === "reference_display_path" ? "displayPath" : "thumbPath"];
        } else {
          if (filePath) {
            await pool
              .query(
                `UPDATE species SET reference_display_path = NULL, reference_thumb_path = NULL WHERE id = $1`,
                [request.params.id],
              )
              .catch(() => {});
          }
          return reply.code(404).send({ error: "Reference photo not found" });
        }
      }
      return sendCachedFile(request, reply, filePath);
    });

    const galleryColumn = kind === "display" ? "display_path" : "thumb_path";
    app.get<{ Params: { photoId: string } }>(
      `/species/reference-gallery-photo/:photoId/${kind}`,
      { preHandler: requireAuth },
      async (request, reply) => {
        const res = await pool.query<{ path: string | null; photo_url: string }>(
          `SELECT ${galleryColumn} AS path, photo_url FROM species_reference_photos WHERE id = $1`,
          [request.params.photoId],
        );
        let filePath = res.rows[0]?.path;
        const photoUrl = res.rows[0]?.photo_url;
        if (!filePath || !existsSync(filePath)) {
          const recovered = photoUrl && (await downloadAndCacheImage(photoUrl, request.params.photoId));
          if (recovered) {
            await pool.query(`UPDATE species_reference_photos SET display_path = $1, thumb_path = $2 WHERE id = $3`, [
              recovered.displayPath,
              recovered.thumbPath,
              request.params.photoId,
            ]);
            filePath = recovered[galleryColumn === "display_path" ? "displayPath" : "thumbPath"];
          } else {
            if (filePath) {
              await pool
                .query(
                  `UPDATE species_reference_photos SET display_path = NULL, thumb_path = NULL WHERE id = $1`,
                  [request.params.photoId],
                )
                .catch(() => {});
            }
            return reply.code(404).send({ error: "Gallery photo not found" });
          }
        }
        return sendCachedFile(request, reply, filePath);
      },
    );
  }
}
