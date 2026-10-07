import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import type { useSelectMode } from "../../hooks/useSelectMode";
import type { SpeciesCapture } from "./types";

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// Every change the species photo grid makes to its captures, one at a time from a tile's menu or
// in bulk from select mode. Most update the page's copy first, then save; `load` re-reads the
// species where the server computes something (the best shot, region names) or a save failed.
export function useCaptureEdits({
  speciesId,
  load,
  updateCaptures,
  select,
  closeMenu,
}: {
  speciesId: string;
  load: () => void;
  updateCaptures: (ids: Iterable<string>, patch: (c: SpeciesCapture) => Partial<SpeciesCapture>) => void;
  select: ReturnType<typeof useSelectMode<SpeciesCapture>>;
  closeMenu: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { selectMode, selectedIds, setSelectedIds, clear: clearSelection, exit: exitSelect } = select;
  const [tagOptions, setTagOptions] = useState<string[]>([]);
  const [bulkTags, setBulkTags] = useState<string[]>([]);
  const [batchReassigning, setBatchReassigning] = useState(false);
  const [reassignError, setReassignError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteRawToo, setDeleteRawToo] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api
      .get<{ tags: string[] }>("/captures/tags", { signal: controller.signal })
      .then((res) => setTagOptions(res.tags))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const addTagOptions = useCallback((tags: string[]) => {
    setTagOptions((prev) => [...new Set([...prev, ...tags])].sort());
  }, []);

  const exitSelectMode = useCallback(() => {
    exitSelect();
    setBulkTags([]);
  }, [exitSelect]);

  const rateCapture = useCallback(
    async (captureId: string, rating: number | null) => {
      updateCaptures([captureId], () => ({ quality_rating: rating }));
      try {
        await api.patch(`/captures/${captureId}/rating`, { rating });
      } catch (err) {
        toast.error(errorText(err, t("species.edits.ratingFailed")));
      }
      // Refreshes the server-computed "best shot", or undoes the optimistic rating on failure.
      load();
    },
    [updateCaptures, toast, load, t],
  );

  const tagCapture = useCallback(
    async (captureId: string, tags: string[]) => {
      addTagOptions(tags);
      updateCaptures([captureId], () => ({ tags }));
      try {
        await api.patch(`/captures/${captureId}/tags`, { tags });
      } catch (err) {
        toast.error(errorText(err, t("species.edits.tagsFailed")));
        load();
      }
    },
    [addTagOptions, updateCaptures, toast, load, t],
  );

  const setCaptureRegion = useCallback(
    async (captureId: string, regionId: string | null) => {
      updateCaptures([captureId], () => ({ region_id: regionId }));
      try {
        await api.patch(`/captures/${captureId}/region`, { regionId });
      } catch (err) {
        toast.error(errorText(err, t("species.edits.locationFailed")));
        load();
      }
    },
    [updateCaptures, toast, load, t],
  );

  const setCaptureLocationLabel = useCallback(
    async (captureId: string, locationLabel: string) => {
      updateCaptures([captureId], () => ({ location_label: locationLabel.trim() || null }));
      try {
        await api.patch(`/captures/${captureId}/region`, { locationLabel });
      } catch (err) {
        toast.error(errorText(err, t("species.edits.placeNameFailed")));
        load();
      }
    },
    [updateCaptures, toast, load, t],
  );

  async function setCover(photoId: string) {
    closeMenu();
    try {
      await api.patch(`/species/${speciesId}/cover`, { photoId });
      load();
    } catch (err) {
      toast.error(errorText(err, t("species.edits.featuredFailed")));
    }
  }

  async function revealInFinder(path: string) {
    closeMenu();
    try {
      await api.post("/originals/reveal", { path });
    } catch {
      toast.error(t("species.edits.revealFailed"));
    }
  }

  async function copyPath(path: string) {
    closeMenu();
    try {
      await navigator.clipboard.writeText(path);
      toast.success(t("species.edits.pathCopied"));
    } catch {
      toast.error(t("species.edits.copyPathFailed"));
    }
  }

  // Marks a photo as also containing another species; it then shows on that species' page too.
  async function tagSpecies(captureId: string, otherSpeciesId: string) {
    closeMenu();
    try {
      await api.post(`/captures/${captureId}/species`, { speciesId: otherSpeciesId });
      load();
    } catch (err) {
      toast.error(errorText(err, t("species.edits.tagSpeciesFailed")));
    }
  }

  async function reassignSpecies(captureId: string, newSpeciesId: string) {
    closeMenu();
    setReassignError(null);
    try {
      await api.patch(`/captures/${captureId}/reassign`, { speciesId: newSpeciesId });
      load();
    } catch (err) {
      setReassignError(errorText(err, t("species.edits.reassignFailed")));
    }
  }

  // No batch endpoint: reassignment batches are small and interactive.
  async function reassignSelected(newSpeciesId: string) {
    setBatchReassigning(true);
    setReassignError(null);
    try {
      const results = await Promise.allSettled(
        [...selectedIds].map((captureId) => api.patch(`/captures/${captureId}/reassign`, { speciesId: newSpeciesId })),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) setReassignError(t("species.edits.reassignSomeFailed", { failed, total: results.length }));
      exitSelectMode();
      load();
    } finally {
      setBatchReassigning(false);
    }
  }

  async function addBulkTags(tags: string[]) {
    const added = tags.filter((t) => !bulkTags.includes(t));
    setBulkTags(tags);
    if (added.length === 0) return;
    const ids = [...selectedIds];
    try {
      await api.patch("/captures/tags", { captureIds: ids, tags: added });
      addTagOptions(added);
      updateCaptures(ids, (c) => ({ tags: [...new Set([...c.tags, ...added])] }));
    } catch (err) {
      toast.error(errorText(err, t("species.edits.addTagFailed")));
    }
  }

  // Single-photo delete shares the batch dialog so the trash wording lives in one place.
  function requestDeleteCapture(captureId: string) {
    closeMenu();
    setSelectedIds(new Set([captureId]));
    setConfirmingDelete(true);
  }

  function cancelDelete() {
    setConfirmingDelete(false);
    setDeleteRawToo(false);
    if (!selectMode) clearSelection();
  }

  async function confirmDeleteSelected() {
    if (deleting) return;
    setDeleting(true);
    try {
      await api.post("/captures/batch-delete", { captureIds: [...selectedIds], deleteRaw: deleteRawToo });
      setConfirmingDelete(false);
      setDeleteRawToo(false);
      exitSelectMode();
      load();
    } catch (err) {
      toast.error(errorText(err, t("species.edits.deleteFailed")));
    } finally {
      setDeleting(false);
    }
  }

  function onDeleteDialogKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || e.defaultPrevented) return;
    if ((e.target as HTMLElement).tagName === "BUTTON") return;
    e.preventDefault();
    void confirmDeleteSelected();
  }

  return {
    tagOptions,
    bulkTags,
    batchReassigning,
    reassignError,
    exitSelectMode,
    rateCapture,
    tagCapture,
    setCaptureRegion,
    setCaptureLocationLabel,
    setCover,
    revealInFinder,
    copyPath,
    tagSpecies,
    reassignSpecies,
    reassignSelected,
    addBulkTags,
    requestDeleteCapture,
    deleteDialog: {
      open: confirmingDelete,
      setOpen: setConfirmingDelete,
      cancel: cancelDelete,
      confirm: confirmDeleteSelected,
      onKeyDown: onDeleteDialogKeyDown,
      deleting,
      deleteRawToo,
      setDeleteRawToo,
    },
  };
}

export type CaptureEdits = ReturnType<typeof useCaptureEdits>;
