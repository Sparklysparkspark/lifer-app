// Phase 7e (spec §9): "PhotoSource interface: listPhotos(speciesId), originalUrl(captureId)."
// The existing local-filesystem behavior is the trivial implementation of this; S3 is the
// other one actually built (see apps/api/src/photoSources) — Immich is deferred (needs a
// real instance to verify its API against, not something to guess at).
export interface PhotoSourceAsset {
  id: string;
  url: string;
}

export interface PhotoSource {
  listPhotos(speciesId: string): Promise<PhotoSourceAsset[]>;
  originalUrl(captureId: string): Promise<string | null>;
}
