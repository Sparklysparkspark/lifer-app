import type { AlbumPhoto, QuadSlot } from "@lifer/shared";

// GET /api/albums/:id
export interface AlbumDetail {
  id: string;
  name: string;
  description: string | null;
  coverPhotoId: string | null;
  coverLayout: "single" | "quad";
  coverCropX: number | null;
  coverCropY: number | null;
  coverCropSize: number | null;
  quadSlots: Array<QuadSlot | null>;
  items: AlbumPhoto[];
}

// GET /api/albums/:id/shares
export interface ShareLink {
  id: string;
  // null when the server can no longer show it (its key file was lost); the link still works.
  token: string | null;
  hasPassword: boolean;
  allowDownload: boolean;
  showMetadata: boolean;
  expiresAt: string | null;
  revoked: boolean;
  createdAt: string;
}

export type AlbumView = "gallery" | "species";

export type Crop = { x: number; y: number; size: number };
