import { useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import type { TripDetail, TripPhoto } from "./types";

// Changes to the trip and its photos from this page: name, description and cover, plus deleting
// photos one at a time or from select mode. Each reloads the trip afterwards.
export function useTripEdits({
  id,
  load,
  photos,
  closeMenu,
}: {
  id: string | undefined;
  load: () => Promise<void>;
  photos: TripPhoto[] | null;
  closeMenu: () => void;
}) {
  const toast = useToast();
  const [settingCover, setSettingCover] = useState<string | null>(null);
  const [croppingCoverPhotoUrl, setCroppingCoverPhotoUrl] = useState<string | null>(null);
  // Photo-grid multi-select (separate from the review rows' selection). Trips have no videos or
  // per-photo tags, so the filters are just top rated, RAW and a date range.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedCaptureIds, setSelectedCaptureIds] = useState<Set<string>>(new Set());
  const [confirmingDeleteCaptureId, setConfirmingDeleteCaptureId] = useState<string | null>(null);
  const [confirmingBatchDelete, setConfirmingBatchDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteRawToo, setDeleteRawToo] = useState(false);

  async function setCover(captureId: string | null) {
    if (!id) return;
    closeMenu();
    setSettingCover(captureId);
    try {
      await api.put(`/trips/${id}/cover`, { captureId });
      void load();
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't change the featured photo"));
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
      await api.put(`/trips/${id}/cover`, { captureId });
      await load();
      setCroppingCoverPhotoUrl(photoUrl);
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't change the featured photo"));
    } finally {
      setSettingCover(null);
    }
  }

  async function saveCoverCrop(crop: { x: number; y: number; size: number }) {
    await api.patch(`/trips/${id}/cover-crop`, crop);
    void load();
  }

  async function resetCoverCrop() {
    await api.patch(`/trips/${id}/cover-crop`, { reset: true });
    void load();
  }

  async function confirmDeletePhoto(captureId: string) {
    setDeleting(true);
    try {
      await api.delete(`/captures/${captureId}`);
      setConfirmingDeleteCaptureId(null);
      void load();
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't delete that photo"));
    } finally {
      setDeleting(false);
    }
  }

  function toggleSelected(captureId: string) {
    setSelectedCaptureIds((prev) => {
      const next = new Set(prev);
      if (next.has(captureId)) next.delete(captureId);
      else next.add(captureId);
      return next;
    });
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelectedCaptureIds(new Set());
  }

  const selectedHaveRaw = (photos ?? []).some((p) => selectedCaptureIds.has(p.captureId) && p.hasRaw);

  function closeBatchDelete() {
    setConfirmingBatchDelete(false);
    setDeleteRawToo(false);
  }

  async function confirmDeleteSelected() {
    setDeleting(true);
    try {
      await api.post("/captures/batch-delete", {
        captureIds: [...selectedCaptureIds],
        deleteRaw: deleteRawToo,
      });
      setConfirmingBatchDelete(false);
      setDeleteRawToo(false);
      exitSelectMode();
      void load();
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't delete those photos"));
    } finally {
      setDeleting(false);
    }
  }

  async function patchTrip(patch: Partial<Pick<TripDetail, "name" | "description" | "coverLayout">>, failure: string) {
    if (!id) return;
    try {
      await api.patch(`/trips/${id}`, patch);
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
    selectMode,
    setSelectMode,
    selectedCaptureIds,
    toggleSelected,
    exitSelectMode,
    selectedHaveRaw,
    confirmingDeleteCaptureId,
    setConfirmingDeleteCaptureId,
    confirmDeletePhoto,
    confirmingBatchDelete,
    setConfirmingBatchDelete,
    closeBatchDelete,
    confirmDeleteSelected,
    deleting,
    deleteRawToo,
    setDeleteRawToo,
  };
}

export type TripEdits = ReturnType<typeof useTripEdits>;
