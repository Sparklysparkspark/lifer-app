import { useEffect, useState } from "react";
import { usePersistedFlag } from "../pages/collection/useCollectionDisplayPrefs";

// Experimental: the viewer shows a photo's HDR copy (an Ultra HDR JPEG's gain map kept, made by
// /api/photos/:id/hdr) on a screen that reports HDR. Off unless turned on in Settings > General.

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

/** The HDR copy to try for a viewer slide, or null to keep the SDR image. Only the signed-in
 *  owner's own photos qualify; share links and reference photos never do. */
export function hdrUrlFor(url: string, on: boolean, screenIsHdr: boolean): string | null {
  if (!on || !screenIsHdr) return null;
  const id = /^\/api\/photos\/([^/?#]+)\/display$/.exec(url)?.[1];
  return id ? `/api/photos/${id}/hdr` : null;
}

// HDR copies that failed (no gain map, drive away): not asked for again until a reload.
const failed = new Set<string>();

/** The HDR copy of the slide once it has decoded, else null so the SDR image stays shown. */
export function useHdrPhoto(url: string): string | null {
  const [on] = useHdrViewerSetting();
  const want = hdrUrlFor(url, on, useHdrScreen());
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
