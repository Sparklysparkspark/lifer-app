import { useEffect, useMemo, useState } from "react";
import { ALL_TAXON_CLASSES } from "@lifer/shared";
import { api } from "../../api/client";
import { useSettings } from "../../hooks/useSettings";

// What the whole library holds, so the filters only offer choices that can match something.
export function useGalleryFacets() {
  // Only offer the media filter when the library has a video at all.
  const [hasVideoInLibrary, setHasVideoInLibrary] = useState(false);
  useEffect(() => {
    api
      .get<{ hasVideo: boolean }>("/gallery/has-video")
      .then((res) => setHasVideoInLibrary(res.hasVideo))
      .catch(() => {});
  }, []);
  // Photos imported hidden (a culling app rejected them), so the "Hidden" filter only shows when
  // there are some. Re-read after an unhide.
  const [hiddenCount, setHiddenCount] = useState(0);
  const [hiddenCountVersion, setHiddenCountVersion] = useState(0);
  useEffect(() => {
    api
      .get<{ count: number }>("/captures/hidden-count")
      .then((res) => setHiddenCount(res.count))
      .catch(() => {});
  }, [hiddenCountVersion]);
  // Taxa the library actually has, so the taxon filter never offers an empty choice. An empty set
  // also means the library has no photos at all.
  const [availableTaxa, setAvailableTaxa] = useState<Set<string> | null>(null);
  useEffect(() => {
    api
      .get<{ taxa: string[] }>("/gallery/taxa")
      .then((res) => setAvailableTaxa(new Set(res.taxa)))
      .catch(() => {});
  }, []);
  // Other Taxa classes (e.g. "insecta") get their own pills beside the built-in classes.
  const otherTaxaClasses = useMemo(
    () => [...(availableTaxa ?? [])].filter((tc) => !(ALL_TAXON_CLASSES as string[]).includes(tc)).sort(),
    [availableTaxa],
  );
  const { settings } = useSettings();
  const namingStyles = settings?.speciesNamingStyles ?? [];
  // Region filter offers only regions that have photos.
  const [regionsWithPhotos, setRegionsWithPhotos] = useState<Set<string> | null>(null);
  useEffect(() => {
    api
      .get<{ regionIds: string[] }>("/gallery/regions-with-photos")
      .then((res) => setRegionsWithPhotos(new Set(res.regionIds)))
      .catch(() => {});
  }, []);

  return {
    hiddenCount,
    refreshHiddenCount: () => setHiddenCountVersion((v) => v + 1),
    hasVideoInLibrary,
    availableTaxa,
    otherTaxaClasses,
    namingStyles,
    regionsWithPhotos,
    libraryEmpty: availableTaxa !== null && availableTaxa.size === 0,
  };
}

export type GalleryFacets = ReturnType<typeof useGalleryFacets>;
