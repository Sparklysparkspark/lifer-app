import type { JobStatus } from "@lifer/shared";
import type { PhaseLabels } from "../../components/JobProgress";

export type VectorAssetResult =
  | { status: "applied"; rows: number; matched: number }
  | { status: "up_to_date" }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; error: string };

// Per-gallery-photo, per-species image and per-species text vectors, applied together server-side.
export type VectorBundle = {
  gallery: VectorAssetResult;
  speciesImage: VectorAssetResult;
  speciesText: VectorAssetResult;
};
// `idModel`: the same three for the species identification model, once it's downloaded.
export type ReferenceVectorsResult = VectorBundle & { idModel?: VectorBundle };

export type CatalogUpdateStatus = JobStatus<{
  merged: Record<string, number>;
  referenceVectors?: ReferenceVectorsResult | null;
}>;

export type MapStatus = JobStatus<{ bytes: number }> & {
  available: boolean;
  downloaded: boolean;
  sizeBytes: number | null;
};

export type ModelStatus = JobStatus<{ referenceVectors: ReferenceVectorsResult | null }> & {
  downloaded: boolean;
  usable?: boolean;
  idModelDownloaded?: boolean;
  activeModel?: "identification" | "general" | null;
  sizeBytes: number | null;
};

/** Every failed sub-result, for one combined error line. */
export function failedVectorAssets(r: VectorBundle | ReferenceVectorsResult | null | undefined): string[] {
  if (!r) return [];
  const errors: string[] = [];
  if (r.gallery.status === "failed") errors.push(r.gallery.error);
  if (r.speciesImage.status === "failed") errors.push(r.speciesImage.error);
  if (r.speciesText.status === "failed") errors.push(r.speciesText.error);
  if ("idModel" in r && r.idModel) errors.push(...failedVectorAssets(r.idModel));
  return errors;
}

// Catalog and model jobs share one reference-vector queue, hence the waiting phase in both.
export const CATALOG_PHASES: PhaseLabels = {
  waiting_for_vectors: { label: "Waiting for another download to finish", progress: "none" },
  downloading: { label: "Downloading", progress: "bytes" },
  applying: { label: "Reading catalog data", progress: "bytes" },
  merging: { label: "Applying", progress: "count", countNoun: "tables", showItem: true },
  downloading_gallery_embeddings: { label: "Downloading species reference vectors", progress: "bytes" },
  applying_gallery_embeddings: { label: "Applying species reference vectors", progress: "count" },
  downloading_species_image_embeddings: { label: "Downloading species reference vectors", progress: "bytes" },
  applying_species_image_embeddings: { label: "Applying species reference vectors", progress: "count" },
  downloading_species_text_embeddings: { label: "Downloading species search vectors", progress: "bytes" },
  applying_species_text_embeddings: { label: "Applying species search vectors", progress: "count" },
  downloading_id_species_text_embeddings: { label: "Downloading species identification vectors", progress: "bytes" },
  applying_id_species_text_embeddings: { label: "Applying species identification vectors", progress: "count" },
  downloading_id_species_image_embeddings: { label: "Downloading species identification vectors", progress: "bytes" },
  applying_id_species_image_embeddings: { label: "Applying species identification vectors", progress: "count" },
  downloading_id_gallery_embeddings: { label: "Downloading species identification vectors", progress: "bytes" },
  applying_id_gallery_embeddings: { label: "Applying species identification vectors", progress: "count" },
};

// The reference vectors read as the second half of the model download, so they share its wording.
export const MODEL_PHASES: PhaseLabels = {
  waiting_for_vectors: { label: "Waiting for another download to finish", progress: "none" },
  downloading_model: { label: "Downloading model", progress: "bytes" },
  downloading_text_model: { label: "Downloading text model", progress: "none" },
  downloading_gallery_embeddings: { label: "Downloading species reference vectors", progress: "bytes" },
  applying_gallery_embeddings: { label: "Downloading species reference vectors", progress: "count" },
  downloading_species_image_embeddings: { label: "Downloading species reference vectors", progress: "bytes" },
  applying_species_image_embeddings: { label: "Downloading species reference vectors", progress: "count" },
  downloading_species_text_embeddings: { label: "Downloading species search vectors", progress: "bytes" },
  applying_species_text_embeddings: { label: "Downloading species search vectors", progress: "count" },
  downloading_id_model: { label: "Downloading species identification model", progress: "bytes" },
  downloading_id_species_text_embeddings: { label: "Downloading species identification vectors", progress: "bytes" },
  applying_id_species_text_embeddings: { label: "Downloading species identification vectors", progress: "count" },
  downloading_id_species_image_embeddings: { label: "Downloading species identification vectors", progress: "bytes" },
  applying_id_species_image_embeddings: { label: "Downloading species identification vectors", progress: "count" },
  downloading_id_gallery_embeddings: { label: "Downloading species identification vectors", progress: "bytes" },
  applying_id_gallery_embeddings: { label: "Downloading species identification vectors", progress: "count" },
};

export const MAP_PHASES: PhaseLabels = { downloading: { label: "Downloading", progress: "bytes" } };

export const APP_UPDATE_PHASES: PhaseLabels = {
  downloading: { label: "Downloading", progress: "bytes" },
  installing: { label: "Installing, Lifer will restart shortly…", progress: "none" },
};

export const REIMPORT_PHASES: PhaseLabels = {
  jpegs: { label: "Reading photos", progress: "count" },
  raws: { label: "Matching RAW files", progress: "count" },
};
