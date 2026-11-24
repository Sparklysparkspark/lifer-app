import { useCallback, useState } from "react";
import { gridGapFor } from "../../components/justifyRows";
import { usePersistedState } from "../../hooks/usePersistedState";
import { usePhotoGridSize } from "../../hooks/usePhotoGridSize";
import { usePhotoCaptionPrefs } from "../../hooks/usePhotoCaptionPrefs";
import { useUrlParam } from "../../hooks/useSearchParamsKeepingState";
import type { GalleryGroupBy } from "./galleryHelpers";

// How the grid looks: thumbnail size and the optional caption rows, all remembered on this device.
export function useGalleryDisplayPrefs() {
  const [thumbSizePx, updateThumbSize] = usePhotoGridSize();
  const captions = usePhotoCaptionPrefs();
  const [legacyGroupBy] = useState(legacyGalleryGroupBy);
  const [groupBy, setGroupBy] = usePersistedState<GalleryGroupBy>("galleryGroupBy", legacyGroupBy);
  // Off by default: every print, edit and export listed as its own photo.
  const [allVersions, setAllVersions] = usePersistedState<boolean>("galleryAllVersions", false);
  // Off by default. In ?bursts= too, so a shared or reloaded link shows the grid the same way.
  const [savedGroupBursts, saveGroupBursts] = usePersistedState<boolean>("galleryGroupBursts", false);
  const [burstsParam, setBurstsParam] = useUrlParam("bursts");
  const groupBursts = burstsParam ? burstsParam === "1" : savedGroupBursts;
  const setGroupBursts = useCallback(
    (on: boolean) => {
      saveGroupBursts(on);
      setBurstsParam(on ? "1" : "");
    },
    [saveGroupBursts, setBurstsParam],
  );
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
    groupBursts,
    setGroupBursts,
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
