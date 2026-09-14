import { createReadStream, existsSync, statSync } from "node:fs";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { pool } from "../db.js";
import { requireAuth, requireScope } from "../auth/session.js";
import {
  enrichSpecies,
  persistEnrichment,
  fetchAnyGallery,
  persistGalleryPromotingMainIfMissing,
  downloadAndCacheImage,
} from "./lazyEnrich.js";
import { MEDIA_CACHE_BUST, SINGLE_USER_MODE, EMBEDDING_MODEL_VERSION } from "../config.js";
import { resolveOriginalPath } from "../storageVolumes/resolve.js";
import { clusterIntoEncounters } from "../lib/clusterEncounters.js";
import { cosineSimilarity } from "./embeddings.js";
import { computeSharpness } from "../lib/sharpness.js";
import { bboxDiagonalDegrees, ringBoundingBox, type BoundingBox } from "data-pipeline/src/geometry.js";
import { SENSITIVE_CLUSTER_DIAGONAL_KM } from "data-pipeline/src/sensitive-species.js";

// iNaturalist's own vernacular names are inconsistently cased (e.g. "silver birch" all-lower,
// vs curated Clements/IOC bird names which already arrive title-cased) — every OTHER species'
// common_name in this catalog is title-cased, so an Other Taxa addition needs the same
// normalization or it reads as visibly out of place next to everything else.
function titleCaseCommonName(name: string): string {
  return name.replace(/(^|[\s-])([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

interface SearchQuery {
  q?: string;
}

export async function speciesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: SearchQuery }>("/species", { preHandler: requireScope("species.read") }, async (request) => {
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
                -- ABA (4-letter, US/Canada/Mexico/Central America/Caribbean only) and eBird
                -- (6-letter, every bird worldwide) alpha codes — ranked alongside a real
                -- name/alias match, not just the lower genus/family tier, since someone typing
                -- a code already knows exactly which species they mean.
                CASE WHEN s.aba_code ILIKE $1 || '%' OR s.ebird_code ILIKE $1 || '%' THEN 1 ELSE 0 END,
                CASE WHEN s.genus ILIKE $1 || '%' OR s.family ILIKE $1 || '%' THEN 0.3 ELSE 0 END
              ) AS rank
       FROM species s
       LEFT JOIN species_traits t ON t.species_id = s.id
       WHERE (
         s.common_name % $1 OR s.scientific_name % $1 OR s.common_name ILIKE '%' || $1 || '%'
         OR EXISTS (SELECT 1 FROM unnest(s.common_name_aliases) a WHERE a % $1 OR a ILIKE '%' || $1 || '%')
         OR s.genus ILIKE $1 || '%' OR s.family ILIKE $1 || '%'
         OR s.aba_code ILIKE $1 || '%' OR s.ebird_code ILIKE $1 || '%'
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
    { preHandler: requireScope("species.read") },
    async (request, reply) => {
      const { id } = request.params;
      const userId = request.user!.id;

      // Most navigation paths to this page (Collection's default "all regions" view, Gallery,
      // search) never set ?regionId= — only a drilled-into-one-region view does (see
      // SpeciesCard.tsx's `to={regionId ? ... : ...}`). Falling back to a real region (rather
      // than leaving every region-scoped section of the page — seasonality, local tier, and the
      // hotspot map — permanently blank outside that one narrow navigation path) makes "where to
      // find it" actually reachable from anywhere. A region only ever has data here if its own
      // pack was downloaded, so this never surfaces a region the user doesn't actually have
      // installed.
      //
      // Prefer a region with actual hotspot clusters first — those only ever exist at PROVINCE
      // granularity (compute-provinces-bulk.ts), never at the country level. A plain "most
      // records" pick over region_species would almost always land on a country's own
      // aggregated row instead (aggregate-country-from-provinces.ts sums every province into
      // it, so it dwarfs any single province's count) — a region that can never have hotspot
      // rows, silently blanking the map for most species despite real province-level data
      // existing right underneath it.
      const regionId =
        request.query.regionId ??
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

      // The fallback above only ever fires when NO ?regionId= was given at all — but the far
      // more common path (drilled into a country's own checklist, e.g. "South Africa," and
      // clicking a species from there) DOES pass one explicitly, and that's very often the
      // country's own top-level row, which NEVER has hotspot data (see the comment above —
      // hotspots only ever exist at province granularity). Confirmed live: Rufous-chested
      // Sparrowhawk has real hotspot clusters in every one of South Africa's own provinces, but
      // browsing it from South Africa's own checklist view still showed no map at all, because
      // the explicit country-level regionId silently beat the auto-resolve fallback above every
      // time. Seasonality/local tier below still use the region the user actually navigated
      // to (unchanged) — only the hotspot map itself needs a region that could ever have one.
      const givenRegionHasHotspots =
        regionId != null &&
        (await pool.query(`SELECT 1 FROM region_species_hotspots WHERE region_id = $1 AND species_id = $2 LIMIT 1`, [regionId, id]))
          .rowCount! > 0;
      // Only fall back to a totally different region when the GIVEN one is a country-level
      // aggregate row — those never have hotspot clusters at all (see the comment above), so
      // there's no honest "local" data to show and borrowing the globally-busiest province is
      // the whole point. A province/state that simply has no computed hotspots yet for THIS one
      // species is a different situation: it genuinely has no local data, and silently swapping
      // in some other province's clusters (BC → Ontario, say) with no indication to the user
      // reads as "here's where it is in BC" when it's nothing of the kind. Only substitute for
      // the country case; leave the province case with no hotspots at all — the frontend already
      // just omits the whole "Where to find it" section when `hotspots` comes back empty.
      const givenRegionIsCountry =
        regionId != null &&
        (await pool.query(`SELECT 1 FROM regions WHERE id = $1 AND sovereignty_group IS NOT NULL`, [regionId])).rowCount! > 0;
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
                    EXISTS (SELECT 1 FROM originals ro WHERE ro.capture_id = c.id AND ro.kind = 'raw') AS has_raw_original
             FROM captures c
             LEFT JOIN photos p ON p.id = c.current_photo_id
             LEFT JOIN regions reg ON reg.id = c.region_id
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
                `SELECT seasonality, local_tier, is_vagrant, is_invasive, weekly_frequency FROM region_species WHERE region_id = $1 AND species_id = $2`,
                [regionId, id],
              )
            : Promise.resolve(null),
          // Name of whichever region seasonality/weekly-frequency above actually came from
          // (either the caller's explicit ?regionId= or the auto-resolved fallback) — shown
          // alongside those charts so "observations by week" doesn't read as global data when
          // it's really scoped to one region the user may not have picked themselves.
          regionId ? pool.query(`SELECT name FROM regions WHERE id = $1`, [regionId]) : Promise.resolve(null),
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
          // Gap-finder hotspot clusters (migration 074) — "which town/park/lake," not just
          // "which province." Only fetched in a region context, same gating as seasonality
          // above, and only useful for a species not yet collected (a collected species
          // doesn't need to be told where to find it).
          hotspotRegionId
            ? pool.query(
                `SELECT centroid_lat, centroid_lon, point_count, bbox_diagonal_km, last_seen_year, distinct_years
                 FROM region_species_hotspots WHERE region_id = $1 AND species_id = $2
                 ORDER BY point_count DESC`,
                [hotspotRegionId, id],
              )
            : Promise.resolve(null),
          // Needed to tell "found everywhere" apart from "found in many spots that are all
          // themselves clustered in one part of the region" (e.g. a bird that only occurs
          // along a province's coastline) — cluster *count* alone can't distinguish these,
          // since a coastal species can easily produce just as many clusters as a truly
          // ubiquitous one. Only the region's own bbox lets us tell whether the clusters
          // collectively cover a small corner of the region or genuinely span all of it. Uses
          // hotspotRegionId, not regionId — the two can differ (see hotspotRegionId's own
          // comment), and a mismatched bbox would silently miscompute widespread-vs-clustered.
          hotspotRegionId
            ? pool.query(`SELECT boundary_geojson FROM regions WHERE id = $1`, [hotspotRegionId])
            : Promise.resolve(null),
        ]);
      const isArchived = archivedRes.rows.length > 0;
      const seasonality: number[] | null = regionSpeciesRes?.rows[0]?.seasonality ?? null;
      // Region-scoped rarity — ranked against other species actually on this region's own
      // checklist, alongside (not instead of) the fixed global tier.
      const localTier: string | null = regionSpeciesRes?.rows[0]?.local_tier ?? null;
      const isVagrant = regionSpeciesRes?.rows[0]?.is_vagrant === true;
      const isInvasive = regionSpeciesRes?.rows[0]?.is_invasive === true;
      const weeklyFrequency: number[] | null = regionSpeciesRes?.rows[0]?.weekly_frequency ?? null;
      const weeklyRegionName: string | null = regionNameRes?.rows[0]?.name ?? null;
      const hotspots = hotspotsRes?.rows ?? [];

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
        weeklyFrequency,
        weeklyRegionName,
        localTier,
        isVagrant,
        isInvasive,
        endemicCountryName: endemicLabel,
        isArchived,
        // Reused for the hotspot map — same row this handler already fetches for the
        // widespread/clustered span-ratio check below, no second query needed.
        regionBoundaryGeoJson: regionBboxRes?.rows[0]?.boundary_geojson ?? null,
        ...(() => {
          const totalPoints = hotspots.reduce((sum: number, h) => sum + h.point_count, 0);
          const topShare = hotspots.length > 0 ? hotspots[0].point_count / totalPoints : 0;
          // Cluster count/dominance alone can't tell "found everywhere" apart from "found in
          // many spots that are all themselves confined to one part of the region" (e.g. a
          // bird found only along a province's coastline can easily produce just as many
          // clusters as a truly ubiquitous one). So also check how much of the region's own
          // area the clusters actually span — a species is only "widespread" if its clusters
          // are both numerous/non-dominant AND spread across most of the region's own extent.
          let spanRatio = 1; // no region bbox available — assume it could span the whole thing
          const bbox = regionBboxRes?.rows[0]?.boundary_geojson?.bbox as
            | [number, number, number, number]
            | undefined;
          if (bbox && hotspots.length > 1) {
            const regionDiagonal = bboxDiagonalDegrees({ minLon: bbox[0], minLat: bbox[1], maxLon: bbox[2], maxLat: bbox[3] });
            const centroidBbox: BoundingBox = ringBoundingBox(
              hotspots.map((h): [number, number] => [h.centroid_lon, h.centroid_lat]),
            );
            const centroidSpread = bboxDiagonalDegrees(centroidBbox);
            spanRatio = regionDiagonal > 0 ? centroidSpread / regionDiagonal : 1;
          }
          const isWidespread = hotspots.length >= 6 && topShare < 0.25 && spanRatio >= 0.6;
          // A cluster seen in only one or two distinct years could just be coincidence (a
          // vagrant blown off course, a single lucky report); three or more separate years
          // hitting the same spot is a real repeated pattern worth calling out as a strong bet.
          // But that pattern is only useful if it's still current — NOT judged against today's
          // wall-clock date (a fixed cutoff like "within 10 years" is wrong at both ends: too
          // strict for a genuinely rarely-recorded species where 10-year-old data may be the
          // best available, too lenient for a well-recorded one where fresher data elsewhere in
          // the region makes an old cluster stale by comparison). Instead, compare each cluster
          // against the freshest record this species actually has anywhere in the region — a
          // cluster that's basically as current as the best data available stays reliable
          // regardless of the absolute year; one that's stale relative to fresher clusters
          // elsewhere isn't, even if it's "only" a few years behind.
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
              // A cluster this exact size is one compute-provinces-bulk.ts deliberately blurred
              // for an eBird-published sensitive species (see sensitive-species.ts) rather than a
              // real, precise locality — surfaced so the UI can say why the location is vague
              // instead of silently showing a suspiciously round, oddly generic-looking spot.
              isSensitive: h.bbox_diagonal_km === SENSITIVE_CLUSTER_DIAGONAL_KM,
              lastSeenYear: h.last_seen_year,
              distinctYears: h.distinct_years,
              recordShare: totalPoints > 0 ? h.point_count / totalPoints : 0,
              // isVagrant (region_species.is_vagrant) is exactly "fails the same recurrence
              // check used to decide this" at the whole-species level — a vagrant is a vagrant
              // precisely because it hasn't shown a real repeating pattern here. No hotspot
              // cluster stat should ever override that and call it a "good chance" location.
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

  // Target/wishlist marking (migration 090) — is_target is its own independent flag, not a
  // value of `state`, specifically so a species you've already collected/seen can still be
  // targeted (e.g. "I only have a bad photo of this, I want a better one"). No never-downgrade
  // dance needed here anymore: setting is_target never touches state, and vice versa.
  app.patch<{ Params: { id: string } }>("/species/:id/target", { preHandler: requireAuth }, async (request) => {
    const { id: speciesId } = request.params;
    const userId = request.user!.id;
    await pool.query(
      `INSERT INTO user_species (user_id, species_id, is_target) VALUES ($1, $2, true)
       ON CONFLICT (user_id, species_id) DO UPDATE SET is_target = true`,
      [userId, speciesId],
    );
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/species/:id/target", { preHandler: requireAuth }, async (request) => {
    const { id: speciesId } = request.params;
    const userId = request.user!.id;
    await pool.query(`UPDATE user_species SET is_target = false WHERE user_id = $1 AND species_id = $2`, [userId, speciesId]);
    // A row that's now neither a real state nor a target is pointless — clean it up so "no row"
    // still reliably means "unseen" everywhere else that invariant is relied on.
    await pool.query(`DELETE FROM user_species WHERE user_id = $1 AND species_id = $2 AND state IS NULL AND is_target = false`, [
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
  app.get<{ Params: { id: string } }>("/species/:id/reference-photos", { preHandler: requireScope("species.read") }, async (request, reply) => {
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
  app.get<{ Params: { id: string } }>("/species/:id/unmatched-raws", { preHandler: requireScope("species.read") }, async (request) => {
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

  // "183 photos / 7 encounters / 4 locations / 3 cameras / 2 lenses" — a photo count alone
  // can't tell a real 20-minute encounter with one bird from 400 photos apart from 7 genuinely
  // separate sightings; clusterIntoEncounters (see its own header comment) is what makes that
  // distinction. Locations/cameras/lenses are plain distinct-value counts over the same capture
  // set — no new query complexity, just numbers worth surfacing next to the encounter count.
  app.get<{ Params: { id: string } }>("/species/:id/encounters", { preHandler: requireScope("species.read") }, async (request) => {
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
    // A video capture is still one row here (see migration 230's own comment on why kind lives
    // on photos, not captures) — split out so the stat line can say "N photos, M videos" instead
    // of silently folding video counts into "photos".
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

  // Burst/sequence collapsing — 47 near-identical frames from one continuous burst read as
  // clutter, not 47 separate photos worth reviewing individually. Two signals decide whether
  // consecutive-in-time captures are "the same moment": a very high (>0.97) cosine similarity
  // between their already-computed CLIP embeddings (near-identical framing/subject/pose — the
  // same signal the Gallery search reuses, not a new one), AND a tight time gap (a real burst,
  // not two separate encounters that happen to look similar). Only sequences of 3+ frames are
  // returned — a pair of similar photos isn't the "collapse this" problem the 30fps-burst
  // complaint this addresses is actually about. Sharpness (see lib/sharpness.ts) breaks the tie
  // on which frame to show as the sequence's representative — a proxy for "which frame is least
  // blurry," not a full best-frame model (eye contact/pose aren't evaluated — see the product
  // scoping discussion on why that full version isn't feasible without new ML components).
  const SEQUENCE_SIMILARITY_THRESHOLD = 0.97;
  const SEQUENCE_MAX_GAP_MS = 120_000;
  app.get<{ Params: { id: string } }>("/species/:id/sequences", { preHandler: requireScope("species.read") }, async (request) => {
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
      const similar = prev?.embedding && row.embedding && cosineSimilarity(prev.embedding, row.embedding) > SEQUENCE_SIMILARITY_THRESHOLD;
      if (prevGroup && similar && gapMs <= SEQUENCE_MAX_GAP_MS) prevGroup.push(row);
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

  // Powers the import destination picker's "recommended drive" hint (see
  // ~/.claude/plans/multi-drive-storage.md) — which registered drives already hold photos of
  // this species, so a new upload can default to keeping them together rather than scattering
  // one species across drives by accident. A species can legitimately have photos split
  // across more than one drive (e.g. shot on different trips), so this returns every drive in
  // use, not just a single "the" answer — the frontend picks the top one as the default.
  app.get<{ Params: { id: string } }>("/species/:id/volume-usage", { preHandler: requireScope("species.read") }, async (request) => {
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
    app.get<{ Params: { id: string } }>(`/species/:id/reference-photo/${kind}`, { preHandler: requireScope("species.read") }, async (request, reply) => {
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
      { preHandler: requireScope("species.read") },
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

  // "Any taxa" search (Settings > Species & Import) — lets a user pull in a species Lifer has
  // no real dataset coverage for (insects, arachnids, plants, fungi, ...) straight from
  // iNaturalist by name, gated behind an opt-in setting since it's a live third-party lookup
  // with no local caching/rate-limit protection beyond the pace of one person typing.
  const INAT_TAXA_API = "https://api.inaturalist.org/v1/taxa";
  const OTHER_TAXA_USER_AGENT = "lifer-app/0.1 (personal project; any-taxa search)";
  // Every conservation_statuses entry — regardless of which authority assessed it (IUCN Red
  // List, a national Red List, NatureServe's G/S-ranks, Mexico's Norma Oficial 059, ...) or
  // which place it's scoped to — carries this same normalized numeric `iucn` field, iNat's own
  // internal equivalent-severity scale. Using IT (not each authority's own differently-shaped
  // code string, "LC" vs "S4" vs "G3" vs "Amenazada") is what makes one lookup table work for
  // every authority at once, and is also why a species with no global assessment can still fall
  // back to a REGIONAL one below and get a sensible label out of it.
  const IUCN_LEVEL_NAMES: Record<number, string> = {
    0: "Not Evaluated",
    5: "Data Deficient",
    10: "Least Concern",
    20: "Near Threatened",
    30: "Vulnerable",
    40: "Endangered",
    50: "Critically Endangered",
    60: "Extinct in the Wild",
    70: "Extinct",
  };

  async function requireAnyTaxaSearchEnabled(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const res = await pool.query<{ any_taxa_search_enabled: boolean }>(`SELECT any_taxa_search_enabled FROM users WHERE id = $1`, [
      request.user!.id,
    ]);
    if (!res.rows[0]?.any_taxa_search_enabled) {
      reply.code(403).send({ error: "Any-taxa search isn't enabled (Settings > Species & Import)" });
      return false;
    }
    return true;
  }

  app.get<{ Querystring: { q?: string } }>("/species/inat-search", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireAnyTaxaSearchEnabled(request, reply))) return;
    const q = (request.query.q ?? "").trim();
    if (q.length < 2) return { results: [] };
    const res = await fetch(`${INAT_TAXA_API}?q=${encodeURIComponent(q)}&rank=species&is_active=true&per_page=15`, {
      headers: { "User-Agent": OTHER_TAXA_USER_AGENT },
    });
    if (!res.ok) return reply.code(502).send({ error: "iNaturalist search failed" });
    const data = (await res.json()) as {
      results: Array<{
        id: number;
        name: string;
        preferred_common_name?: string;
        iconic_taxon_name?: string;
        default_photo?: { square_url?: string } | null;
      }>;
    };
    return {
      results: data.results.map((t) => ({
        inatTaxonId: t.id,
        scientificName: t.name,
        commonName: t.preferred_common_name ? titleCaseCommonName(t.preferred_common_name) : null,
        iconicTaxon: t.iconic_taxon_name ?? null,
        thumbnailUrl: t.default_photo?.square_url ?? null,
      })),
    };
  });

  // Shared by the single add-one-species route below and the bulk CSV/list import — resolves
  // an iNat taxon id to a species row (creating + enriching it on first use, reusing it on every
  // later call for the same taxon), but does NOT touch region_species; each caller decides that
  // for itself since the bulk path needs to know added-vs-already-present per entry.
  async function resolveOrCreateOtherTaxaSpecies(inatTaxonId: number): Promise<{ speciesId: string; scientificName: string }> {
    const existing = await pool.query<{ id: string; scientific_name: string }>(
      `SELECT id, scientific_name FROM species WHERE inat_taxon_id = $1 AND is_other_taxa = true`,
      [inatTaxonId],
    );
    if (existing.rows[0]) return { speciesId: existing.rows[0].id, scientificName: existing.rows[0].scientific_name };

    const taxonRes = await fetch(`${INAT_TAXA_API}/${inatTaxonId}`, { headers: { "User-Agent": OTHER_TAXA_USER_AGENT } });
    if (!taxonRes.ok) throw new Error("Couldn't look up that species on iNaturalist");
    const taxonData = (await taxonRes.json()) as {
      results: Array<{
        id: number;
        name: string;
        preferred_common_name?: string;
        iconic_taxon_name?: string;
        // `conservation_status` (singular) is iNat's PLACE-aware "status for wherever you're
        // browsing from" field — null whenever the request carries no place context, which is
        // always true here (a species-add lookup has no place in scope). The real data lives in
        // `conservation_statuses` (plural), one row per authority/place combination.
        conservation_statuses?: Array<{ status: string; authority: string; place: unknown | null; iucn: number | null }> | null;
      }>;
    };
    const taxon = taxonData.results[0];
    if (!taxon) throw new Error("Species not found on iNaturalist");
    // No rarity tier is ever computed for these (no dataset to rank against) — IUCN
    // conservation status fills that same badge slot on the detail page instead, when
    // iNaturalist has one on file. A genuinely GLOBAL assessment (place: null) is preferred
    // when one exists, IUCN Red List's own global entry first — but a true global entry turns
    // out to be the rare case, not the common one: most species (especially insects/fungi/
    // plants, exactly what Other Taxa is for) have ONLY regional assessments on file — a
    // Finnish Red List entry, a scatter of Canadian-province NatureServe S-ranks, Mexico's own
    // Norma Oficial 059, etc. Requiring place: null (the previous behavior) meant the vast
    // majority of species silently showed no IUCN status at all despite real conservation data
    // being right there — falling back to the single most-recently-updated regional entry
    // (any authority, any place) is a real status, just not a global one, and that's still far
    // more informative than showing nothing.
    const statuses = taxon.conservation_statuses ?? [];
    const globalStatuses = statuses.filter((s) => s.place == null);
    const best =
      globalStatuses.find((s) => s.authority === "IUCN Red List") ??
      globalStatuses[0] ??
      statuses.find((s) => s.authority === "IUCN Red List") ??
      statuses[0] ??
      null;
    const iucnStatus = best?.iucn != null ? (IUCN_LEVEL_NAMES[best.iucn] ?? best.status) : null;

    // A real GBIF key when one resolves (keeps this species usable anywhere the rest of the
    // catalog assumes a genuine GBIF identity), falling back to a synthetic negative key —
    // real GBIF keys are always positive, so this can never collide — for the genuinely
    // obscure taxa (a lot of insects) GBIF's backbone doesn't have a match for at all.
    let gbifKey = -taxon.id;
    // Family/order come along for free from this same match call — the only real, non-fabricated
    // "facts" available uniformly across every Other Taxa kingdom (no AVONET/EltonTraits-style
    // trait dataset was ever ingested for insects/fungi/plants/etc., unlike birds/mammals/fish),
    // so this is what fills the species detail page's stats box for them instead of leaving it
    // empty (see SpeciesDetailPage's own comment on that box).
    let family: string | null = null;
    let order: string | null = null;
    try {
      const gbifRes = await fetch(`https://api.gbif.org/v1/species/match?name=${encodeURIComponent(taxon.name)}&strict=false`);
      const gbifData = (await gbifRes.json()) as { usageKey?: number; family?: string; order?: string };
      if (gbifData.usageKey) gbifKey = gbifData.usageKey;
      family = gbifData.family ?? null;
      order = gbifData.order ?? null;
    } catch {
      // best-effort — the synthetic negative key above is a perfectly fine fallback, and a
      // missing family/order just means those two Stat rows fall back to "—" on the page.
    }

    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO species (gbif_key, scientific_name, common_name, taxon_class, is_other_taxa, inat_taxon_id, inat_iconic_taxon, iucn_status, family, taxon_order)
       VALUES ($1, $2, $3, $4, true, $5, $6, $7, $8, $9)
       ON CONFLICT (gbif_key) DO UPDATE SET gbif_key = species.gbif_key
       RETURNING id`,
      [
        gbifKey,
        taxon.name,
        taxon.preferred_common_name ? titleCaseCommonName(taxon.preferred_common_name) : null,
        (taxon.iconic_taxon_name ?? "other").toLowerCase(),
        taxon.id,
        taxon.iconic_taxon_name ?? null,
        iucnStatus,
        family,
        order,
      ],
    );
    const speciesId = inserted.rows[0].id;

    // Reuses the exact same iNaturalist-sourced photo/description pipeline every other
    // species on the site goes through on first view (see lazyEnrich.ts's own comment on
    // why this stays iNaturalist-only, no direct Wikipedia call) — an other-taxa species
    // looks and reads identically to any other species detail page, just without rarity/
    // occurrence data, which was never computed for it in the first place. persistEnrichment
    // also best-effort computes this species' reference embedding right away (see lazyEnrich.ts),
    // so it's ready for AI import-matching immediately, not just after the next batch backfill.
    const enrichment = await enrichSpecies({ id: speciesId, scientific_name: taxon.name });
    await persistEnrichment(speciesId, enrichment);
    if (enrichment.gallery.length > 0) {
      await persistGalleryPromotingMainIfMissing(speciesId, enrichment.gallery, enrichment.referencePhoto != null);
    }
    return { speciesId, scientificName: taxon.name };
  }

  app.post<{ Body: { inatTaxonId?: number; regionId?: string } }>(
    "/species/other-taxa",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!(await requireAnyTaxaSearchEnabled(request, reply))) return;
      const { inatTaxonId, regionId } = request.body ?? {};
      if (!inatTaxonId || !regionId) return reply.code(400).send({ error: "inatTaxonId and regionId are required" });

      const regionRes = await pool.query(`SELECT id FROM regions WHERE id = $1`, [regionId]);
      if (regionRes.rows.length === 0) return reply.code(404).send({ error: "Region not found" });

      let speciesId: string;
      try {
        ({ speciesId } = await resolveOrCreateOtherTaxaSpecies(inatTaxonId));
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }

      // No rarity/occurrence pipeline for these — local_frequency/local_tier/weekly_frequency
      // all stay NULL, matching the migration's own reasoning (never computed, never meant to
      // be at this taxon's real-world species count).
      await pool.query(
        `INSERT INTO region_species (region_id, species_id, is_vagrant, is_invasive)
         VALUES ($1, $2, false, false)
         ON CONFLICT (region_id, species_id) DO NOTHING`,
        [regionId, speciesId],
      );

      return { speciesId };
    },
  );

  // Undoes an Other Taxa add — species added via the any-taxa search have no pack/reseed
  // story to fall back on, so without this a mis-clicked search result (or one added just to
  // try the feature) sits in the checklist forever with no way back. Refuses when the user has
  // actual photos of it (deleting the species row out from under a real capture would orphan
  // it) rather than silently discarding those — the user has to deal with those photos first
  // (reassign or delete them), same as any other "this would destroy real data" guard.
  app.delete<{ Params: { id: string } }>("/species/:id/other-taxa", { preHandler: requireAuth }, async (request, reply) => {
    const { id: speciesId } = request.params;
    const userId = request.user!.id;

    const speciesRes = await pool.query<{ is_other_taxa: boolean }>(`SELECT is_other_taxa FROM species WHERE id = $1`, [speciesId]);
    if (speciesRes.rows.length === 0) return reply.code(404).send({ error: "Species not found" });
    if (!speciesRes.rows[0].is_other_taxa) {
      return reply.code(400).send({ error: "Only an Other Taxa species can be removed this way" });
    }

    const captureCountRes = await pool.query<{ count: string }>(
      `SELECT count(*) FROM captures_all c
       WHERE c.user_id = $1 AND (c.species_id = $2 OR EXISTS (SELECT 1 FROM capture_species cs WHERE cs.capture_id = c.id AND cs.species_id = $2))`,
      [userId, speciesId],
    );
    if (Number(captureCountRes.rows[0].count) > 0) {
      return reply
        .code(409)
        .send({ error: "You have photos of this species — delete or reassign them first, then remove it." });
    }

    await pool.query(`DELETE FROM user_species WHERE user_id = $1 AND species_id = $2`, [userId, speciesId]);
    await pool.query(`DELETE FROM user_archived_species WHERE user_id = $1 AND species_id = $2`, [userId, speciesId]);
    // Shared checklist data (see region_species's own schema comment — not per-user), same as
    // every other region_species row — removing it here means EVERY user on this install stops
    // seeing it too, which is exactly right for the single-user desktop case this feature is
    // built for, and an acceptable, rare edge case on a shared server (whoever re-needs it can
    // just re-add it via the same search).
    await pool.query(`DELETE FROM region_species WHERE species_id = $1`, [speciesId]);

    // Only actually removes the catalog row once nothing else anywhere still points at it
    // (another user's own user_species/captures on a shared server, most likely) — the
    // species/user_species/captures FKs have no cascade specified for exactly this reason, so a
    // real reference makes this a no-op error, not a silent partial deletion.
    try {
      await pool.query(`DELETE FROM species WHERE id = $1`, [speciesId]);
    } catch (err) {
      request.log.warn({ err, speciesId }, "Other Taxa species still referenced elsewhere — checklist entry removed, catalog row kept");
    }

    return { ok: true };
  });

  // Bulk personal-checklist import: paste/upload a plain list (one entry per line — scientific
  // names, common names, or raw iNat taxon ids all work, e.g. from an iNat life list/observation
  // export) and every resolvable one gets added to a region's Other Taxa bucket in one go,
  // instead of one-by-one through the search modal. Runs as a background job (same shape as
  // offline-packs' own download job below) rather than blocking the request open for however
  // long a few hundred iNaturalist lookups take.
  interface OtherTaxaBulkJobState {
    running: boolean;
    processed: number;
    total: number;
    added: number;
    alreadyPresent: number;
    notFound: string[];
    error: string | null;
    finishedAt: number | null;
  }
  const otherTaxaBulkJob: OtherTaxaBulkJobState = {
    running: false,
    processed: 0,
    total: 0,
    added: 0,
    alreadyPresent: 0,
    notFound: [],
    error: null,
    finishedAt: null,
  };

  app.get("/species/other-taxa/bulk/status", { preHandler: requireAuth }, async () => otherTaxaBulkJob);

  app.post<{ Body: { regionId?: string; entries?: string[] } }>(
    "/species/other-taxa/bulk",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!(await requireAnyTaxaSearchEnabled(request, reply))) return;
      if (otherTaxaBulkJob.running) return reply.code(409).send({ error: "A bulk import is already running" });
      const { regionId, entries } = request.body ?? {};
      if (!regionId || !Array.isArray(entries) || entries.length === 0) {
        return reply.code(400).send({ error: "regionId and a non-empty entries list are required" });
      }
      const regionRes = await pool.query(`SELECT id FROM regions WHERE id = $1`, [regionId]);
      if (regionRes.rows.length === 0) return reply.code(404).send({ error: "Region not found" });

      // Dedupe + drop blanks (a pasted CSV column or a file with trailing newlines is the
      // common case) before committing to a total count the status endpoint will report.
      const lines = [...new Set(entries.map((e) => e.trim()).filter((e) => e.length > 0))];
      if (lines.length === 0) return reply.code(400).send({ error: "No usable entries found" });

      otherTaxaBulkJob.running = true;
      otherTaxaBulkJob.processed = 0;
      otherTaxaBulkJob.total = lines.length;
      otherTaxaBulkJob.added = 0;
      otherTaxaBulkJob.alreadyPresent = 0;
      otherTaxaBulkJob.notFound = [];
      otherTaxaBulkJob.error = null;
      otherTaxaBulkJob.finishedAt = null;

      // Deliberately not awaited — the route returns immediately, the frontend polls
      // /species/other-taxa/bulk/status the same way it already polls offline-pack downloads.
      (async () => {
        for (const line of lines) {
          try {
            let taxonId: number | null = null;
            if (/^\d+$/.test(line)) {
              taxonId = Number(line);
            } else {
              const searchRes = await fetch(`${INAT_TAXA_API}?q=${encodeURIComponent(line)}&rank=species&is_active=true&per_page=1`, {
                headers: { "User-Agent": OTHER_TAXA_USER_AGENT },
              });
              if (searchRes.ok) {
                const searchData = (await searchRes.json()) as { results: Array<{ id: number }> };
                taxonId = searchData.results[0]?.id ?? null;
              }
            }
            if (taxonId == null) {
              otherTaxaBulkJob.notFound.push(line);
            } else {
              const { speciesId } = await resolveOrCreateOtherTaxaSpecies(taxonId);
              const insertRes = await pool.query(
                `INSERT INTO region_species (region_id, species_id, is_vagrant, is_invasive)
                 VALUES ($1, $2, false, false)
                 ON CONFLICT (region_id, species_id) DO NOTHING`,
                [regionId, speciesId],
              );
              if (insertRes.rowCount && insertRes.rowCount > 0) otherTaxaBulkJob.added++;
              else otherTaxaBulkJob.alreadyPresent++;
            }
          } catch {
            otherTaxaBulkJob.notFound.push(line);
          }
          otherTaxaBulkJob.processed++;
          // A small, deliberate pace between entries — this hits iNaturalist's own APIs several
          // times per line (search/lookup, GBIF match, enrichment's photo+description fetch for
          // any genuinely new species), and a list of a few hundred names run back-to-back with
          // no pacing is exactly the kind of burst that drew real 429s from api.inaturalist.org
          // elsewhere in this codebase (see lazyEnrich.ts's own fetchWithRetry comment).
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        otherTaxaBulkJob.running = false;
        otherTaxaBulkJob.finishedAt = Date.now();
      })().catch((err) => {
        otherTaxaBulkJob.error = (err as Error).message;
        otherTaxaBulkJob.running = false;
        otherTaxaBulkJob.finishedAt = Date.now();
      });

      return { started: true, total: lines.length };
    },
  );
}
