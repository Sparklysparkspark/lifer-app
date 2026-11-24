import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { api, apiPath, ApiError } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { useDeleteCaptures } from "../../hooks/useDeleteCaptures";
import type { useSelectMode } from "../../hooks/useSelectMode";
import type { SpeciesCapture } from "./types";
import { ignore } from "../../lib/ignore";
import { useSpeciesName } from "../../lib/speciesName";
import type { SpeciesResult } from "../../components/SpeciesPicker";

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
  const navigate = useNavigate();
  const speciesName = useSpeciesName();
  const { selectMode, selectedIds, exit: exitSelect } = select;
  const [tagOptions, setTagOptions] = useState<string[]>([]);
  const [bulkTags, setBulkTags] = useState<string[]>([]);
  const [batchReassigning, setBatchReassigning] = useState(false);
  const [reassignError, setReassignError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .get("/captures/tags", { signal: controller.signal })
      .then((res) => setTagOptions(res.tags))
      .catch(ignore("Couldn't load tags"));
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
        await api.patch(apiPath("/captures/{id}/rating", { id: captureId }), { rating });
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
        await api.patch(apiPath("/captures/{id}/tags", { id: captureId }), { tags });
      } catch (err) {
        toast.error(errorText(err, t("species.edits.tagsFailed")));
        load();
      }
    },
    [addTagOptions, updateCaptures, toast, load, t],
  );

  // shortcut: one PATCH per photo, fine for an interactive selection; add a batch endpoint if it's slow.
  async function rateSelected(rating: number | null) {
    const ids = [...selectedIds];
    updateCaptures(ids, () => ({ quality_rating: rating }));
    const results = await Promise.allSettled(
      ids.map((captureId) => api.patch(apiPath("/captures/{id}/rating", { id: captureId }), { rating })),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) toast.error(t("species.edits.rateSomeFailed", { failed, total: ids.length }));
    load();
  }

  async function hide(captureIds: string[]) {
    closeMenu();
    try {
      const res = await api.post("/captures/hide", { captureIds });
      if (selectMode) exitSelectMode();
      load();
      const undo = () =>
        void api
          .post("/captures/unhide", { captureIds })
          // Put back the featured photos the hide moved off.
          .then(() =>
            Promise.allSettled(
              res.covers.map((c) =>
                api.patch(apiPath("/species/{id}/cover", { id: c.speciesId }), { photoId: c.photoId }),
              ),
            ),
          )
          .then(load)
          .catch((err) => toast.error(errorText(err, t("species.edits.unhideFailed"))));
      toast.show(
        captureIds.length === 1 ? t("species.edits.hidden") : t("species.edits.hiddenMany", { count: res.hidden }),
        { tone: "success", actions: [{ label: t("species.edits.undo"), onClick: undo }] },
      );
    } catch (err) {
      toast.error(errorText(err, t("species.edits.hideFailed")));
    }
  }

  // shortcut: undo moves the photos back to this page's species, which for a photo listed here only
  // as "also features" was a secondary tag, not its species; send the old species if that matters.
  function showMoved(captureIds: string[], to: SpeciesResult) {
    const undo = () =>
      void Promise.allSettled(
        captureIds.map((id) => api.patch(apiPath("/captures/{id}/reassign", { id }), { speciesId })),
      ).then((results) => {
        if (results.some((r) => r.status === "rejected")) toast.error(t("species.edits.moveBackFailed"));
        load();
      });
    const name = speciesName(to);
    toast.show(
      captureIds.length === 1
        ? t("species.edits.movedTo", { species: name })
        : t("species.edits.movedMany", { count: captureIds.length, species: name }),
      {
        tone: "success",
        actions: [
          { label: t("species.edits.view"), onClick: () => navigate(`/species/${to.id}`) },
          { label: t("species.edits.undo"), onClick: undo },
        ],
      },
    );
  }

  // Null goes back to the automatic choice.
  async function setCover(photoId: string | null) {
    closeMenu();
    try {
      await api.patch(apiPath("/species/{id}/cover", { id: speciesId }), { photoId });
      load();
    } catch (err) {
      toast.error(errorText(err, t("species.edits.featuredFailed")));
    }
  }

  // Marks a photo as also containing another species; it then shows on that species' page too.
  async function tagSpecies(captureId: string, otherSpeciesId: string) {
    closeMenu();
    try {
      await api.post(apiPath("/captures/{id}/species", { id: captureId }), { speciesId: otherSpeciesId });
      load();
    } catch (err) {
      toast.error(errorText(err, t("species.edits.tagSpeciesFailed")));
    }
  }

  async function reassignSpecies(captureId: string, to: SpeciesResult) {
    closeMenu();
    setReassignError(null);
    try {
      await api.patch(apiPath("/captures/{id}/reassign", { id: captureId }), { speciesId: to.id });
      load();
      showMoved([captureId], to);
    } catch (err) {
      setReassignError(errorText(err, t("species.edits.reassignFailed")));
    }
  }

  // No batch endpoint: reassignment batches are small and interactive.
  async function reassignSelected(to: SpeciesResult) {
    setBatchReassigning(true);
    setReassignError(null);
    const ids = [...selectedIds];
    try {
      const results = await Promise.allSettled(
        ids.map((captureId) => api.patch(apiPath("/captures/{id}/reassign", { id: captureId }), { speciesId: to.id })),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) setReassignError(t("species.edits.reassignSomeFailed", { failed, total: results.length }));
      exitSelectMode();
      load();
      const moved = ids.filter((_, i) => results[i].status === "fulfilled");
      if (moved.length > 0) showMoved(moved, to);
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

  const { deletePhoto, deleteSelected } = useDeleteCaptures({ select, exitSelectMode, onDeleted: load, reload: load });

  return {
    tagOptions,
    bulkTags,
    batchReassigning,
    reassignError,
    exitSelectMode,
    rateCapture,
    rateSelected,
    hide,
    hideSelected: () => hide([...selectedIds]),
    tagCapture,
    setCover,
    tagSpecies,
    reassignSpecies,
    reassignSelected,
    addBulkTags,
    deletePhoto,
    deleteSelected,
  };
}

export type CaptureEdits = ReturnType<typeof useCaptureEdits>;
