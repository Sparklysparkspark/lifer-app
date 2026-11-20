// Moved photos (Settings > Storage, MovedPhotosTray): shared events, Undo and trip folder offers.
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath, type ApiResponse } from "../api/client";
import { errorMessage } from "../lib/errorMessage";
import { ignore } from "../lib/ignore";
import { useToast } from "./useToast";

export type MovedPhotosStatus = ApiResponse<"/moved-photos/status">;

/** Fired by whoever starts a look, so the tray follows it at once. */
export const MOVED_PHOTOS_LOOK_STARTED = "lifer:moved-photos-look-started";
/** Fired when stored paths changed (relinked or undone), so pages showing them reload. */
export const MOVED_PHOTOS_CHANGED = "lifer:moved-photos-changed";

/** Navigation state that opens the review list in Settings > Storage. */
export const OPEN_REVIEW = "openMovedPhotosReview";

export const movedPhotosChanged = () => window.dispatchEvent(new Event(MOVED_PHOTOS_CHANGED));

/** Undo for a set of relinks, shared by the toast and the log in Settings. */
export function useUndoRelinks() {
  const { t } = useTranslation();
  const toast = useToast();
  return useCallback(
    async (batchId: string) => {
      try {
        await api.post(apiPath("/moved-photos/batches/{id}/undo", { id: batchId }));
        movedPhotosChanged();
        toast.info(t("movedPhotos.undone"));
      } catch (err) {
        toast.error(errorMessage(err, t("movedPhotos.undoFailed")));
      }
    },
    [t, toast],
  );
}

/** "Use it" for a trip whose folder moved: one click, with Undo. */
export function useTripFolderActions() {
  const { t } = useTranslation();
  const toast = useToast();
  const undo = useUndoRelinks();
  const accept = useCallback(
    async (tripId: string) => {
      try {
        const res = await api.post(apiPath("/moved-photos/trip-folders/{id}/use", { id: tripId }));
        movedPhotosChanged();
        toast.show(t("movedPhotos.tripFolderUsed"), {
          tone: "success",
          actions: [{ label: t("movedPhotos.undo"), onClick: () => void undo(res.batchId) }],
        });
      } catch (err) {
        toast.error(errorMessage(err, t("movedPhotos.failed")));
      }
    },
    [t, toast, undo],
  );
  const dismiss = useCallback(async (tripId: string) => {
    await api
      .post(apiPath("/moved-photos/trip-folders/{id}/dismiss", { id: tripId }))
      .catch(ignore("Couldn't dismiss a trip folder offer"));
    movedPhotosChanged();
  }, []);
  return { accept, dismiss };
}
