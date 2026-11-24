import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { AlbumPhoto, CollectionItem } from "@lifer/shared";
import { api, apiPath } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { useApiResource } from "../../lib/resource";
import type { AlbumDetail, AlbumView, Crop } from "./types";

const FIRST_PHOTOS = 200;
/** The album with only its first photos: what the page draws first, and what hovering a card warms. */
export const albumPreviewPath = (id: string) => `/albums/${id}?limit=${FIRST_PHOTOS}`;

// The album, its species (loaded once the species view opens), and every edit to them. Edits
// reload the album afterwards, since the server resolves covers and quad slots.
export function useAlbumDetail(id: string | undefined, view: AlbumView) {
  const { t } = useTranslation();
  const toast = useToast();
  // The first photos arrive in a fraction of a second, while a smart album matching most of the
  // library takes seconds in full; both load at once and the page draws whichever it has.
  const preview = useApiResource<AlbumDetail>(id ? albumPreviewPath(id) : null);
  const albumResource = useApiResource<AlbumDetail>(id ? `/albums/${id}` : null);
  const album = albumResource.data ?? preview.data;
  const setFull = albumResource.setData;
  const setPreview = preview.setData;
  // shortcut: an edit made before the whole album arrives can be undone by that older answer
  // until the next reload; fine while albums open in seconds.
  const setAlbum = useCallback(
    (update: (prev: AlbumDetail | null) => AlbumDetail | null) => {
      setFull(update);
      setPreview(update);
    },
    [setFull, setPreview],
  );
  const loadError = albumResource.error != null;
  // A reload after a change: any earlier error clears while it retries.
  const reloadAlbum = albumResource.reload;
  const load = useCallback(() => void reloadAlbum(), [reloadAlbum]);

  // Loaded once the species view opens.
  const species = useApiResource<{ items: CollectionItem[] }>(
    id && view === "species" ? `/albums/${id}/species` : null,
  );
  const speciesItems = species.data?.items ?? (species.error ? [] : null);
  useEffect(() => {
    if (species.error) toast.error(t("albums.detail.speciesLoadFailed"));
  }, [species.error, toast, t]);

  // Runs an album PATCH, toasts on failure, then reloads. Crop saves skip this so CardCropEditor
  // can show the error and stay open.
  async function saveAndReload(request: () => Promise<unknown>, failure: string) {
    try {
      await request();
    } catch {
      toast.error(failure);
    }
    load();
  }

  // A smart album's rules chose the photos, so taking them out records exclusions instead.
  // Either way the toast's Undo puts them back.
  async function removeFromAlbum(captureIds: string[]) {
    if (!id || captureIds.length === 0) return;
    const smart = !!album?.rules;
    const gone = new Set(captureIds);
    setAlbum((a) =>
      a
        ? {
            ...a,
            items: a.items.filter((i) => !gone.has(i.captureId)),
            excludedCount: a.excludedCount + (smart ? captureIds.length : 0),
          }
        : a,
    );
    try {
      if (smart) await api.post(apiPath("/albums/{id}/exclusions", { id }), { captureIds });
      else {
        // shortcut: one DELETE per photo, as the API has no batch remove; add one if big albums are slow.
        const results = await Promise.allSettled(
          captureIds.map((captureId) => api.delete(apiPath("/albums/{id}/captures/{captureId}", { id, captureId }))),
        );
        if (results.some((r) => r.status === "rejected")) throw new Error("remove failed");
      }
    } catch {
      toast.error(t(smart ? "albums.detail.excludeFailed" : "albums.detail.removeFailed"));
      load();
      return;
    }
    const undo = () =>
      void (
        smart
          ? api.post(apiPath("/albums/{id}/exclusions/restore", { id }), { captureIds })
          : api.post(apiPath("/albums/{id}/captures", { id }), { captureIds })
      )
        .catch(() => toast.error(t("albums.smart.restoreFailed")))
        .finally(load);
    toast.show(t(smart ? "albums.detail.excluded" : "albums.detail.removed", { count: captureIds.length }), {
      tone: "success",
      actions: [{ label: t("common.undo"), onClick: undo }],
    });
  }

  // A photo menu edit, shown at once; the reload that follows brings what the server works out.
  function updateItem(captureId: string, patch: Partial<AlbumPhoto>) {
    setAlbum((a) =>
      a ? { ...a, items: a.items.map((i) => (i.captureId === captureId ? { ...i, ...patch } : i)) } : a,
    );
  }

  async function rateCapture(captureId: string, rating: number | null) {
    setAlbum((a) =>
      a ? { ...a, items: a.items.map((i) => (i.captureId === captureId ? { ...i, qualityRating: rating } : i)) } : a,
    );
    try {
      await api.patch(apiPath("/captures/{id}/rating", { id: captureId }), { rating });
    } catch {
      toast.error(t("albums.detail.ratingFailed"));
      load();
    }
  }

  async function deleteAlbum(): Promise<boolean> {
    if (!id) return false;
    try {
      await api.delete(apiPath("/albums/{id}", { id }));
      return true;
    } catch {
      toast.error(t("albums.detail.deleteFailed"));
      return false;
    }
  }

  async function saveName(name: string) {
    if (!id || !name) return;
    await saveAndReload(() => api.patch(apiPath("/albums/{id}", { id }), { name }), t("albums.detail.renameFailed"));
  }

  async function saveDescription(description: string) {
    if (!id) return;
    await saveAndReload(
      () => api.patch(apiPath("/albums/{id}", { id }), { description }),
      t("albums.detail.descriptionFailed"),
    );
  }

  async function setCoverLayout(coverLayout: "single" | "quad") {
    if (!id) return;
    await saveAndReload(
      () => api.patch(apiPath("/albums/{id}", { id }), { coverLayout }),
      t("albums.detail.coverStyleFailed"),
    );
  }

  /** Null goes back to the automatic cover. */
  async function setCoverPhoto(photoId: string | null) {
    if (!id) return;
    await saveAndReload(
      () => api.patch(apiPath("/albums/{id}", { id }), { coverPhotoId: photoId }),
      t("albums.detail.coverFailed"),
    );
  }

  async function saveCoverCrop(crop: Crop) {
    if (!id) return;
    await api.patch(apiPath("/albums/{id}/cover-crop", { id }), crop);
    load();
  }

  async function resetCoverCrop() {
    if (!id) return;
    await api.patch(apiPath("/albums/{id}/cover-crop", { id }), { reset: true });
    load();
  }

  async function setQuadSlotPhoto(slot: number, photoId: string | null) {
    if (!id) return;
    await saveAndReload(
      () => api.patch(apiPath("/albums/{id}/quad-slot", { id }), { slot, photoId }),
      t("albums.detail.coverTileFailed"),
    );
  }

  async function saveQuadSlotCrop(slot: number, crop: Crop) {
    if (!id) return;
    // Pins the slot to the photo shown, which may be an auto-picked fallback; otherwise the
    // resolver would discard the crop as a mismatch on the next load.
    const photoId = album?.quadSlots[slot]?.photoId ?? null;
    await api.patch(apiPath("/albums/{id}/quad-slot", { id }), { slot, photoId, crop });
    load();
  }

  async function resetQuadSlotCrop(slot: number) {
    if (!id) return;
    await api.patch(apiPath("/albums/{id}/quad-slot", { id }), { slot, crop: null });
    load();
  }

  return {
    album,
    loadError,
    load,
    speciesItems,
    reloadSpecies: species.reload,
    removeFromAlbum,
    rateCapture,
    updateItem,
    deleteAlbum,
    saveName,
    saveDescription,
    setCoverLayout,
    setCoverPhoto,
    saveCoverCrop,
    resetCoverCrop,
    setQuadSlotPhoto,
    saveQuadSlotCrop,
    resetQuadSlotCrop,
  };
}
