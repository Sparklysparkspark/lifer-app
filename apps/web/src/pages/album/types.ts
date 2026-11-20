import type { AlbumPhoto, QuadSlot } from "@lifer/shared";
import type { SmartAlbumRules } from "../gallery/smartAlbumRules";

// GET /api/albums/:id
export interface AlbumDetail {
  id: string;
  name: string;
  description: string | null;
  coverPhotoId: string | null;
  /** The cover was chosen by hand; otherwise coverPhotoId is the automatic one. */
  coverPicked: boolean;
  coverLayout: "single" | "quad";
  coverCropX: number | null;
  coverCropY: number | null;
  coverCropSize: number | null;
  quadSlots: Array<QuadSlot | null>;
  items: AlbumPhoto[];
  /** A smart album's rules; null for hand-picked photos. */
  rules: SmartAlbumRules | null;
  /** Photos taken out of a smart album by hand. */
  excludedCount: number;
}

// GET /api/albums/:id/shares
export interface ShareLink {
  id: string;
  // null when the server can no longer show it (its key file was lost); the link still works.
  token: string | null;
  hasPassword: boolean;
  allowDownload: boolean;
  showMetadata: boolean;
  /** Place names show on the link (a sensitive species' only to its province or country). */
  showExactLocations: boolean;
  expiresAt: string | null;
  revoked: boolean;
  createdAt: string;
}

export type AlbumView = "gallery" | "species";

export type Crop = { x: number; y: number; size: number };
