import { useCallback, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { NavigateFunction } from "react-router-dom";
import { api, ApiError } from "../../api/client";
import { useEnterToConfirm } from "../../hooks/useEnterToConfirm";
import { useToast } from "../../hooks/useToast";
import type { useSelectMode } from "../../hooks/useSelectMode";
import { errorMessage } from "../../lib/errorMessage";
import { withFeatured } from "./galleryHelpers";
import type { GalleryItem } from "./types";

// Every change the Gallery makes to photos: dates, ratings, tags, featured, species, deleting, and
// adding the selection to the album being picked for. Edits update the loaded items first; a
// failure, or a change the listing can't patch locally, reloads it in place.
export function useGalleryEdits({
  setItems,
  setTotal,
  load,
  loadRef,
  select,
  targetAlbumId,
  navigate,
  closeMenu,
  tagOptions,
  setTagOptions,
}: {
  setItems: Dispatch<SetStateAction<GalleryItem[] | null>>;
  setTotal: Dispatch<SetStateAction<number | null>>;
  load: (opts?: { keepLoaded?: boolean }) => void;
  loadRef: RefObject<(opts?: { keepLoaded?: boolean }) => void>;
  select: ReturnType<typeof useSelectMode<GalleryItem>>;
  targetAlbumId: string | null;
  navigate: NavigateFunction;
  closeMenu: () => void;
  /** Every tag in use, for the tag editors' suggestions; tagging adds to it. */
  tagOptions: string[];
  setTagOptions: Dispatch<SetStateAction<string[]>>;
}) {
  const toast = useToast();
  const { selectMode, selectedIds: selectedCaptureIds, exit: exitSelectModeBase } = select;
  const [confirmingDeleteKey, setConfirmingDeleteKey] = useState<string | null>(null);
  const [addingToAlbumCaptureId, setAddingToAlbumCaptureId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmingBatchDelete, setConfirmingBatchDelete] = useState(false);
  const [deleteRawToo, setDeleteRawToo] = useState(false);
  useEnterToConfirm(
    () => confirmingDeleteKey && void confirmDelete(confirmingDeleteKey),
    !!confirmingDeleteKey && !deleting,
  );
  useEnterToConfirm(() => void confirmDeleteSelected(), confirmingBatchDelete && !deleting);
  const [reassigningCaptureId, setReassigningCaptureId] = useState<string | null>(null);
  const [editingTagsCaptureId, setEditingTagsCaptureId] = useState<string | null>(null);
  const [bulkTags, setBulkTags] = useState<string[]>([]);
  const [batchReassigning, setBatchReassigning] = useState(false);
  const [reassignError, setReassignError] = useState<string | null>(null);
  const [bulkTagError, setBulkTagError] = useState<string | null>(null);

  const [savingDateCaptureId, setSavingDateCaptureId] = useState<string | null>(null);
  const setTakenAt = useCallback(
    async (captureId: string, takenAt: string) => {
      setSavingDateCaptureId(captureId);
      try {
        await api.patch(`/captures/${captureId}/taken-at`, { takenAt: new Date(takenAt).toISOString() });
        // This view is the "missing a date" list, so a fixed item leaves it.
        setItems((prev) => prev?.filter((it) => it.captureId !== captureId) ?? prev);
        setTotal((t) => (t === null ? t : Math.max(0, t - 1)));
      } catch (err) {
        toast.error(errorMessage(err, "Couldn't save that date"));
      } finally {
        setSavingDateCaptureId(null);
      }
    },
    [toast, setItems, setTotal],
  );

  const rateCapture = useCallback(
    async (captureId: string, rating: number | null) => {
      setItems(
        (prev) => prev?.map((it) => (it.captureId === captureId ? { ...it, qualityRating: rating } : it)) ?? prev,
      );
      try {
        await api.patch(`/captures/${captureId}/rating`, { rating });
      } catch (err) {
        toast.error(errorMessage(err, "Couldn't save that rating"));
        loadRef.current({ keepLoaded: true });
      }
    },
    [toast, loadRef, setItems],
  );

  const tagCapture = useCallback(
    async (captureId: string, tags: string[]) => {
      setItems((prev) => prev?.map((it) => (it.captureId === captureId ? { ...it, tags } : it)) ?? prev);
      setTagOptions((prev) => [...new Set([...prev, ...tags])].sort());
      try {
        await api.patch(`/captures/${captureId}/tags`, { tags });
      } catch (err) {
        toast.error(errorMessage(err, "Couldn't save those tags"));
        loadRef.current({ keepLoaded: true });
      }
    },
    [toast, loadRef, setItems, setTagOptions],
  );

  async function toggleFeatured(item: GalleryItem) {
    const featuring = !item.isFeatured;
    setItems((prev) => (prev ? withFeatured(prev, item, featuring) : prev));
    try {
      await api.patch(`/species/${item.speciesId}/cover`, { photoId: featuring ? item.photoId : null });
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't update the featured photo"));
      loadRef.current({ keepLoaded: true });
    }
  }

  async function revealInFinder(path: string) {
    closeMenu();
    try {
      await api.post("/originals/reveal", { path });
    } catch {
      toast.error("Couldn't reveal that file. It may be unavailable.");
    }
  }

  async function confirmDelete(captureId: string) {
    setDeleting(true);
    try {
      await api.delete(`/captures/${captureId}`);
      setConfirmingDeleteKey(null);
      setItems((prev) => prev?.filter((it) => it.captureId !== captureId) ?? prev);
      setTotal((t) => (t === null ? t : Math.max(0, t - 1)));
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't delete that photo"));
    } finally {
      setDeleting(false);
    }
  }

  // In the album picker, leaving select mode goes back to the album.
  function exitSelectMode() {
    setBulkTags([]);
    setBulkTagError(null);
    if (targetAlbumId) {
      navigate(`/albums/${targetAlbumId}`);
      return;
    }
    exitSelectModeBase();
  }

  function requestBatchDelete() {
    if (selectMode && selectedCaptureIds.size > 0) setConfirmingBatchDelete(true);
  }

  const [addingToTargetAlbum, setAddingToTargetAlbum] = useState(false);
  async function addSelectedToTargetAlbum() {
    if (!targetAlbumId) return;
    setAddingToTargetAlbum(true);
    try {
      await api.post(`/albums/${targetAlbumId}/captures`, { captureIds: [...selectedCaptureIds] });
      navigate(`/albums/${targetAlbumId}`);
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't add those photos to the album"));
    } finally {
      setAddingToTargetAlbum(false);
    }
  }

  function closeBatchDelete() {
    setConfirmingBatchDelete(false);
    setDeleteRawToo(false);
  }

  async function confirmDeleteSelected() {
    setDeleting(true);
    const ids = new Set(selectedCaptureIds);
    try {
      await api.post("/captures/batch-delete", { captureIds: [...ids], deleteRaw: deleteRawToo });
      closeBatchDelete();
      exitSelectMode();
      setItems((prev) => prev?.filter((it) => !ids.has(it.captureId)) ?? prev);
      setTotal((t) => (t === null ? t : Math.max(0, t - ids.size)));
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't delete those photos"));
    } finally {
      setDeleting(false);
    }
  }

  async function reassignSpecies(captureId: string, newSpeciesId: string) {
    setReassigningCaptureId(null);
    closeMenu();
    setReassignError(null);
    try {
      await api.patch(`/captures/${captureId}/reassign`, { speciesId: newSpeciesId });
      load({ keepLoaded: true });
    } catch (err) {
      setReassignError(err instanceof ApiError ? err.message : "Couldn't reassign this photo");
    }
  }

  // No batch endpoint: one PATCH per selected photo.
  async function reassignSelected(newSpeciesId: string) {
    setBatchReassigning(true);
    setReassignError(null);
    try {
      const results = await Promise.allSettled(
        [...selectedCaptureIds].map((captureId) =>
          api.patch(`/captures/${captureId}/reassign`, { speciesId: newSpeciesId }),
        ),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) setReassignError(`${failed} of ${results.length} photos couldn't be reassigned`);
      exitSelectMode();
      load({ keepLoaded: true });
    } finally {
      setBatchReassigning(false);
    }
  }

  // Only newly added tags are sent; bulkTags is this session's running list.
  function changeBulkTags(tags: string[]) {
    const added = tags.filter((t) => !bulkTags.includes(t));
    setBulkTags(tags);
    setBulkTagError(null);
    if (added.length > 0) {
      api
        .patch("/captures/tags", { captureIds: [...selectedCaptureIds], tags: added })
        .then(() => setTagOptions((prev) => [...new Set([...prev, ...added])].sort()))
        .catch((err) => {
          // Drop the chip again so a failed tag doesn't read as applied.
          setBulkTags((prev) => prev.filter((t) => !added.includes(t)));
          setBulkTagError(errorMessage(err, "Couldn't add that tag"));
        });
    }
  }

  return {
    tagOptions,
    savingDateCaptureId,
    setTakenAt,
    rateCapture,
    tagCapture,
    toggleFeatured,
    revealInFinder,
    reassigningCaptureId,
    setReassigningCaptureId,
    editingTagsCaptureId,
    setEditingTagsCaptureId,
    reassignSpecies,
    addingToAlbumCaptureId,
    setAddingToAlbumCaptureId,
    exitSelectMode,
    requestBatchDelete,
    addingToTargetAlbum,
    addSelectedToTargetAlbum,
    bulk: { tags: bulkTags, changeTags: changeBulkTags, reassignSelected, batchReassigning },
    reassignError,
    bulkTagError,
    deleting,
    single: { captureId: confirmingDeleteKey, request: setConfirmingDeleteKey, confirm: confirmDelete },
    batch: {
      open: confirmingBatchDelete,
      setOpen: setConfirmingBatchDelete,
      close: closeBatchDelete,
      confirm: confirmDeleteSelected,
      deleteRawToo,
      setDeleteRawToo,
    },
  };
}

export type GalleryEdits = ReturnType<typeof useGalleryEdits>;
