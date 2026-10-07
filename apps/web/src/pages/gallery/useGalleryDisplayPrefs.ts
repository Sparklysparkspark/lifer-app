import { usePersistedState } from "../../hooks/usePersistedState";
import { usePhotoGridSize } from "../../hooks/usePhotoGridSize";
import { useShowLabels } from "../../hooks/useShowLabels";

// Per-line heights of the optional caption rows, so MasonryGrid reserves room for them.
const LABEL_LINE_HEIGHT_PX = 19;
const RATING_LINE_HEIGHT_PX = 18;
export const CAMERA_INFO_LINE_HEIGHT_PX = 13;

// How the grid looks: thumbnail size and the optional caption rows, all remembered on this device.
export function useGalleryDisplayPrefs() {
  const [thumbSizePx, updateThumbSize] = usePhotoGridSize();
  const [showCameraInfo, setShowCameraInfo] = usePersistedState("galleryShowCameraInfo", false);
  const [showLabels, setShowLabels] = useShowLabels();
  const [showRatings, setShowRatings] = usePersistedState("galleryShowRatings", false);
  const [groupByRegion, setGroupByRegion] = usePersistedState("galleryGroupByRegion", false);
  return {
    thumbSizePx,
    updateThumbSize,
    // Gap and corner radius scale with thumbnail size so chrome doesn't dominate small tiles.
    gridGapPx: Math.round(Math.min(8, Math.max(3, thumbSizePx / 30))),
    gridCornerRadiusPx: Math.round(Math.min(8, Math.max(2, thumbSizePx / 40))),
    // Camera info wraps per photo, so it adds its second line through extraHeightPxFor.
    extraHeightPx:
      (showLabels ? LABEL_LINE_HEIGHT_PX : 0) +
      (showRatings ? RATING_LINE_HEIGHT_PX : 0) +
      (showCameraInfo ? CAMERA_INFO_LINE_HEIGHT_PX : 0),
    showCameraInfo,
    setShowCameraInfo,
    showLabels,
    setShowLabels,
    showRatings,
    setShowRatings,
    groupByRegion,
    setGroupByRegion,
  };
}

export type GalleryDisplayPrefs = ReturnType<typeof useGalleryDisplayPrefs>;
