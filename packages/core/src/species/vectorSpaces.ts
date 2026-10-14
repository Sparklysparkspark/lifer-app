// Which model's vectors a ranking runs on, with that model's own calibration.
import { EMBEDDING_MODEL_VERSION, ID_MODEL_VERSION } from "../config.js";

// Weight of the zero-shot text signal (the photo against "a photo of a {species}"), blended with
// the image-to-image score. It is independent of the photo's background and lighting.
const TEXT_BLEND_WEIGHT = 0.7;

// The top pick is confident only when it beats the runner-up by CONFIDENCE_MARGIN: the margin,
// not the raw blended score, is what separates right from wrong. The floor only guards against
// having no signal at all. Tuned to err toward "not confident" rather than falsely certain.
const CONFIDENCE_FLOOR = 0.4;
const CONFIDENCE_MARGIN = 0.025;

// Which model's vectors a ranking runs on, with that model's own calibration (score ranges
// differ between CLIP and the identification model).
export interface VectorSpace {
  modelVersion: string;
  textModelVersion: string;
  captureTable: "capture_embeddings" | "id_model_capture_embeddings";
  referenceTable: "species_reference_embeddings" | "id_model_reference_embeddings";
  galleryTable: "species_reference_gallery_embeddings" | "id_model_gallery_embeddings";
  textTable: "species_text_embeddings" | "id_model_text_embeddings";
  textWeight: number;
  confidenceFloor: number;
  confidenceMargin: number;
  /** A margin that counts as fully decisive: scales matchPercent and cuts low-relevance alternatives. */
  marginScale: number;
}

// Must match TEXT_MODEL_VERSION in textEmbedding.ts (not imported, to keep this file free of the
// text model's transformers.js dependency).
const CLIP_TEXT_MODEL_VERSION = "clip-vit-l14-text-v2";

export const CLIP_SPACE: VectorSpace = {
  modelVersion: EMBEDDING_MODEL_VERSION,
  textModelVersion: CLIP_TEXT_MODEL_VERSION,
  captureTable: "capture_embeddings",
  referenceTable: "species_reference_embeddings",
  galleryTable: "species_reference_gallery_embeddings",
  textTable: "species_text_embeddings",
  textWeight: TEXT_BLEND_WEIGHT,
  confidenceFloor: CONFIDENCE_FLOOR,
  confidenceMargin: CONFIDENCE_MARGIN,
  marginScale: 0.05,
};

// Same meaning as CLIP's constants. This model's blended scores run higher, so the floor is
// higher, and it is still only a no-signal guard.
const ID_CONFIDENCE_FLOOR = 0.6;
const ID_CONFIDENCE_MARGIN = 0.027;
const ID_MARGIN_SCALE = 0.05;

export const ID_SPACE: VectorSpace = {
  modelVersion: ID_MODEL_VERSION,
  textModelVersion: ID_MODEL_VERSION,
  captureTable: "id_model_capture_embeddings",
  referenceTable: "id_model_reference_embeddings",
  galleryTable: "id_model_gallery_embeddings",
  textTable: "id_model_text_embeddings",
  textWeight: 0.7,
  confidenceFloor: ID_CONFIDENCE_FLOOR,
  confidenceMargin: ID_CONFIDENCE_MARGIN,
  marginScale: ID_MARGIN_SCALE,
};
