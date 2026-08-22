// Mirrors the Phase-2 subset of lifer-spec.md §6 (users, captures, photos, user_species).
// `sessions`/`invite_codes` are server-internal — no client-facing type for those.

export interface User {
  id: string;
  email: string;
  createdAt: string;
}

export type CollectionState = "collected" | "seen" | "unseen";

export interface UserSpecies {
  userId: string;
  speciesId: string;
  state: "collected" | "seen";
  coverPhotoId: string | null;
  firstCollected: string | null;
  bestQuality: number | null;
}

export interface Capture {
  id: string;
  userId: string;
  speciesId: string;
  takenAt: string | null;
  lat: number | null;
  lon: number | null;
  cameraModel: string | null;
  lens: string | null;
  focalLengthMm: number | null;
  aperture: number | null;
  shutter: string | null;
  iso: number | null;
  qualityRating: number | null;
  currentPhotoId: string | null;
  createdAt: string;
}

export interface Photo {
  id: string;
  captureId: string;
  displayPath: string;
  thumbPath: string;
  versionLabel: string | null;
  createdAt: string;
}

// Pulled forward from spec §6/§8.4 for self-hosted, single-user deployment.
// managed=true: Lifer wrote this file and owns its lifecycle ("store" mode).
// managed=false: an external reference Lifer never writes to or deletes ("link" mode).
export interface Original {
  id: string;
  captureId: string;
  kind: "raw" | "jpeg";
  refType: "path" | "immich" | "s3";
  ref: string;
  managed: boolean;
  contentHash: string;
  fileSize: number;
  lastSeenAt: string;
}
