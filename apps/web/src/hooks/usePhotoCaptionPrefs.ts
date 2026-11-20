import { usePersistedState } from "./usePersistedState";
import { useShowLabels } from "./useShowLabels";

// The caption rows under photo tiles, chosen in every grid's View menu. One saved choice each, so a
// caption turned on in the Gallery shows on albums, trips and species pages too. The keys predate
// the sharing and stay so saved choices carry over. Captions start off.
export function usePhotoCaptionPrefs() {
  const [showLabels, setShowLabels] = useShowLabels();
  const [showCameraInfo, setShowCameraInfo] = usePersistedState("galleryShowCameraInfo", false);
  const [showRatings, setShowRatings] = usePersistedState("galleryShowRatings", false);
  return { showLabels, setShowLabels, showCameraInfo, setShowCameraInfo, showRatings, setShowRatings };
}

export type PhotoCaptionPrefs = ReturnType<typeof usePhotoCaptionPrefs>;
