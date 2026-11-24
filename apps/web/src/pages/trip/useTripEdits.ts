import { useCallback, useState } from "react";
import { api, apiPath } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { useDeleteCaptures } from "../../hooks/useDeleteCaptures";
import type { useSelectMode } from "../../hooks/useSelectMode";
import { errorMessage } from "../../lib/errorMessage";
import type { TripDetail, TripPhoto } from "./types";

// Changes to the trip and its photos from this page: name, description and cover, rating photos,
// plus deleting photos one at a time or from select mode. Each reloads the trip afterwards.
export function useTripEdits({
  id,
  load,
  photos,
  select,
  closeMenu,
}: {
  id: string | undefined;
  load: () => Promise<void>;
  photos: TripPhoto[] | null;
  /** The photo grid's select mode (separate from the review rows' selection), shared with the Gallery. */
  select: ReturnType<typeof useSelectMode<TripPhoto>>;
  closeMenu: () => void;
}) {
  const toast = useToast();
  const [settingCover, setSettingCover] = useState<string | null>(null);
  const [croppingCoverPhotoUrl, setCroppingCoverPhotoUrl] = useState<string | null>(null);
  const { selectMode, setSelectMode, selectedIds: selectedCaptureIds, exit: exitSelectMode } = select;

  async function setCover(captureId: string | null) {
    if (!id) return;
    closeMenu();
    setSettingCover(captureId);
    try {
      await api.put(apiPath("/trips/{id}/cover", { id }), { captureId });
      void load();
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't change the trip cover"));
    } finally {
      setSettingCover(null);
    }
  }

  // A new cover opens straight into the crop editor, since positioning it is the next step anyway.
  async function setCoverAndEdit(captureId: string, photoUrl: string) {
    if (!id) return;
    closeMenu();
    setSettingCover(captureId);
    try {
      await api.put(apiPath("/trips/{id}/cover", { id }), { captureId });
      await load();
      setCroppingCoverPhotoUrl(photoUrl);
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't change the trip cover"));
    } finally {
      setSettingCover(null);
    }
  }

  async function saveCoverCrop(crop: { x: number; y: number; size: number }) {
    if (!id) return;
    await api.patch(apiPath("/trips/{id}/cover-crop", { id }), crop);
    void load();
  }

  async function resetCoverCrop() {
    if (!id) return;
    await api.patch(apiPath("/trips/{id}/cover-crop", { id }), { reset: true });
    void load();
  }

  const { deletePhoto, deleteSelected } = useDeleteCaptures({
    select,
    onDeleted: () => void load(),
    reload: () => void load(),
  });

  // Stable, since the Lightbox slides are built from it.
  const rateCapture = useCallback(
    async (captureId: string, rating: number | null) => {
      try {
        await api.patch(apiPath("/captures/{id}/rating", { id: captureId }), { rating });
        void load();
      } catch (err) {
        toast.error(errorMessage(err, "Couldn't save that rating"));
      }
    },
    [load, toast],
  );

  // A RAW beside an edited original; a RAW-only photo is its RAW, so deleting it removes the RAW anyway.
  const selectedHaveRaw = (photos ?? []).some(
    (p) => selectedCaptureIds.has(p.captureId) && p.hasRaw && p.originalKind !== "raw",
  );

  async function patchTrip(patch: Partial<Pick<TripDetail, "name" | "description" | "coverLayout">>, failure: string) {
    if (!id) return;
    try {
      await api.patch(apiPath("/trips/{id}", { id }), patch);
      void load();
    } catch (err) {
      toast.error(errorMessage(err, failure));
    }
  }

  function saveName(name: string) {
    if (name) void patchTrip({ name }, "Couldn't rename this trip");
  }

  function saveDescription(description: string) {
    void patchTrip({ description }, "Couldn't save the description");
  }

  function setCoverLayout(coverLayout: "single" | "quad") {
    void patchTrip({ coverLayout }, "Couldn't change the cover style");
  }

  return {
    settingCover,
    setCover,
    setCoverAndEdit,
    croppingCoverPhotoUrl,
    setCroppingCoverPhotoUrl,
    saveCoverCrop,
    resetCoverCrop,
    saveName,
    saveDescription,
    setCoverLayout,
    rateCapture,
    selectMode,
    setSelectMode,
    selectedCaptureIds,
    exitSelectMode,
    selectedHaveRaw,
    deletePhoto,
    deleteSelected,
  };
}

export type TripEdits = ReturnType<typeof useTripEdits>;
