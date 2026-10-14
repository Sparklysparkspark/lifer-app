// Response schemas for the album and share routes. They document the answer in the OpenAPI
// document; fields not listed still pass through.
import { Type } from "typebox";
import { Nullable, Open, Uuid } from "../lib/schema.js";
// The gallery's item and the Collection's card shapes, so the web reuses their grids.
import { CollectionItem } from "../collection/responses.js";
import { GalleryItem } from "../gallery/responses.js";

const CoverLayout = Type.Enum(["single", "quad"]);
const Percent = Nullable(Type.Number());

const QuadSlot = Nullable(Open({ photoId: Uuid(), cropX: Percent, cropY: Percent, cropSize: Percent }));

const AlbumFields = {
  id: Uuid(),
  name: Type.String(),
  description: Nullable(Type.String()),
  coverPhotoId: Nullable(Uuid()),
  createdAt: Type.String({ format: "date-time" }),
};

const CoverFields = {
  coverLayout: CoverLayout,
  coverCropX: Percent,
  coverCropY: Percent,
  coverCropSize: Percent,
  quadSlots: Type.Array(QuadSlot, { description: "The 4 tiles of a quad cover, null where there's no photo" }),
};

export const AlbumList = Open({
  albums: Type.Array(Open({ ...AlbumFields, ...CoverFields, captureCount: Type.Integer() })),
});

export const CreatedAlbum = Open({ ...AlbumFields, captureCount: Type.Integer() });

export const AlbumDetail = Open({ ...AlbumFields, ...CoverFields, items: Type.Array(GalleryItem) });

export const UpdatedAlbum = Open({ ...AlbumFields, coverLayout: CoverLayout });

export const AlbumSpecies = Open({ items: Type.Array(CollectionItem) });

const ShareFields = {
  id: Uuid(),
  hasPassword: Type.Boolean(),
  allowDownload: Type.Boolean(),
  showMetadata: Type.Boolean(),
  expiresAt: Nullable(Type.String({ format: "date-time" })),
  createdAt: Type.String({ format: "date-time" }),
};

export const CreatedShare = Open({ ...ShareFields, token: Type.String({ description: "The link's secret" }) });

export const ShareList = Open({
  shares: Type.Array(
    Open({
      ...ShareFields,
      token: Nullable(Type.String({ description: "Null when it can't be shown again (the server's key was lost)" })),
      revoked: Type.Boolean(),
    }),
  ),
});
