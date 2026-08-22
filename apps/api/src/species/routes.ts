import { createReadStream, existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";
import { enrichSpecies, persistEnrichment, fetchAnyGallery, persistGalleryPromotingMainIfMissing } from "./lazyEnrich.js";

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

    // pg_trgm similarity search across common + scientific name (spec §9 Phase 2: fuzzy search).
    // A fully extinct species (no living individual anywhere, wild or captive — see
    // species_traits.fully_extinct's own comment) can never be photographed, so it's excluded
    // from the picker entirely rather than offered as a choice.
    const res = await pool.query(
      `SELECT s.id, s.scientific_name, s.common_name,
              GREATEST(similarity(s.common_name, $1), similarity(s.scientific_name, $1)) AS rank
       FROM species s
       LEFT JOIN species_traits t ON t.species_id = s.id
       WHERE (s.common_name % $1 OR s.scientific_name % $1 OR s.common_name ILIKE '%' || $1 || '%')
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
        const enrichment = await enrichSpecies(species);
        await persistEnrichment(id, enrichment);
        speciesRes = await pool.query(
          `SELECT s.*, t.*, r.tier, r.composite
           FROM species s
           LEFT JOIN species_traits t ON t.species_id = s.id
           LEFT JOIN species_rarity r ON r.species_id = s.id
           WHERE s.id = $1`,
          [id],
        );
        species = speciesRes.rows[0];
      } else {
        // Backfills the gallery for species the bulk overnight pass (enrich-all-species.ts)
        // already marked enriched_at on but deliberately skipped the slow Wikipedia fallback
        // for (see lazyEnrich.ts's skipGallery comment) — paid once, on-demand, the first
        // time someone actually opens this page, same as the lazy path above was already
        // designed to do. No longer gated on wikipedia_title — the primary gallery source
        // (iNaturalist) doesn't need one.
        const galleryCountRes = await pool.query<{ count: string }>(
          `SELECT count(*) FROM species_reference_photos WHERE species_id = $1`,
          [id],
        );
        if (Number(galleryCountRes.rows[0].count) === 0) {
          const gallery = await fetchAnyGallery(species);
          await persistGalleryPromotingMainIfMissing(id, gallery, !!species.reference_photo);
          speciesRes = await pool.query(
            `SELECT s.*, t.*, r.tier, r.composite
             FROM species s
             LEFT JOIN species_traits t ON t.species_id = s.id
             LEFT JOIN species_rarity r ON r.species_id = s.id
             WHERE s.id = $1`,
            [id],
          );
          species = speciesRes.rows[0];
        }
      }

      const capturesRes = await pool.query(
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
      );

      const userSpeciesRes = await pool.query(`SELECT * FROM user_species WHERE user_id = $1 AND species_id = $2`, [
        userId,
        id,
      ]);

      const referencePhotosRes = await pool.query(
        `SELECT id, photo_url, credit, license, display_path IS NOT NULL AS has_cached_photo
         FROM species_reference_photos WHERE species_id = $1 ORDER BY sort_order`,
        [id],
      );

      // 12-monthly observation bar (see migration 009 — GBIF only facets by month, not
      // week-of-year, so this is monthly resolution, not the 52-week sparkline the original
      // spec sketch imagined). Only meaningful in a region context — a species' seasonality
      // in BC differs from Canada-wide — so this is null unless the caller is viewing the
      // species from a specific region page.
      let seasonality: number[] | null = null;
      let localTier: string | null = null;
      let isVagrant = false;
      if (regionId) {
        const regionSpeciesRes = await pool.query(
          `SELECT seasonality, local_tier, is_vagrant FROM region_species WHERE region_id = $1 AND species_id = $2`,
          [regionId, id],
        );
        seasonality = regionSpeciesRes.rows[0]?.seasonality ?? null;
        // Region-scoped rarity — ranked against other species actually on this region's own
        // checklist, alongside (not instead of) the fixed global tier.
        localTier = regionSpeciesRes.rows[0]?.local_tier ?? null;
        isVagrant = regionSpeciesRes.rows[0]?.is_vagrant === true;
      }

      // 7c "unavailable original" state — a link-mode original's path can go stale (moved,
      // renamed, drive unmounted) independently of Lifer's own DB row, so this is checked
      // live rather than trusted from the `originals` row alone.
      const captures = capturesRes.rows.map((c) => ({
        ...c,
        original_available: c.original_ref ? existsSync(c.original_ref) : null,
      }));

      // Endemic — species_traits.endemic_country_iso3 is set by apply-rarity-phase4.ts from
      // the same 258-country GBIF crawl elusiveness already uses; resolved to a display name
      // here rather than stored denormalized, so a region rename never goes stale.
      let endemicCountryName: string | null = null;
      if (species.endemic_country_iso3) {
        const endemicRes = await pool.query(`SELECT name FROM regions WHERE external_codes = ARRAY[$1]::text[]`, [
          species.endemic_country_iso3,
        ]);
        endemicCountryName = endemicRes.rows[0]?.name ?? null;
      }

      // Ready-to-use URLs, decided server-side (same pattern as collectionItem.ts's
      // coverPhotoUrl) — prefer the cached local copy, fall back to the original external
      // URL only when nothing's been cached for it (a fresh species not yet enriched, or a
      // best-effort download that failed). Raw filesystem paths never leave the server.
      const referencePhotoUrl = species.reference_display_path ? `/api/species/${id}/reference-photo/display` : species.reference_photo;
      const referencePhotos = referencePhotosRes.rows.map((p) => ({
        ...p,
        photo_url: p.has_cached_photo ? `/api/species/reference-gallery-photo/${p.id}/display` : p.photo_url,
      }));

      return {
        species: { ...species, reference_photo_url: referencePhotoUrl },
        captures,
        userSpecies: userSpeciesRes.rows[0] ?? null,
        referencePhotos,
        seasonality,
        localTier,
        isVagrant,
        endemicCountryName,
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
        return reply.send(createReadStream(filePath));
      },
    );
  }
}
