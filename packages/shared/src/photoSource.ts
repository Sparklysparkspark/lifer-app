// A photo storage backend. Local filesystem and S3 are implemented (see apps/api/src/photoSources).
export interface PhotoSourceAsset {
  id: string;
  url: string;
}

export interface PhotoSource {
  listPhotos(speciesId: string): Promise<PhotoSourceAsset[]>;
  originalUrl(captureId: string): Promise<string | null>;
}
