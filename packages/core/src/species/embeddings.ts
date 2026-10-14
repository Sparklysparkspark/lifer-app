// Species matching's public surface, re-exported from the modules that implement it:
// clipModel (the CLIP model files), vectorCache (per-photo vectors), vectorSpaces (per-model
// calibration), userIndex (your own photos' stored vectors), nearDuplicate and suggest (ranking).
export { l2Normalize } from "./onnxImageModel.js";
export {
  MODEL_DIR,
  clipModel,
  isModelDownloaded,
  dropOlderClipModels,
  offloadModel,
  downloadModel,
  isInferenceStuck,
} from "./clipModel.js";
export {
  type PhotoVectorKind,
  hasRememberedVector,
  rememberPhotoVector,
  rememberClientVectors,
  photoVectors,
  suggestionVectors,
  photoVector,
  computeEmbedding,
  cosineSimilarity,
} from "./vectorCache.js";
export { type VectorSpace, CLIP_SPACE, ID_SPACE } from "./vectorSpaces.js";
export {
  clearYourVectorCache,
  captureVectors,
  invalidateUserVectors,
  prefetchUserVectors,
  storeCaptureEmbedding,
  storeIdCaptureEmbedding,
} from "./userIndex.js";
export { type NearDuplicate, findNearDuplicate } from "./nearDuplicate.js";
export {
  matchTargets,
  type OccurrenceContext,
  type SpeciesSuggestion,
  invalidateSuggestionCache,
  refreshSpeciesVectors,
  rankSpeciesByEmbedding,
  rankSpeciesByEmbeddings,
  activeSuggestionModel,
  resetIdModelReadiness,
  suggestionVectorKind,
  suggestSpecies,
  suggestSpeciesForFrames,
  warmSuggestions,
} from "./suggest.js";
