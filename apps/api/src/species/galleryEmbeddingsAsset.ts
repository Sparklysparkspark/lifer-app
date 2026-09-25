// Installs the per-gallery-photo CLIP vectors (species_reference_gallery_embeddings) from their
// own compact asset, published next to the catalog seed (format:
// packages/shared/src/galleryEmbeddingsFormat.ts). They used to be inside the seed as pg_dump
// text, which made it 1.2GB. They're only usable once the CLIP model is downloaded, so they're
// fetched then, refreshed with each catalog update, and checked again at startup.
//
// Also orchestrates the two other per-species vector assets (species_reference_embeddings,
// species_text_embeddings), which turned out to be just as large as the gallery table once
// dumped as text for 130k+ species (see speciesVectorAsset.ts) — all three are fetched together
// since they all become usable the moment the model finishes downloading.
//
// Three triggers (model download finishing, startup, the Settings catalog update) all funnel
// through runGalleryEmbeddingsUpdate, which is serialized by a lock so two can never overlap.
import { createReadStream, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { Pool } from "pg";
import { decodeGalleryEmbeddings, type GalleryEmbeddingsHeader } from "@lifer/shared/src/galleryEmbeddingsFormat.js";
import { APP_DATA_DIR, EMBEDDING_MODEL_VERSION, ID_MODEL_VERSION } from "../config.js";
import { getInstallSetting, setInstallSetting } from "../lib/installSettings.js";
import { createJob, describeError, type JobContext } from "../lib/job.js";
import { copyInto, copyTextField } from "../lib/pgCopy.js";
import { downloadResumable } from "../lib/resumableDownload.js";
import { fetchCatalogManifest, resolveCatalogAssetUrl, type CatalogManifest, type VectorAsset } from "./catalogManifest.js";
import { isModelDownloaded, resetIdModelReadiness } from "./embeddings.js";
import { idModel } from "./idModel.js";
import { fetchAndApplySpeciesVectorAsset, type VectorAssetResult } from "./speciesVectorAsset.js";
import { TEXT_MODEL_VERSION } from "./textEmbedding.js";

const DOWNLOAD_DIR = path.join(APP_DATA_DIR, "catalog-downloads");
// Which table a per-gallery-photo asset installs into, and where its applied version is kept.
interface GalleryTarget {
  table: "species_reference_gallery_embeddings" | "id_model_gallery_embeddings";
  modelVersion: string;
  // Stores `${manifest.version}:${modelVersion}` of the last applied asset.
  appliedKey: string;
  phase: string;
  applyPhase: string;
}

const CLIP_GALLERY: GalleryTarget = {
  table: "species_reference_gallery_embeddings",
  modelVersion: EMBEDDING_MODEL_VERSION,
  appliedKey: "gallery_embeddings_version",
  phase: "downloading_gallery_embeddings",
  applyPhase: "applying_gallery_embeddings",
};

export const ID_GALLERY: GalleryTarget = {
  table: "id_model_gallery_embeddings",
  modelVersion: ID_MODEL_VERSION,
  appliedKey: "id_gallery_embeddings_version",
  phase: "downloading_id_gallery_embeddings",
  applyPhase: "applying_id_gallery_embeddings",
};

export type GalleryEmbeddingsResult =
  | { status: "applied"; rows: number; matched: number }
  | { status: "up_to_date" }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; error: string };

// The combined result of all three vector assets (gallery + per-species image + per-species
// text) — every caller of runGalleryEmbeddingsUpdate gets this now, not just the gallery half.
export interface ReferenceVectorsResult {
  gallery: GalleryEmbeddingsResult;
  speciesImage: VectorAssetResult;
  speciesText: VectorAssetResult;
  // The same three for the species identification model, when it's downloaded.
  idModel?: { gallery: GalleryEmbeddingsResult; speciesImage: VectorAssetResult; speciesText: VectorAssetResult };
}

type Ctx = Pick<JobContext<unknown>, "signal" | "update" | "throwIfCancelled">;

let lock: Promise<unknown> = Promise.resolve();

/** Downloads and applies the gallery embeddings asset if this install doesn't have the current
 * one. Safe to call from several places; calls run one at a time. */
export function runGalleryEmbeddingsUpdate(
  pool: Pool,
  ctx: Ctx,
  opts: { manifest?: CatalogManifest; force?: boolean } = {},
): Promise<ReferenceVectorsResult> {
  const run = lock.then(() => doUpdate(pool, ctx, opts));
  lock = run.catch(() => {});
  return run;
}

function toFailed(err: unknown): VectorAssetResult {
  return { status: "failed", error: describeError(err) };
}

async function doUpdate(
  pool: Pool,
  ctx: Ctx,
  opts: { manifest?: CatalogManifest; force?: boolean },
): Promise<ReferenceVectorsResult> {
  if (!isModelDownloaded()) {
    const unavailable: VectorAssetResult = { status: "unavailable", reason: "The species-matching model isn't downloaded" };
    return { gallery: unavailable, speciesImage: unavailable, speciesText: unavailable };
  }
  const manifest = opts.manifest ?? (await fetchCatalogManifest(ctx.signal));
  const force = opts.force ?? false;

  let gallery: GalleryEmbeddingsResult;
  try {
    gallery = await doGalleryUpdate(pool, ctx, manifest, manifest.galleryEmbeddings, CLIP_GALLERY, force);
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    gallery = toFailed(err);
  }
  ctx.throwIfCancelled();

  let speciesImage: VectorAssetResult;
  try {
    speciesImage = await fetchAndApplySpeciesVectorAsset(
      pool,
      ctx,
      {
        table: "species_reference_embeddings",
        currentModelVersion: EMBEDDING_MODEL_VERSION,
        appliedKey: "species_image_embeddings_version",
        label: "species reference vectors",
        phase: "downloading_species_image_embeddings",
        applyPhase: "applying_species_image_embeddings",
      },
      manifest,
      manifest.speciesImageEmbeddings,
      force,
    );
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    speciesImage = toFailed(err);
  }
  ctx.throwIfCancelled();

  let speciesText: VectorAssetResult;
  try {
    speciesText = await fetchAndApplySpeciesVectorAsset(
      pool,
      ctx,
      {
        table: "species_text_embeddings",
        currentModelVersion: TEXT_MODEL_VERSION,
        appliedKey: "species_text_embeddings_version",
        label: "species zero-shot text vectors",
        phase: "downloading_species_text_embeddings",
        applyPhase: "applying_species_text_embeddings",
      },
      manifest,
      manifest.speciesTextEmbeddings,
      force,
    );
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    speciesText = toFailed(err);
  }

  const result: ReferenceVectorsResult = { gallery, speciesImage, speciesText };
  if (idModel.isDownloaded()) {
    ctx.throwIfCancelled();
    result.idModel = await doIdModelUpdate(pool, ctx, manifest, force);
    resetIdModelReadiness();
  }
  return result;
}

// Same three assets for the species identification model. Each is independent: a failed gallery
// asset still leaves the text vectors (which alone scored nearly as well) usable.
async function doIdModelUpdate(
  pool: Pool,
  ctx: Ctx,
  manifest: CatalogManifest,
  force: boolean,
): Promise<NonNullable<ReferenceVectorsResult["idModel"]>> {
  async function attempt<T>(fn: () => Promise<T>): Promise<T | VectorAssetResult> {
    try {
      return await fn();
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      return toFailed(err);
    }
  }
  const speciesText = await attempt(() =>
    fetchAndApplySpeciesVectorAsset(
      pool,
      ctx,
      {
        table: "id_model_text_embeddings",
        currentModelVersion: ID_MODEL_VERSION,
        appliedKey: "id_species_text_embeddings_version",
        label: "species identification text vectors",
        phase: "downloading_id_species_text_embeddings",
        applyPhase: "applying_id_species_text_embeddings",
      },
      manifest,
      manifest.idSpeciesTextEmbeddings,
      force,
    ),
  );
  ctx.throwIfCancelled();
  const speciesImage = await attempt(() =>
    fetchAndApplySpeciesVectorAsset(
      pool,
      ctx,
      {
        table: "id_model_reference_embeddings",
        currentModelVersion: ID_MODEL_VERSION,
        appliedKey: "id_species_image_embeddings_version",
        label: "species identification reference vectors",
        phase: "downloading_id_species_image_embeddings",
        applyPhase: "applying_id_species_image_embeddings",
      },
      manifest,
      manifest.idSpeciesImageEmbeddings,
      force,
    ),
  );
  ctx.throwIfCancelled();
  const gallery = await attempt(() => doGalleryUpdate(pool, ctx, manifest, manifest.idGalleryEmbeddings, ID_GALLERY, force));
  return { gallery, speciesImage, speciesText };
}

async function doGalleryUpdate(
  pool: Pool,
  ctx: Ctx,
  manifest: CatalogManifest,
  asset: VectorAsset | null | undefined,
  target: GalleryTarget,
  force: boolean,
): Promise<GalleryEmbeddingsResult> {
  if (!asset) return { status: "unavailable", reason: "This catalog has no separate gallery embeddings" };
  if (asset.modelVersion !== target.modelVersion) {
    return {
      status: "unavailable",
      reason: `Published vectors are for model ${asset.modelVersion}, this install uses ${target.modelVersion}`,
    };
  }
  const appliedTag = `${manifest.version}:${asset.modelVersion}`;
  if (!force && (await getInstallSetting<string>(pool, target.appliedKey)) === appliedTag) return { status: "up_to_date" };

  mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const dest = path.join(DOWNLOAD_DIR, path.basename(new URL(resolveCatalogAssetUrl(asset.url)).pathname));
  ctx.update({
    phase: target.phase,
    downloadedBytes: 0,
    totalBytes: asset.bytes,
    processed: null,
    total: null,
  });
  await downloadResumable(resolveCatalogAssetUrl(asset.url), dest, {
    signal: ctx.signal,
    expectedSha256: asset.sha256,
    label: "the species reference vectors",
    onProgress: (downloadedBytes, totalBytes) => ctx.update({ downloadedBytes, totalBytes }),
  });
  ctx.throwIfCancelled();

  const result = await applyGalleryEmbeddingsFile(pool, dest, appliedTag, ctx, target);
  rmSync(dest, { force: true });
  return result;
}

/** Loads the file into a temp table with COPY, then maps each row onto this install's own
 * species_reference_photos id via (species_id, photo_url), all in one transaction. Rows whose
 * photo this install doesn't have are skipped. */
export async function applyGalleryEmbeddingsFile(
  pool: Pool,
  filePath: string,
  appliedTag: string | null,
  ctx: Ctx,
  target: GalleryTarget = CLIP_GALLERY,
): Promise<GalleryEmbeddingsResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `CREATE TEMP TABLE tmp_gallery_embeddings (species_id uuid, photo_url text, embedding real[]) ON COMMIT DROP`,
    );

    let header: GalleryEmbeddingsHeader | null = null;
    let rows = 0;
    ctx.update({ phase: target.applyPhase, downloadedBytes: null, totalBytes: null, processed: 0, total: null });

    const gunzip = createGunzip();
    pipeline(createReadStream(filePath), gunzip).catch((err) => gunzip.destroy(err));
    async function* copyRows(): AsyncGenerator<string> {
      for await (const r of decodeGalleryEmbeddings(gunzip, (h) => {
        header = h;
        ctx.update({ total: h.rowCount });
      })) {
        if (++rows % 5000 === 0) {
          ctx.throwIfCancelled();
          ctx.update({ processed: rows });
        }
        yield `${r.speciesId}\t${copyTextField(r.photoUrl)}\t{${r.embedding.join(",")}}\n`;
      }
    }
    try {
      await copyInto(client, `COPY tmp_gallery_embeddings (species_id, photo_url, embedding) FROM STDIN`, copyRows());
    } finally {
      gunzip.destroy();
    }
    const modelVersion = (header as GalleryEmbeddingsHeader | null)?.modelVersion ?? target.modelVersion;

    ctx.throwIfCancelled();
    const res = await client.query(
      `INSERT INTO ${target.table} (reference_photo_id, species_id, embedding, model_version)
       SELECT p.id, p.species_id, t.embedding, $1
         FROM tmp_gallery_embeddings t
         JOIN species_reference_photos p ON p.species_id = t.species_id AND p.photo_url = t.photo_url
       ON CONFLICT (reference_photo_id) DO UPDATE
         SET embedding = EXCLUDED.embedding, model_version = EXCLUDED.model_version, computed_at = now()`,
      [modelVersion],
    );
    if (appliedTag) await setInstallSetting(client, target.appliedKey, appliedTag);
    await client.query("COMMIT");
    ctx.update({ processed: rows });
    return { status: "applied", rows, matched: res.rowCount ?? 0 };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Background job for the startup check (the other two triggers run inside their own jobs).
export const galleryEmbeddingsJob = createJob<ReferenceVectorsResult>("gallery-embeddings");

/** Startup check: if the model is present and the published vectors are newer than what's
 * applied, fetch them in the background. Never throws. */
export function ensureGalleryEmbeddingsOnStartup(pool: Pool): void {
  if (!isModelDownloaded()) return;
  galleryEmbeddingsJob.start((ctx) => runGalleryEmbeddingsUpdate(pool, ctx));
}
