import { useEffect, useState } from "react";
import { usePersistedFlag } from "../pages/collection/useCollectionDisplayPrefs";
import { ignore } from "./ignore";
import { createCachedRoute } from "./resource";

// The viewer shows a photo's HDR rendition (an Ultra HDR JPEG the server makes from any HDR
// original, /api/photos/:id/hdr) on a screen that reports HDR. Off unless turned on in
// Settings > General. Everything else keeps the SDR images.

export const HDR_VIEWER_KEY = "hdrViewer";
const HDR_QUERY = "(dynamic-range: high)";

/** Settings > General > Show HDR photos in the viewer, saved per browser as lifer:hdrViewer. */
export function useHdrViewerSetting(): [boolean, (on: boolean) => void] {
  return usePersistedFlag(HDR_VIEWER_KEY);
}

/** Whether the screen the page is on can show HDR now; false where the browser can't tell. */
export function hdrScreen(): boolean {
  return typeof matchMedia === "function" && matchMedia(HDR_QUERY).matches;
}

/** hdrScreen, kept current as the window moves between screens or HDR is turned on or off. */
export function useHdrScreen(): boolean {
  const [hdr, setHdr] = useState(hdrScreen);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia(HDR_QUERY);
    const changed = () => setHdr(query.matches);
    query.addEventListener?.("change", changed);
    return () => query.removeEventListener?.("change", changed);
  }, []);
  return hdr;
}

// The photos that have a rendition, so the viewer asks only for those.
const renditions = createCachedRoute("/photos/hdr-renditions", (res): ReadonlySet<string> => new Set(res.photoIds));

/** The HDR rendition to try for a viewer slide, or null to keep the SDR image. Only the signed-in
 *  owner's own photos qualify (share links and reference photos never do), and of those only the
 *  ones in `withRendition`; null there means the list couldn't be had, so any may be tried. */
export function hdrUrlFor(
  url: string,
  on: boolean,
  screenIsHdr: boolean,
  withRendition: ReadonlySet<string> | null,
): string | null {
  if (!on || !screenIsHdr) return null;
  const id = /^\/api\/photos\/([^/?#]+)\/display$/.exec(url)?.[1];
  return id && (!withRendition || withRendition.has(id)) ? `/api/photos/${id}/hdr` : null;
}

// Renditions that failed to load: not asked for again until a reload.
const failed = new Set<string>();

/** The HDR rendition of the slide once it has decoded, else null so the SDR image stays shown.
 *  For the viewer only (Lightbox); grids and thumbnails never use it. */
export function useHdrPhoto(url: string): string | null {
  const [on] = useHdrViewerSetting();
  const enabled = on && useHdrScreen();
  const list = renditions.use(false);
  // Fresh each time the viewer opens, so photos made since show too.
  useEffect(() => {
    if (enabled) list.refresh().catch(ignore("Couldn't load the photos with HDR renditions"));
  }, [enabled]);
  const known = list.error ? null : list.data;
  const want = enabled && (list.error || list.data) ? hdrUrlFor(url, true, true, known) : null;
  const [ready, setReady] = useState<string | null>(null);
  useEffect(() => {
    if (!want || failed.has(want) || typeof Image === "undefined") return;
    const img = new Image();
    let live = true;
    img.src = want;
    (typeof img.decode === "function" ? img.decode() : Promise.reject(new Error("no decode"))).then(
      () => live && setReady(want),
      () => failed.add(want),
    );
    return () => {
      live = false;
      img.src = "";
    };
  }, [want]);
  return ready === want ? ready : null;
}
