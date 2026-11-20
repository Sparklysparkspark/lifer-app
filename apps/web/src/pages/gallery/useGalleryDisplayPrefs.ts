import { useState } from "react";
import { gridGapFor } from "../../components/justifyRows";
import { usePersistedState } from "../../hooks/usePersistedState";
import { usePhotoGridSize } from "../../hooks/usePhotoGridSize";
import { usePhotoCaptionPrefs } from "../../hooks/usePhotoCaptionPrefs";
import type { GalleryGroupBy } from "./galleryHelpers";

// How the grid looks: thumbnail size and the optional caption rows, all remembered on this device.
export function useGalleryDisplayPrefs() {
  const [thumbSizePx, updateThumbSize] = usePhotoGridSize();
  const captions = usePhotoCaptionPrefs();
  const [legacyGroupBy] = useState(legacyGalleryGroupBy);
  const [groupBy, setGroupBy] = usePersistedState<GalleryGroupBy>("galleryGroupBy", legacyGroupBy);
  // Off by default: every print, edit and export listed as its own photo.
  const [allVersions, setAllVersions] = usePersistedState<boolean>("galleryAllVersions", false);
  return {
    thumbSizePx,
    updateThumbSize,
    // Gap and corner radius scale with thumbnail size so chrome doesn't dominate small tiles.
    gridGapPx: gridGapFor(thumbSizePx),
    gridCornerRadiusPx: Math.round(Math.min(8, Math.max(2, thumbSizePx / 40))),
    ...captions,
    groupBy,
    setGroupBy,
    allVersions,
    setAllVersions,
  };
}

// Grouping used to be a "Group by region" on/off toggle; a saved "on" carries over as Region.
function legacyGalleryGroupBy(): GalleryGroupBy {
  try {
    return localStorage.getItem("lifer:galleryGroupByRegion") === "true" ? "region" : "none";
  } catch {
    return "none";
  }
}

export type GalleryDisplayPrefs = ReturnType<typeof useGalleryDisplayPrefs>;
