import { createReadStream, existsSync } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";
import { enrichSpecies, persistEnrichment, fetchAnyGallery, persistGalleryPromotingMainIfMissing } from "./lazyEnrich.js";
import { MEDIA_CACHE_BUST } from "../config.js";

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
    // plus every known alias (common_name_aliases — e.g. "Peacock" finds "Indian Peafowl",
    // "Coin-Bearing Frogfish" finds "Spotfin Frogfish") so a search only matching the ONE name
    // our tie-break logic picked as primary doesn't come up empty for someone who knows the
    // species by a different real name. A fully extinct species (no living individual
    // anywhere, wild or captive — see species_traits.fully_extinct's own comment) can never be
    // photographed, so it's excluded from the picker entirely rather than offered as a choice.
    const res = await pool.query(
      `SELECT s.id, s.scientific_name, s.common_name,
              GREATEST(
                similarity(s.common_name, $1),
                similarity(s.scientific_name, $1),
                COALESCE((SELECT MAX(similarity(a, $1)) FROM unnest(s.common_name_aliases) a), 0)
              ) AS rank
       FROM species s
       LEFT JOIN species_traits t ON t.species_id = s.id
       WHERE (
         s.common_name % $1 OR s.scientific_name % $1 OR s.common_name ILIKE '%' || $1 || '%'
         OR EXISTS (SELECT 1 FROM unnest(s.common_name_aliases) a WHERE a % $1 OR a ILIKE '%' || $1 || '%')
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
      // usable isn't re-fetched on every view.
      if (!species.enriched_at) {
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
      } else if (!species.gallery_backfilled_at) {
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
            `SELECT c.*, p.id AS photo_id, p.display_path, p.thumb_path,
                    o.ref AS original_ref, o.managed AS original_managed, o.kind AS original_kind,
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
      const originalAvailability = await Promise.all(
        capturesRes.rows.map((c) =>
          c.original_ref
            ? fsAccess(c.original_ref).then(
                () => true,
                () => false,
              )
            : Promise.resolve(null),
        ),
      );
      const captures = capturesRes.rows.map((c, i) => ({
        ...c,
        original_available: originalAvailability[i],
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

  // Cached reference photos — same public-content-for-every-user reasoning as the rest of
  // this file's read routes, just serving a local file instead of a DB row's JSON.
  // requireAuth only (no ownership check needed, unlike photos/routes.ts' user-photo
  // serving — a species' reference photo isn't private to anyone).
  for (const kind of ["display", "thumb"] as const) {
    const column = kind === "display" ? "reference_display_path" : "reference_thumb_path";
    app.get<{ Params: { id: string } }>(`/species/:id/reference-photo/${kind}`, { preHandler: requireAuth }, async (request, reply) => {
      const res = await pool.query<{ path: string | null }>(`SELECT ${column} AS path FROM species WHERE id = $1`, [
        request.params.id,
      ]);
      const filePath = res.rows[0]?.path;
      if (!filePath || !existsSync(filePath)) return reply.code(404).send({ error: "Reference photo not found" });
      reply.header("Content-Type", "image/webp");
      // Unlike a user's own capture (keyed by an immutable photo id — its file content never
      // changes after upload), this same URL can end up pointing at genuinely different bytes
      // over time: species.reference_display_path is overwritten in place whenever a
      // species' reference photo gets re-fetched/restored (see scripts/fix-portrait-*). With
      // no cache header at all, the webview's own HTTP cache has no reason to ever ask again
      // once it's seen this URL — this is exactly what left restored photos looking
      // unchanged even after the underlying file was fixed. no-cache (NOT no-store) forces a
      // real request every time rather than a blind local hit; served over loopback, that
      // costs nothing worth avoiding on a single-user local install.
      reply.header("Cache-Control", "no-cache");
      return reply.send(createReadStream(filePath));
    });

    const galleryColumn = kind === "display" ? "display_path" : "thumb_path";
    app.get<{ Params: { photoId: string } }>(
      `/species/reference-gallery-photo/:photoId/${kind}`,
      { preHandler: requireAuth },
      async (request, reply) => {
        const res = await pool.query<{ path: string | null }>(
          `SELECT ${galleryColumn} AS path FROM species_reference_photos WHERE id = $1`,
          [request.params.photoId],
        );
        const filePath = res.rows[0]?.path;
        if (!filePath || !existsSync(filePath)) return reply.code(404).send({ error: "Gallery photo not found" });
        reply.header("Content-Type", "image/webp");
        // Same reasoning as the primary reference-photo route above — this URL's underlying
        // file can be overwritten in place by a restore pass, so it can't be cached forever.
        reply.header("Cache-Control", "no-cache");
        return reply.send(createReadStream(filePath));
      },
    );
  }
}
