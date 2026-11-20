import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "../app/AppContext";
import type { SquareKind } from "../media/cache";
import { referenceId } from "../media/cache";
import type { Crop } from "./crop";
import { PhotoTile } from "../ui/PhotoTile";

/** The saved thumbnail of a photo, or null until it arrives; updates when the cache fills it in. */
export function useThumb(photoId: string | null | undefined): string | null {
  const { media } = useApp();
  const [uri, setUri] = useState<string | null>(() => (photoId ? media.thumb(photoId) : null));
  useEffect(() => {
    if (!photoId) return setUri(null);
    setUri(media.thumb(photoId));
    return media.watch(photoId, setUri);
  }, [media, photoId]);
  return uri;
}

/** The 2048 px copy for full-width pictures: the thumbnail first, then the display copy when the phone has or can get it. */
export function useDisplay(photoId: string | null | undefined): string | null {
  const { media } = useApp();
  const thumb = useThumb(photoId);
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    setUri(null);
    if (!photoId) return;
    let alive = true;
    void media.display(photoId).then((u) => alive && setUri(u));
    return () => {
      alive = false;
    };
  }, [media, photoId]);
  return uri ?? thumb;
}

/** The hub's square cut of a featured photo once it is saved or fetched; null until then. `owner` is the
 *  scientific name (a species) or the album or trip id. */
export function useSquare(
  kind: SquareKind,
  owner: string,
  photoId: string | null | undefined,
  crop: Crop | null | undefined,
): string | null {
  const { media } = useApp();
  const [square, setSquare] = useState<{ key: string; uri: string } | null>(null);
  const key = photoId ? `${kind}~${owner}~${photoId}~${crop ? `${crop.x}~${crop.y}~${crop.size}` : ""}` : "";
  useEffect(() => {
    if (!photoId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A square that could not be fetched (hub busy, a dropped connection) is tried again a few times, not left on the thumbnail for good.
    const load = (attempt: number) =>
      void media
        .square(kind, kind === "species" ? referenceId(owner).slice(4) : owner, photoId, crop ?? null)
        .then((uri) => {
          if (!alive) return;
          if (uri) setSquare({ key, uri });
          else if (attempt < 3) timer = setTimeout(() => load(attempt + 1), 15_000 * (attempt + 1));
        });
    load(0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // `key` carries crop's values, so a new crop object with the same values doesn't refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media, kind, owner, photoId, key]);
  return square?.key === key ? square.uri : null;
}

/**
 * What a card or cover shows for a featured photo: the hub's square once saved (the crop is already
 * applied), the cropped thumbnail until then. With no photo, a species' reference photo (its display
 * copy, centred).
 */
export function useFeatured(
  kind: SquareKind,
  owner: string,
  photoId: string | null | undefined,
  crop: Crop | null | undefined,
): { uri: string | null; crop: Crop | null } {
  const square = useSquare(kind, owner, photoId, crop);
  const thumb = useThumb(photoId);
  const reference = useDisplay(photoId || kind !== "species" ? null : referenceId(owner));
  if (!photoId) return { uri: reference, crop: null };
  return square ? { uri: square, crop: null } : { uri: thumb, crop: crop ?? null };
}

/** A grid square showing the saved thumbnail, or a quiet placeholder until it arrives. */
export const CachedTile = memo(function CachedTile({
  photoId,
  size,
  width,
  onPress,
  rounded,
  label,
  crop,
  dense,
}: {
  photoId: string;
  size: number;
  width?: number;
  onPress?: () => void;
  rounded?: boolean;
  label?: string;
  crop?: Crop | null;
  dense?: boolean;
}) {
  const { t } = useTranslation();
  const uri = useThumb(photoId);
  return (
    <PhotoTile
      uri={uri}
      size={size}
      width={width}
      onPress={onPress}
      rounded={rounded}
      crop={crop}
      dense={dense}
      label={label ?? t("photos.tile")}
    />
  );
});
