import type { CollectionItem } from "@lifer/shared";

/** Your own cover photo cut to its card crop on the server, at `side` px, if it has a crop. */
export function cardCropUrl(item: CollectionItem, side: number | undefined): string | null {
  const photoId = item.coverPhotoUrl?.match(/^\/api\/photos\/([^/]+)\/thumb/)?.[1];
  return photoId && item.cardCropX != null && item.cardCropY != null && item.cardCropSize
    ? `/api/photos/${photoId}/card?x=${item.cardCropX}&y=${item.cardCropY}&size=${item.cardCropSize}${
        side ? `&w=${side}` : ""
      }`
    : null;
}

/** The image a card loads first, so a grid can fetch it ahead of mounting the card. */
export function cardImageSrc(item: CollectionItem, side: number | undefined): string | null {
  return cardCropUrl(item, side) ?? item.coverPhotoUrl ?? null;
}
