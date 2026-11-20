// Smart search for people with no Lifer hub: the phone itself needs CLIP ViT-L/14's image and text
// encoders, and a public place to download them from.
//
// TODO(model host): the public host for the image and text encoders is not set up yet. Set this to
// its base URL (and add the file list and checksums to the manifest the phone fetches) and the
// download, background vector work and Identify below switch on. Until then the app says smart
// search will be available once downloads are set up, and nothing is requested.
export const PHONE_MODEL_HOST: string | null = null;

// TODO(reference vectors): per-region species reference vectors for Identify, published beside the
// catalog. Identify keeps its name search until both this and PHONE_MODEL_HOST are set.
export const REFERENCE_VECTOR_HOST: string | null = null;

/** Whether a phone with no hub can fetch the encoders at all yet. */
export const phoneModelsConfigured = (): boolean => PHONE_MODEL_HOST !== null;

export interface PhotoVectorWork {
  /** Photos that have no vector yet. */
  pending: () => Promise<string[]>;
  /** Null until the image encoder is downloaded. */
  embed: ((photoId: string) => Promise<Float32Array>) | null;
  store: (photoId: string, vector: Float32Array) => Promise<void>;
  onProgress?: (done: number, total: number) => void;
  stopped?: () => boolean;
}

/** Computes the vector of every photo added on the phone, one at a time, reporting progress. Returns how many were done. */
export async function computePhotoVectors(w: PhotoVectorWork): Promise<number> {
  if (!w.embed) return 0;
  const ids = await w.pending();
  let done = 0;
  w.onProgress?.(0, ids.length);
  for (const id of ids) {
    if (w.stopped?.()) break;
    await w.store(id, await w.embed(id));
    w.onProgress?.(++done, ids.length);
  }
  return done;
}
