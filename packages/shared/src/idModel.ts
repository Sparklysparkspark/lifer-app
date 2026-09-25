// The species identification model (BioCLIP 2): names species far more accurately than the CLIP
// model Lifer also uses, which stays in charge of Gallery search, near-duplicates and bursts.
// Its vectors live in the id_model_* tables (migration 105).
//
// Bump this whenever the model or how its vectors are computed changes, in step with
// packages/data-pipeline/python (which writes it into every vector it computes). Installs only
// ever match vectors carrying the version they run.
export const ID_MODEL_VERSION = "bioclip-2-v1";
