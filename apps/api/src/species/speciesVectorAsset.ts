// Installs a one-vector-per-species table (species_reference_embeddings,
// species_text_embeddings) from its own compact asset (format:
// packages/shared/src/speciesVectorFormat.ts). Same story as the per-gallery-photo table in
// galleryEmbeddingsAsset.ts, which orchestrates this alongside the gallery vectors.
import { createReadStream, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { Pool } from "pg";
import { decodeSpeciesVectors, type SpeciesVectorHeader } from "@lifer/shared/src/speciesVectorFormat.js";
import { APP_DATA_DIR } from "../config.js";
import { getInstallSetting, setInstallSetting } from "../lib/installSettings.js";
import { type JobContext } from "../lib/job.js";
import { copyInto } from "../lib/pgCopy.js";
import { downloadResumable } from "../lib/resumableDownload.js";
import { resolveCatalogAssetUrl, type CatalogManifest, type VectorAsset } from "./catalogManifest.js";
import { invalidateSuggestionCache } from "./embeddings.js";

const DOWNLOAD_DIR = path.join(APP_DATA_DIR, "catalog-downloads");

export type VectorAssetResult =
  | { status: "applied"; rows: number; matched: number }
  | { status: "up_to_date" }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; error: string };

type Ctx = Pick<JobContext<unknown>, "signal" | "update" | "throwIfCancelled">;

export interface SpeciesVectorTableSpec {
  table: "species_reference_embeddings" | "species_text_embeddings" | "id_model_reference_embeddings" | "id_model_text_embeddings";
  currentModelVersion: string;
  appliedKey: string;
  label: string;
  phase: string;
  applyPhase: string;
}

export async function fetchAndApplySpeciesVectorAsset(
  pool: Pool,
  ctx: Ctx,
  spec: SpeciesVectorTableSpec,
  manifest: CatalogManifest,
  asset: VectorAsset | null | undefined,
  force: boolean,
): Promise<VectorAssetResult> {
  if (!asset) return { status: "unavailable", reason: `This catalog has no separate ${spec.label}` };
  if (asset.modelVersion !== spec.currentModelVersion) {
    return { status: "unavailable", reason: `Published ${spec.label} are for model ${asset.modelVersion}, this install uses ${spec.currentModelVersion}` };
  }
  const appliedTag = `${manifest.version}:${asset.modelVersion}`;
  if (!force && (await getInstallSetting<string>(pool, spec.appliedKey)) === appliedTag) return { status: "up_to_date" };

  mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const dest = path.join(DOWNLOAD_DIR, path.basename(new URL(resolveCatalogAssetUrl(asset.url)).pathname));
  ctx.update({ phase: spec.phase, downloadedBytes: 0, totalBytes: asset.bytes, processed: null, total: null });
  await downloadResumable(resolveCatalogAssetUrl(asset.url), dest, {
    signal: ctx.signal,
    expectedSha256: asset.sha256,
    label: `the ${spec.label}`,
    onProgress: (downloadedBytes, totalBytes) => ctx.update({ downloadedBytes, totalBytes }),
  });
  ctx.throwIfCancelled();

  const result = await applySpeciesVectorFile(pool, spec, dest, appliedTag, ctx);
  rmSync(dest, { force: true });
  return result;
}

/** Loads the file into a temp table with COPY, then upserts by species_id (a portable key,
 * since species is in the catalog seed itself), all in one transaction. */
export async function applySpeciesVectorFile(
  pool: Pool,
  spec: SpeciesVectorTableSpec,
  filePath: string,
  appliedTag: string | null,
  ctx: Ctx,
): Promise<VectorAssetResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE tmp_species_vector (species_id uuid, embedding real[]) ON COMMIT DROP`);

    let header: SpeciesVectorHeader | null = null;
    let rows = 0;
    ctx.update({ phase: spec.applyPhase, downloadedBytes: null, totalBytes: null, processed: 0, total: null });

    const gunzip = createGunzip();
    pipeline(createReadStream(filePath), gunzip).catch((err) => gunzip.destroy(err));
    async function* copyRows(): AsyncGenerator<string> {
      for await (const r of decodeSpeciesVectors(gunzip, (h) => {
        header = h;
        ctx.update({ total: h.rowCount });
      })) {
        if (++rows % 5000 === 0) {
          ctx.throwIfCancelled();
          ctx.update({ processed: rows });
        }
        yield `${r.speciesId}\t{${r.embedding.join(",")}}\n`;
      }
    }
    try {
      await copyInto(client, `COPY tmp_species_vector (species_id, embedding) FROM STDIN`, copyRows());
    } finally {
      gunzip.destroy();
    }
    const modelVersion = (header as SpeciesVectorHeader | null)?.modelVersion ?? spec.currentModelVersion;

    ctx.throwIfCancelled();
    const res = await client.query(
      `INSERT INTO ${spec.table} (species_id, embedding, model_version)
       SELECT t.species_id, t.embedding, $1
         FROM tmp_species_vector t
         JOIN species s ON s.id = t.species_id
       ON CONFLICT (species_id) DO UPDATE
         SET embedding = EXCLUDED.embedding, model_version = EXCLUDED.model_version, computed_at = now()`,
      [modelVersion],
    );
    if (appliedTag) await setInstallSetting(client, spec.appliedKey, appliedTag);
    await client.query("COMMIT");
    invalidateSuggestionCache();
    ctx.update({ processed: rows });
    return { status: "applied", rows, matched: res.rowCount ?? 0 };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
