import { gridGapFor } from "../../components/justifyRows";
import { usePersistedState } from "../../hooks/usePersistedState";
import { usePhotoGridSize } from "../../hooks/usePhotoGridSize";
import { useShowLabels } from "../../hooks/useShowLabels";

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
    gridGapPx: gridGapFor(thumbSizePx),
    gridCornerRadiusPx: Math.round(Math.min(8, Math.max(2, thumbSizePx / 40))),
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
