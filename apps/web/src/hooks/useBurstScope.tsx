import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import Checkbox from "../components/Checkbox";
import { apiPath } from "../api/client";
import { useApiRoute } from "../lib/resource";
import { usePersistedState } from "./usePersistedState";
import type { GalleryItem } from "../pages/gallery/types";

/** Edits a burst usually shares: one moment, one place, one subject. */
export type BurstEdit = "coordinates" | "date" | "species";

/** Which photos an edit in the viewer applies to: the open photo, or its whole burst when the
 *  user leaves "Apply to all" ticked. The burst comes from the scene the viewer's strip already
 *  loads (the user's own photos, not in the Trash or hidden). `already` says how many frames have
 *  the value already, under the checkbox. */
export function useBurstScope(
  kind: BurstEdit,
  captureId: string | null | undefined,
  already?: { has: (frame: GalleryItem) => boolean; text: (count: number) => string },
): { ids: string[]; control: ReactNode } {
  const { t } = useTranslation();
  // On by default: a burst is one moment in one place, of one subject. The last choice is kept.
  const [all, setAll] = usePersistedState<boolean>(`burstApply.${kind}`, true);
  const scene = useApiRoute(captureId ? apiPath("/captures/{id}/scene", { id: captureId }) : null).data;
  if (!captureId) return { ids: [], control: null };
  const inBurst = new Set(scene?.burst ?? []);
  const frames = (scene?.scene ?? []).flatMap((b) => b.frames).filter((f) => inBurst.has(f.captureId));
  if (frames.length < 2) return { ids: [captureId], control: null };
  const having = already ? frames.filter(already.has).length : 0;
  return {
    ids: all ? frames.map((f) => f.captureId) : [captureId],
    control: (
      <Checkbox checked={all} onChange={setAll} description={already && having > 0 ? already.text(having) : undefined}>
        {t("bursts.apply.label", { count: frames.length })}
      </Checkbox>
    ),
  };
}
