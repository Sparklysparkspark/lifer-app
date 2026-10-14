// Stores enrichment results: the species row, the gallery, and the reference vectors suggestions
// rank by. The one write path for on-view enrichment, the pack and photo-store paths and the
// pipeline's bulk enrichment.
import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pool } from "../db.js";
import { log } from "../lib/log.js";
import { EMBEDDING_MODEL_VERSION, ID_MODEL_VERSION } from "../config.js";
import { isModelDownloaded } from "./clipModel.js";
import { computeEmbedding } from "./vectorCache.js";
import { refreshSpeciesVectors } from "./suggest.js";
import { idModel } from "./idModel.js";
import { descriptionFromINaturalistSummary, INATURALIST_DESCRIPTION_CREDIT, normalizeWikipediaUrl } from "./enrich.js";
import type { EnrichmentResult } from "./enrich.js";
import { fetchTaxonRecord } from "./inatClient.js";

/** The one write path for both the on-view enrichment and the bulk enrich-all-species script. */
export async function persistEnrichment(speciesId: string, enrichment: EnrichmentResult): Promise<void> {
  // A blocklisted main photo (a range map, say; migration 106) counts as no photo at all.
  if (enrichment.referencePhoto) {
    const blocked = await pool.query(`SELECT 1 FROM reference_photo_blocklist WHERE photo_url = $1`, [
      enrichment.referencePhoto,
    ]);
    if (blocked.rowCount) {
      for (const p of [enrichment.referenceDisplayPath, enrichment.referenceThumbPath])
        if (p) rmSync(p, { force: true });
      enrichment = {
        ...enrichment,
        referencePhoto: null,
        referenceCredit: null,
        referenceLicense: null,
        referenceDisplayPath: null,
        referenceThumbPath: null,
      };
    }
  }
  await pool.query(
    `UPDATE species SET
       reference_photo = COALESCE(reference_photo, $1),
       reference_credit = COALESCE(reference_credit, $2),
       reference_license = COALESCE(reference_license, $3),
       reference_display_path = COALESCE(reference_display_path, $4),
       reference_thumb_path = COALESCE(reference_thumb_path, $5),
       description = COALESCE(description, $6),
       description_credit = COALESCE(description_credit, $7),
       description_source_url = COALESCE(description_source_url, $8),
       habitat_description = COALESCE(habitat_description, $9),
       -- A species that already has a photo isn't missing one, whatever iNaturalist's licenses.
       photo_withheld = CASE WHEN $11::boolean IS NULL THEN photo_withheld
                             ELSE $11::boolean AND reference_photo IS NULL END,
       -- enriched_at says a photo lookup ran; text has its own stamp, set only when a text
       -- source was actually read (EnrichmentResult.descriptionChecked).
       description_checked_at = CASE WHEN $12::boolean THEN now() ELSE description_checked_at END,
       enriched_at = now()
     WHERE id = $10`,
    [
      enrichment.referencePhoto,
      enrichment.referenceCredit,
      enrichment.referenceLicense,
      enrichment.referenceDisplayPath,
      enrichment.referenceThumbPath,
      enrichment.description,
      enrichment.descriptionCredit,
      enrichment.descriptionSourceUrl,
      enrichment.habitatDescription,
      speciesId,
      enrichment.photoWithheld ?? null,
      enrichment.descriptionChecked ?? false,
    ],
  );
  await persistGallery(speciesId, enrichment.gallery);
  await tryComputeReferenceEmbeddings(speciesId);
}

/** Text only, for a species some photo-only path marked enriched (an offline pack's photos, the
 *  photo store) without ever reading a text source. Reads iNaturalist's taxon record by id and
 *  stores its summary under the shared rule; stamps description_checked_at only when the record
 *  was read. Returns the stored description, or null. Never overwrites an existing one. */
export async function fillDescriptionIfUnchecked(
  speciesId: string,
  inatTaxonId: number,
): Promise<{ description: string; descriptionCredit: string; descriptionSourceUrl: string } | null> {
  const taxon = await fetchTaxonRecord(inatTaxonId);
  if (!taxon) return null;
  const description = descriptionFromINaturalistSummary(taxon.wikipedia_summary, taxon.wikipedia_url);
  const sourceUrl = description ? normalizeWikipediaUrl(taxon.wikipedia_url!) : null;
  await pool.query(
    `UPDATE species SET
       description = COALESCE(description, $2),
       description_credit = CASE WHEN description IS NULL AND $2::text IS NOT NULL THEN $3 ELSE description_credit END,
       description_source_url = CASE WHEN description IS NULL AND $2::text IS NOT NULL THEN $4 ELSE description_source_url END,
       description_checked_at = now()
     WHERE id = $1`,
    [speciesId, description, description ? INATURALIST_DESCRIPTION_CREDIT : null, sourceUrl],
  );
  return description && sourceUrl
    ? { description, descriptionCredit: INATURALIST_DESCRIPTION_CREDIT, descriptionSourceUrl: sourceUrl }
    : null;
}

/** Stores a main photo for a species that still has none, with its credit and license, then its
 *  reference vectors. For the background fetch of photos packs can't include
 *  (apps/api/src/species/withheldPhotos.ts). False when it wasn't stored: the photo is
 *  blocklisted (migration 106) or the species got a photo meanwhile. */
export async function persistMainPhotoIfMissing(
  speciesId: string,
  photo: { photoUrl: string; credit: string; license: string; displayPath: string | null; thumbPath: string | null },
): Promise<boolean> {
  const blocked = await pool.query(`SELECT 1 FROM reference_photo_blocklist WHERE photo_url = $1`, [photo.photoUrl]);
  if (blocked.rowCount) {
    for (const p of [photo.displayPath, photo.thumbPath]) if (p) rmSync(p, { force: true });
    return false;
  }
  const res = await pool.query(
    `UPDATE species SET reference_photo = $2, reference_credit = $3, reference_license = $4,
       reference_display_path = $5, reference_thumb_path = $6
     WHERE id = $1 AND reference_photo IS NULL`,
    [speciesId, photo.photoUrl, photo.credit, photo.license, photo.displayPath, photo.thumbPath],
  );
  if (!res.rowCount) return false;
  await tryComputeReferenceEmbeddings(speciesId);
  return true;
}

export interface VectorStoreTarget {
  /** Names the vector in logs, e.g. "clip reference". */
  label: string;
  isModelDownloaded: () => boolean;
  embed: (image: Buffer) => Promise<unknown>;
  /** The image to embed, or null when there's nothing to do (no image, or the vector exists). */
  pendingImage: () => Promise<string | null>;
  store: (embedding: unknown) => Promise<unknown>;
}

/** Computes and stores one vector, best effort: the embedding backfill catches anything missed.
 *  A model that isn't downloaded is skipped quietly; anything else (an unreadable image, a model
 *  or database error) is logged. True when a vector was stored. */
export async function tryStoreVector(
  target: VectorStoreTarget,
  context: Record<string, unknown> = {},
): Promise<boolean> {
  if (!target.isModelDownloaded()) return false;
  try {
    const imagePath = await target.pendingImage();
    if (!imagePath) return false;
    await target.store(await target.embed(await readFile(imagePath)));
    return true;
  } catch (err) {
    log.warn({ err, ...context, vector: target.label }, "Couldn't store a reference vector; the backfill will retry");
    return false;
  }
}

// Suggestions rank with whichever model is active, so a vector is computed for each one that's
// downloaded: the general CLIP model and the species identification model.
const VECTOR_MODELS = [
  {
    name: "clip",
    isDownloaded: isModelDownloaded,
    embed: (image: Buffer) => computeEmbedding(image),
    version: EMBEDDING_MODEL_VERSION,
    referenceTable: "species_reference_embeddings",
    galleryTable: "species_reference_gallery_embeddings",
  },
  {
    name: "id",
    isDownloaded: () => idModel.isDownloaded(),
    embed: (image: Buffer) => idModel.embed(image),
    version: ID_MODEL_VERSION,
    referenceTable: "id_model_reference_embeddings",
    galleryTable: "id_model_gallery_embeddings",
  },
] as const;

// Suggestions only rank species with a reference vector, so one is computed right after
// enrichment.
async function tryComputeReferenceEmbeddings(speciesId: string): Promise<void> {
  let stored = false;
  for (const model of VECTOR_MODELS) {
    const target: VectorStoreTarget = {
      label: `${model.name} reference`,
      isModelDownloaded: model.isDownloaded,
      embed: model.embed,
      pendingImage: async () => {
        const res = await pool.query<{ reference_display_path: string | null }>(
          `SELECT reference_display_path FROM species
           WHERE id = $1 AND NOT EXISTS (
             SELECT 1 FROM ${model.referenceTable} e WHERE e.species_id = species.id AND e.model_version = $2
           )`,
          [speciesId, model.version],
        );
        return res.rows[0]?.reference_display_path ?? null;
      },
      store: (embedding) =>
        pool.query(
          `INSERT INTO ${model.referenceTable} (species_id, embedding, model_version)
           VALUES ($1, $2, $3)
           ON CONFLICT (species_id) DO UPDATE SET embedding = EXCLUDED.embedding, model_version = EXCLUDED.model_version, computed_at = now()`,
          [speciesId, embedding, model.version],
        ),
    };
    if (await tryStoreVector(target, { speciesId })) stored = true;
  }
  if (stored) await refreshSpeciesVectorsQuietly(speciesId);
}

// The same for one gallery photo. True when a vector was stored.
async function tryComputeGalleryEmbeddings(
  referencePhotoId: string,
  speciesId: string,
  displayPath: string | null,
): Promise<boolean> {
  if (!displayPath) return false;
  let stored = false;
  for (const model of VECTOR_MODELS) {
    const target: VectorStoreTarget = {
      label: `${model.name} gallery`,
      isModelDownloaded: model.isDownloaded,
      embed: model.embed,
      pendingImage: async () => {
        const existing = await pool.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM ${model.galleryTable} WHERE reference_photo_id = $1 AND model_version = $2
           ) AS exists`,
          [referencePhotoId, model.version],
        );
        return existing.rows[0].exists ? null : displayPath;
      },
      store: (embedding) =>
        pool.query(
          `INSERT INTO ${model.galleryTable} (reference_photo_id, species_id, embedding, model_version)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (reference_photo_id) DO UPDATE SET embedding = EXCLUDED.embedding, model_version = EXCLUDED.model_version, computed_at = now()`,
          [referencePhotoId, speciesId, embedding, model.version],
        ),
    };
    if (await tryStoreVector(target, { speciesId, referencePhotoId })) stored = true;
  }
  return stored;
}

// Loaded suggestion candidates pick up the new vectors now rather than on the next rebuild.
async function refreshSpeciesVectorsQuietly(speciesId: string): Promise<void> {
  await refreshSpeciesVectors(pool, [speciesId]).catch((err) =>
    log.warn({ err, speciesId }, "Couldn't refresh this species' loaded vectors"),
  );
}

export async function persistGallery(speciesId: string, gallery: EnrichmentResult["gallery"]): Promise<void> {
  const blocked = await pool.query<{ photo_url: string }>(
    `SELECT photo_url FROM reference_photo_blocklist WHERE photo_url = ANY($1)`,
    [gallery.map((p) => p.photoUrl)],
  );
  const blockedUrls = new Set(blocked.rows.map((r) => r.photo_url));
  let stored = false;
  for (const photo of gallery) {
    if (blockedUrls.has(photo.photoUrl)) continue; // a map or other non-photo (migration 106)
    const res = await pool.query<{ id: string }>(
      `INSERT INTO species_reference_photos (species_id, photo_url, credit, license, sort_order, display_path, thumb_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (species_id, photo_url) DO UPDATE SET
         display_path = EXCLUDED.display_path, thumb_path = EXCLUDED.thumb_path
       RETURNING id`,
      [speciesId, photo.photoUrl, photo.credit, photo.license, photo.sortOrder, photo.displayPath, photo.thumbPath],
    );
    if (await tryComputeGalleryEmbeddings(res.rows[0].id, speciesId, photo.displayPath)) stored = true;
  }
  if (stored) await refreshSpeciesVectorsQuietly(speciesId);
}

// For the gallery backfills (the species page and backfill-missing-galleries.ts): a species with
// no main photo gets the first gallery photo as its main one, as enrichSpecies does.
export async function persistGalleryPromotingMainIfMissing(
  speciesId: string,
  gallery: EnrichmentResult["gallery"],
  hasMainPhoto: boolean,
): Promise<void> {
  if (hasMainPhoto || gallery.length === 0) {
    await persistGallery(speciesId, gallery);
    return;
  }
  const [first, ...rest] = gallery;
  await pool.query(
    `UPDATE species SET reference_photo = $1, reference_credit = $2, reference_license = $3,
       reference_display_path = $4, reference_thumb_path = $5 WHERE id = $6`,
    [first.photoUrl, first.credit, first.license, first.displayPath, first.thumbPath, speciesId],
  );
  await persistGallery(speciesId, rest);
  await tryComputeReferenceEmbeddings(speciesId);
}
