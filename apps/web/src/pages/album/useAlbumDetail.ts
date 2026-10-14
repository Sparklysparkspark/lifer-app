import { useCallback, useEffect } from "react";
import type { CollectionItem } from "@lifer/shared";
import { api, apiPath } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { useApiResource } from "../../lib/resource";
import type { AlbumDetail, AlbumView, Crop } from "./types";

// The album, its species (loaded once the species view opens), and every edit to them. Edits
// reload the album afterwards, since the server resolves covers and quad slots.
export function useAlbumDetail(id: string | undefined, view: AlbumView) {
  const toast = useToast();
  const albumResource = useApiResource<AlbumDetail>(id ? `/albums/${id}` : null);
  const album = albumResource.data;
  const setAlbum = albumResource.setData;
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
    if (species.error) toast.error("Couldn't load this album's species.");
  }, [species.error, toast]);

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

  async function removeFromAlbum(captureId: string) {
    if (!id) return;
    setAlbum((a) => (a ? { ...a, items: a.items.filter((i) => i.captureId !== captureId) } : a));
    try {
      await api.delete(apiPath("/albums/{id}/captures/{captureId}", { id, captureId }));
    } catch {
      toast.error("Couldn't remove this photo from the album.");
      load();
    }
  }

  async function saveName(name: string) {
    if (!id || !name) return;
    await saveAndReload(() => api.patch(apiPath("/albums/{id}", { id }), { name }), "Couldn't rename this album.");
  }

  async function saveDescription(description: string) {
    if (!id) return;
    await saveAndReload(
      () => api.patch(apiPath("/albums/{id}", { id }), { description }),
      "Couldn't save the description.",
    );
  }

  async function setCoverLayout(coverLayout: "single" | "quad") {
    if (!id) return;
    await saveAndReload(
      () => api.patch(apiPath("/albums/{id}", { id }), { coverLayout }),
      "Couldn't change the cover style.",
    );
  }

  async function setCoverPhoto(photoId: string) {
    if (!id) return;
    await saveAndReload(
      () => api.patch(apiPath("/albums/{id}", { id }), { coverPhotoId: photoId }),
      "Couldn't set the album cover.",
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
      "Couldn't change this cover tile.",
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
    removeFromAlbum,
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
