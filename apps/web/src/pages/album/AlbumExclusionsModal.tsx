import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath } from "../../api/client";
import Button from "../../components/Button";
import { Spinner } from "../../components/LoadingScreen";
import Modal from "../../components/Modal";
import EmptyState from "../../components/EmptyState";
import PhotoTile from "../../components/PhotoTile";
import { useSelectMode } from "../../hooks/useSelectMode";
import { useToast } from "../../hooks/useToast";
import { useApiResource } from "../../lib/resource";
import { useSpeciesName } from "../../lib/speciesName";
import type { GalleryItem } from "../gallery/types";

// Shown a page at a time, so an album with thousands left out still opens quickly.
const PAGE_SIZE = 120;
const noop = () => {};

// The photos taken out of a smart album by hand: pick any (or all) and put them back in one go.
export default function AlbumExclusionsModal({
  albumId,
  onClose,
  onRestored,
}: {
  albumId: string;
  onClose: () => void;
  onRestored: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const speciesName = useSpeciesName();
  const resource = useApiResource<{ items: GalleryItem[] }>(`/albums/${albumId}/exclusions`);
  const items = resource.data?.items ?? null;
  const select = useSelectMode(items, (item) => item.captureId, true);
  const { selectedIds, dragPreviewIds, dragProps } = select;
  const [shown, setShown] = useState(PAGE_SIZE);
  const [restoring, setRestoring] = useState(false);
  const allSelected = !!items?.length && selectedIds.size === items.length;

  async function restoreSelected() {
    const captureIds = [...selectedIds];
    setRestoring(true);
    try {
      await api.post(apiPath("/albums/{id}/exclusions/restore", { id: albumId }), { captureIds });
      onRestored();
      toast.success(t("albums.smart.restored", { count: captureIds.length }));
      onClose();
    } catch {
      toast.error(t("albums.smart.restoreFailed"));
    } finally {
      setRestoring(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t("albums.smart.excludedTitle")}
      footerStart={
        !!items?.length && (
          <Button
            variant="ghost"
            onClick={() =>
              allSelected ? select.clear() : select.setSelectedIds(new Set(items.map((i) => i.captureId)))
            }
          >
            {allSelected ? t("albums.smart.deselectAll") : t("albums.smart.selectAll")}
          </Button>
        )
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.done")}
          </Button>
          {selectedIds.size > 0 && (
            <Button onClick={() => void restoreSelected()} loading={restoring}>
              {t("albums.smart.restoreCount", { count: selectedIds.size })}
            </Button>
          )}
        </>
      }
    >
      {!items ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState compact title={t("albums.smart.noneExcluded")} />
      ) : (
        <>
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {items.slice(0, shown).map((item, i) => (
              <li key={item.captureId}>
                <PhotoTile
                  photoId={item.photoId}
                  alt={speciesName(item)}
                  kind={item.kind}
                  aspectRatio={1}
                  onOpen={noop}
                  selectMode
                  selected={selectedIds.has(item.captureId) || (dragPreviewIds?.has(item.captureId) ?? false)}
                  onToggleSelect={(shiftKey) => select.toggle(item.captureId, i, shiftKey)}
                  onDragSelectStart={() => dragProps.onDragSelectStart(i)}
                  onDragSelectEnter={() => dragProps.onDragSelectEnter(i)}
                  menuOpen={false}
                  onToggleMenu={noop}
                />
              </li>
            ))}
          </ul>
          {items.length > shown && (
            <div className="mt-3 text-center">
              <Button variant="secondary" size="sm" onClick={() => setShown((n) => n + PAGE_SIZE)}>
                {t("albums.smart.showMore")}
              </Button>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
