import { useEffect, useMemo, useState } from "react";
import { ALL_TAXON_CLASSES } from "@lifer/shared";
import { api } from "../../api/client";
import { useSettings } from "../../hooks/useSettings";
import { ignore } from "../../lib/ignore";

// One empty list, so the grid's grouping isn't redone on every render while settings load.
const NO_NAMING_STYLES: string[] = [];

// What the whole library holds, so the filters only offer choices that can match something.
export function useGalleryFacets() {
  // Only offer the media filter when the library has a video or recording at all.
  const [hasOtherMediaInLibrary, setHasOtherMediaInLibrary] = useState(false);
  useEffect(() => {
    api
      .get<{ hasVideo: boolean; hasAudio: boolean }>("/gallery/has-video")
      .then((res) => setHasOtherMediaInLibrary(res.hasVideo || res.hasAudio))
      .catch(ignore("Couldn't check for videos"));
  }, []);
  // Photos imported hidden (a culling app rejected them), so the "Hidden" filter only shows when
  // there are some. Re-read after an unhide.
  const [hiddenCount, setHiddenCount] = useState(0);
  const [hiddenCountVersion, setHiddenCountVersion] = useState(0);
  useEffect(() => {
    api
      .get<{ count: number }>("/captures/hidden-count")
      .then((res) => setHiddenCount(res.count))
      .catch(ignore("Couldn't load gallery filters"));
  }, [hiddenCountVersion]);
  // Taxa the library actually has, so the taxon filter never offers an empty choice. An empty set
  // also means the library has no photos at all.
  const [availableTaxa, setAvailableTaxa] = useState<Set<string> | null>(null);
  useEffect(() => {
    api
      .get<{ taxa: string[] }>("/gallery/taxa")
      .then((res) => setAvailableTaxa(new Set(res.taxa)))
      .catch(ignore("Couldn't load gallery filters"));
  }, []);
  // Other Taxa classes (e.g. "insecta") get their own pills beside the built-in classes.
  const otherTaxaClasses = useMemo(
    () => [...(availableTaxa ?? [])].filter((tc) => !(ALL_TAXON_CLASSES as string[]).includes(tc)).sort(),
    [availableTaxa],
  );
  const { settings } = useSettings();
  const namingStyles = settings?.speciesNamingStyles ?? NO_NAMING_STYLES;
  // Region filter offers only regions that have photos.
  const [regionsWithPhotos, setRegionsWithPhotos] = useState<Set<string> | null>(null);
  useEffect(() => {
    api
      .get<{ regionIds: string[] }>("/gallery/regions-with-photos")
      .then((res) => setRegionsWithPhotos(new Set(res.regionIds)))
      .catch(ignore("Couldn't load gallery filters"));
  }, []);

  return {
    hiddenCount,
    refreshHiddenCount: () => setHiddenCountVersion((v) => v + 1),
    hasOtherMediaInLibrary,
    availableTaxa,
    otherTaxaClasses,
    namingStyles,
    regionsWithPhotos,
    libraryEmpty: availableTaxa !== null && availableTaxa.size === 0,
  };
}

export type GalleryFacets = ReturnType<typeof useGalleryFacets>;
