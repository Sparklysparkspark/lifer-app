import { useCallback, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { dateOnlyToTakenAt } from "@lifer/shared";
import type { useGoBack } from "../../hooks/useGoBack";
import { api, apiPath } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { useDeleteCaptures } from "../../hooks/useDeleteCaptures";
import type { useSelectMode } from "../../hooks/useSelectMode";
import { errorMessage } from "../../lib/errorMessage";
import { downloadFile, pickDownloadFolder } from "../../lib/downloadFile";
import { pluralize } from "../../lib/pluralize";
import { useSpeciesName } from "../../lib/speciesName";
import type { SpeciesResult } from "../../components/SpeciesPicker";
import type { CaptureEdit } from "../../components/CaptureEditModal";
import { withFeatured } from "./galleryHelpers";
import type { GalleryItem } from "./types";

// Every change the Gallery makes to photos: dates, ratings, tags, featured photo, species, hiding,
// deleting, downloading, and adding the selection to the album being picked for. Edits update the
// loaded items first; a failure, or a change the listing can't patch locally, reloads it in place.
export function useGalleryEdits({
  items,
  setItems,
  setTotal,
  load,
  loadRef,
  select,
  targetAlbumId,
  goBack,
  closeMenu,
  tagOptions,
  setTagOptions,
  refreshHiddenCount,
  fetchOriginals,
}: {
  /** The loaded photos; select all can pick photos not loaded yet, which only the server knows. */
  items: GalleryItem[] | null;
  setItems: Dispatch<SetStateAction<GalleryItem[] | null>>;
  setTotal: Dispatch<SetStateAction<number | null>>;
  load: (opts?: { keepLoaded?: boolean }) => void;
  loadRef: RefObject<(opts?: { keepLoaded?: boolean }) => void>;
  select: ReturnType<typeof useSelectMode<GalleryItem>>;
  targetAlbumId: string | null;
  /** The picker is opened from its album, so finishing goes back there rather than stacking a new entry. */
  goBack: ReturnType<typeof useGoBack>;
  closeMenu: () => void;
  /** Every tag in use, for the tag editors' suggestions; tagging adds to it. */
  tagOptions: string[];
  setTagOptions: Dispatch<SetStateAction<string[]>>;
  /** The "Hidden" filter only shows while there are hidden photos. */
  refreshHiddenCount: () => void;
  /** Every matching photo's original, for selected photos not loaded yet. */
  fetchOriginals: () => Promise<Array<{ captureId: string; photoId: string; kind: string }>>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const speciesName = useSpeciesName();
  const { selectMode, selectedIds: selectedCaptureIds, exit: exitSelectModeBase } = select;
  const [addingToAlbumCaptureId, setAddingToAlbumCaptureId] = useState<string | null>(null);
  // A photo menu's Location: the coordinates dialog, as on the map.
  const [placingCaptureId, setPlacingCaptureId] = useState<string | null>(null);
  // A photo menu's edit open in its dialog.
  const [editing, setEditing] = useState<{ captureId: string; edit: CaptureEdit } | null>(null);
  const [bulkTags, setBulkTags] = useState<string[]>([]);
  const [batchReassigning, setBatchReassigning] = useState(false);
  const [reassignError, setReassignError] = useState<string | null>(null);
  const [bulkTagError, setBulkTagError] = useState<string | null>(null);

  const [savingDateCaptureId, setSavingDateCaptureId] = useState<string | null>(null);
  const setTakenAt = useCallback(
    async (captureId: string, takenAt: string) => {
      setSavingDateCaptureId(captureId);
      try {
        await api.patch(apiPath("/captures/{id}/taken-at", { id: captureId }), {
          takenAt: dateOnlyToTakenAt(takenAt) ?? new Date(takenAt).toISOString(),
        });
        // This view is the "missing a date" list, so a fixed item leaves it.
        setItems((prev) => prev?.filter((it) => it.captureId !== captureId) ?? prev);
        setTotal((t) => (t === null ? t : Math.max(0, t - 1)));
      } catch (err) {
        toast.error(errorMessage(err, t("gallery.edits.dateFailed")));
      } finally {
        setSavingDateCaptureId(null);
      }
    },
    [toast, setItems, setTotal, t],
  );

  const rateCapture = useCallback(
    async (captureId: string, rating: number | null) => {
      setItems(
        (prev) => prev?.map((it) => (it.captureId === captureId ? { ...it, qualityRating: rating } : it)) ?? prev,
      );
      try {
        await api.patch(apiPath("/captures/{id}/rating", { id: captureId }), { rating });
      } catch (err) {
        toast.error(errorMessage(err, t("gallery.edits.ratingFailed")));
        loadRef.current({ keepLoaded: true });
      }
    },
    [toast, loadRef, setItems, t],
  );

  // Marks a photo as also showing another species; it then shows on that species' page too.
  async function tagSpecies(captureId: string, otherSpeciesId: string) {
    try {
      await api.post(apiPath("/captures/{id}/species", { id: captureId }), { speciesId: otherSpeciesId });
    } catch (err) {
      toast.error(errorMessage(err, t("species.edits.tagSpeciesFailed")));
    }
  }

  const tagCapture = useCallback(
    async (captureId: string, tags: string[]) => {
      setItems((prev) => prev?.map((it) => (it.captureId === captureId ? { ...it, tags } : it)) ?? prev);
      setTagOptions((prev) => [...new Set([...prev, ...tags])].sort());
      try {
        await api.patch(apiPath("/captures/{id}/tags", { id: captureId }), { tags });
      } catch (err) {
        toast.error(errorMessage(err, t("gallery.edits.tagsFailed")));
        loadRef.current({ keepLoaded: true });
      }
    },
    [toast, loadRef, setItems, setTagOptions, t],
  );

  // shortcut: one PATCH per photo, fine for an interactive selection; add a batch endpoint if it's slow.
  async function rateSelected(rating: number | null) {
    const ids = [...selectedCaptureIds];
    setItems(
      (prev) =>
        prev?.map((it) => (selectedCaptureIds.has(it.captureId) ? { ...it, qualityRating: rating } : it)) ?? prev,
    );
    const results = await Promise.allSettled(
      ids.map((captureId) => api.patch(apiPath("/captures/{id}/rating", { id: captureId }), { rating })),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      toast.error(t("gallery.edits.rateSomeFailed", { failed, count: ids.length }));
      loadRef.current({ keepLoaded: true });
    } else toast.success(t("gallery.edits.rated", { count: ids.length }));
  }

  async function hide(captureIds: string[]) {
    closeMenu();
    try {
      const res = await api.post("/captures/hide", { captureIds });
      const ids = new Set(captureIds);
      setItems((prev) => prev?.filter((it) => !ids.has(it.captureId)) ?? prev);
      setTotal((t) => (t === null ? t : Math.max(0, t - res.hidden)));
      if (selectMode) exitSelectMode();
      refreshHiddenCount();
      toast.show(
        captureIds.length === 1 ? t("gallery.edits.hiddenOne") : t("gallery.edits.hiddenMany", { count: res.hidden }),
        {
          tone: "success",
          actions: [
            {
              label: t("common.undo"),
              onClick: () =>
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
                  .then(() => {
                    refreshHiddenCount();
                    loadRef.current({ keepLoaded: true });
                  })
                  .catch((err) => toast.error(errorMessage(err, t("gallery.edits.unhideFailed")))),
            },
          ],
        },
      );
    } catch (err) {
      toast.error(errorMessage(err, t("gallery.edits.hideFailed")));
    }
  }

  async function downloadSelected() {
    const loaded = items ?? [];
    const chosen = loaded
      .filter((it) => selectedCaptureIds.has(it.captureId) && it.originalRef)
      .map((it) => ({ photoId: it.photoId, kind: it.originalKind }));
    // Select all can pick photos not loaded yet; only the server knows their originals.
    if (selectedCaptureIds.size > loaded.filter((it) => selectedCaptureIds.has(it.captureId)).length) {
      const loadedIds = new Set(loaded.map((it) => it.captureId));
      try {
        const rest = await fetchOriginals();
        chosen.push(...rest.filter((o) => selectedCaptureIds.has(o.captureId) && !loadedIds.has(o.captureId)));
      } catch (err) {
        toast.error(errorMessage(err, t("gallery.edits.originalsFailed")));
        return;
      }
    }
    if (chosen.length === 0) {
      toast.info(t("gallery.edits.noOriginals"));
      return;
    }
    const folder = await pickDownloadFolder();
    if (folder === null) return;
    const id = toast.show(t("gallery.edits.preparingDownloads", { count: chosen.length }), { durationMs: null });
    let failed = 0;
    for (const it of chosen) {
      const raw = it.kind === "raw";
      try {
        await downloadFile(
          `/api/photos/${it.photoId}/${raw ? "original-raw" : "original"}?download=1`,
          raw ? "original.raw" : "original.jpg",
          { folder },
        );
      } catch {
        failed++;
      }
    }
    toast.dismiss(id);
    if (failed > 0) toast.error(t("gallery.edits.downloadsFailed", { failed, count: chosen.length }));
  }

  // A correction can be undone by moving the photos back to the species they came from.
  function showMoved(moved: Array<{ captureId: string; from: string | undefined }>, to: SpeciesResult) {
    const undo = moved.every((m) => m.from)
      ? {
          label: t("common.undo"),
          onClick: () =>
            void Promise.allSettled(
              moved.map((m) =>
                api.patch(apiPath("/captures/{id}/reassign", { id: m.captureId }), { speciesId: m.from! }),
              ),
            ).then((results) => {
              if (results.some((r) => r.status === "rejected")) toast.error(t("gallery.edits.moveBackFailed"));
              loadRef.current({ keepLoaded: true });
            }),
        }
      : null;
    toast.show(
      moved.length === 1
        ? t("gallery.edits.movedOne", { species: speciesName(to) })
        : t("gallery.edits.movedMany", { count: moved.length, species: speciesName(to) }),
      {
        tone: "success",
        actions: [{ label: t("common.view"), onClick: () => navigate(`/species/${to.id}`) }, ...(undo ? [undo] : [])],
      },
    );
  }

  async function toggleFeatured(item: GalleryItem) {
    const featuring = !item.isFeatured;
    setItems((prev) => (prev ? withFeatured(prev, item, featuring) : prev));
    try {
      await api.patch(apiPath("/species/{id}/cover", { id: item.speciesId }), {
        photoId: featuring ? item.photoId : null,
      });
    } catch (err) {
      toast.error(errorMessage(err, t("gallery.edits.featuredFailed")));
      loadRef.current({ keepLoaded: true });
    }
  }

  // In the album picker, leaving select mode goes back to the album.
  function exitSelectMode() {
    setBulkTags([]);
    setBulkTagError(null);
    if (targetAlbumId) {
      goBack(`/albums/${targetAlbumId}`, { replace: true });
      return;
    }
    exitSelectModeBase();
  }

  const [addingToTargetAlbum, setAddingToTargetAlbum] = useState(false);
  async function addSelectedToTargetAlbum() {
    if (!targetAlbumId) return;
    setAddingToTargetAlbum(true);
    try {
      await api.post(apiPath("/albums/{id}/captures", { id: targetAlbumId }), { captureIds: [...selectedCaptureIds] });
      goBack(`/albums/${targetAlbumId}`, { replace: true });
    } catch (err) {
      toast.error(errorMessage(err, t("gallery.edits.addToAlbumFailed")));
    } finally {
      setAddingToTargetAlbum(false);
    }
  }

  const { deletePhoto, deleteSelected } = useDeleteCaptures({
    select,
    exitSelectMode,
    onDeleted: (captureIds) => {
      const ids = new Set(captureIds);
      setItems((prev) => prev?.filter((it) => !ids.has(it.captureId)) ?? prev);
      setTotal((n) => (n === null ? n : Math.max(0, n - ids.size)));
    },
    reload: () => loadRef.current({ keepLoaded: true }),
  });

  /** `captureIds`: the viewer's whole burst, when "Apply to all" is ticked. One message and Undo. */
  async function reassignSpecies(captureId: string, to: SpeciesResult, captureIds: string[] = [captureId]) {
    setEditing(null);
    closeMenu();
    setReassignError(null);
    const from = items?.find((it) => it.captureId === captureId)?.speciesId;
    // A burst frame the grid doesn't list was filed with the open photo: a burst is one subject.
    const fromOf = (id: string) => items?.find((it) => it.captureId === id)?.speciesId ?? from;
    const results = await Promise.allSettled(
      captureIds.map((id) => api.patch(apiPath("/captures/{id}/reassign", { id }), { speciesId: to.id })),
    );
    const moved = captureIds.filter((_, i) => results[i].status === "fulfilled");
    const failed = results.find((r) => r.status === "rejected");
    if (failed && captureIds.length === 1)
      setReassignError(errorMessage(failed.reason, t("gallery.edits.reassignFailed")));
    else if (failed)
      setReassignError(
        t("gallery.edits.reassignSomeFailed", { failed: captureIds.length - moved.length, count: captureIds.length }),
      );
    if (moved.length === 0) return;
    load({ keepLoaded: true });
    showMoved(
      moved.map((id) => ({ captureId: id, from: fromOf(id) })),
      to,
    );
  }

  // No batch endpoint: one PATCH per selected photo.
  async function reassignSelected(to: SpeciesResult) {
    setBatchReassigning(true);
    setReassignError(null);
    const ids = [...selectedCaptureIds];
    const fromById = new Map((items ?? []).map((it) => [it.captureId, it.speciesId]));
    try {
      const results = await Promise.allSettled(
        ids.map((captureId) => api.patch(apiPath("/captures/{id}/reassign", { id: captureId }), { speciesId: to.id })),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) setReassignError(t("gallery.edits.reassignSomeFailed", { failed, count: results.length }));
      exitSelectMode();
      load({ keepLoaded: true });
      const moved = ids.filter((_, i) => results[i].status === "fulfilled");
      if (moved.length > 0)
        showMoved(
          moved.map((captureId) => ({ captureId, from: fromById.get(captureId) })),
          to,
        );
    } finally {
      setBatchReassigning(false);
    }
  }

  const [settingRegion, setSettingRegion] = useState(false);
  async function setRegionSelected(regionId: string, locationLabel = "") {
    const ids = [...selectedCaptureIds];
    const previous = new Map((items ?? []).map((it) => [it.captureId, it.regionId]));
    // Left blank, each photo keeps its own place name.
    const label = locationLabel.trim();
    setSettingRegion(true);
    try {
      const res = await api.post("/captures/location", {
        captureIds: ids,
        regionId,
        ...(label && { locationLabel: label }),
      });
      exitSelectMode();
      load({ keepLoaded: true });
      // Undo puts each photo's old region back, one call per old region. Select all can pick photos
      // not loaded yet, whose old region isn't known here, so then there's no Undo.
      const byPrevious = new Map<string | null, string[]>();
      for (const id of ids) {
        const prev = previous.get(id) ?? null;
        byPrevious.set(prev, [...(byPrevious.get(prev) ?? []), id]);
      }
      // shortcut: no Undo once a place name is set, since gallery items don't carry the old names;
      // add location_label to GalleryItem if that Undo is wanted.
      const undo =
        !label && ids.every((id) => previous.has(id))
          ? {
              label: "Undo",
              onClick: () =>
                void Promise.all(
                  [...byPrevious].map(([prev, captureIds]) =>
                    api.post("/captures/location", { captureIds, regionId: prev }),
                  ),
                )
                  .catch((err) => toast.error(errorMessage(err, "Couldn't put the old regions back")))
                  .finally(() => loadRef.current({ keepLoaded: true })),
            }
          : null;
      toast.show(`Region set on ${pluralize(res.updated, "photo")}`, {
        tone: "success",
        actions: undo ? [undo] : [],
      });
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't set the region"));
    } finally {
      setSettingRegion(false);
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
    tagSpecies,
    toggleFeatured,
    hide,
    editing,
    setEditing,
    reassignSpecies,
    addingToAlbumCaptureId,
    placingCaptureId,
    setPlacingCaptureId,
    setAddingToAlbumCaptureId,
    exitSelectMode,
    /** Reloads the photos in place, e.g. after their dates moved. */
    reload: () => loadRef.current({ keepLoaded: true }),
    deletePhoto,
    deleteSelected,
    addingToTargetAlbum,
    addSelectedToTargetAlbum,
    bulk: {
      tags: bulkTags,
      changeTags: changeBulkTags,
      reassignSelected,
      batchReassigning,
      rate: rateSelected,
      setRegion: setRegionSelected,
      settingRegion,
      download: downloadSelected,
    },
    reassignError,
    bulkTagError,
  };
}

export type GalleryEdits = ReturnType<typeof useGalleryEdits>;
