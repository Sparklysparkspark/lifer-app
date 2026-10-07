import { useEffect, useState } from "react";
import type { CollectionItem } from "@lifer/shared";
import { api } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import type { AlbumDetail, AlbumView, Crop } from "./types";

// The album, its species (loaded once the species view opens), and every edit to them. Edits
// reload the album afterwards, since the server resolves covers and quad slots.
export function useAlbumDetail(id: string | undefined, view: AlbumView) {
  const toast = useToast();
  const [album, setAlbum] = useState<AlbumDetail | null>(null);
  // The album whose load failed, so opening another album starts without the old error.
  const [failedId, setFailedId] = useState<string | null>(null);
  const loadError = !!id && failedId === id;
  const [speciesItems, setSpeciesItems] = useState<CollectionItem[] | null>(null);

  function fetchAlbum() {
    if (!id) return;
    const albumId = id;
    api
      .get<AlbumDetail>(`/albums/${albumId}`)
      .then(setAlbum)
      .catch(() => setFailedId(albumId));
  }

  // A reload after a change: any earlier error clears while it retries.
  function load() {
    setFailedId(null);
    fetchAlbum();
  }

  useEffect(fetchAlbum, [id]);

  useEffect(() => {
    if (!id || view !== "species") return;
    let cancelled = false;
    api
      .get<{ items: CollectionItem[] }>(`/albums/${id}/species`)
      .then((res) => {
        if (!cancelled) setSpeciesItems(res.items);
      })
      .catch(() => {
        if (cancelled) return;
        setSpeciesItems([]);
        toast.error("Couldn't load this album's species.");
      });
    return () => {
      cancelled = true;
    };
  }, [id, view, toast]);

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
      await api.delete(`/albums/${id}/captures/${captureId}`);
    } catch {
      toast.error("Couldn't remove this photo from the album.");
      load();
    }
  }

  async function saveName(name: string) {
    if (!id || !name) return;
    await saveAndReload(() => api.patch(`/albums/${id}`, { name }), "Couldn't rename this album.");
  }

  async function saveDescription(description: string) {
    if (!id) return;
    await saveAndReload(() => api.patch(`/albums/${id}`, { description }), "Couldn't save the description.");
  }

  async function setCoverLayout(coverLayout: "single" | "quad") {
    if (!id) return;
    await saveAndReload(() => api.patch(`/albums/${id}`, { coverLayout }), "Couldn't change the cover style.");
  }

  async function setCoverPhoto(photoId: string) {
    if (!id) return;
    await saveAndReload(() => api.patch(`/albums/${id}`, { coverPhotoId: photoId }), "Couldn't set the album cover.");
  }

  async function saveCoverCrop(crop: Crop) {
    if (!id) return;
    await api.patch(`/albums/${id}/cover-crop`, crop);
    load();
  }

  async function resetCoverCrop() {
    if (!id) return;
    await api.patch(`/albums/${id}/cover-crop`, { reset: true });
    load();
  }

  async function setQuadSlotPhoto(slot: number, photoId: string | null) {
    if (!id) return;
    await saveAndReload(
      () => api.patch(`/albums/${id}/quad-slot`, { slot, photoId }),
      "Couldn't change this cover tile.",
    );
  }

  async function saveQuadSlotCrop(slot: number, crop: Crop) {
    if (!id) return;
    // Pins the slot to the photo shown, which may be an auto-picked fallback; otherwise the
    // resolver would discard the crop as a mismatch on the next load.
    const photoId = album?.quadSlots[slot]?.photoId ?? null;
    await api.patch(`/albums/${id}/quad-slot`, { slot, photoId, crop });
    load();
  }

  async function resetQuadSlotCrop(slot: number) {
    if (!id) return;
    await api.patch(`/albums/${id}/quad-slot`, { slot, crop: null });
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
