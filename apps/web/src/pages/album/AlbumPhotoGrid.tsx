import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AlbumPhoto } from "@lifer/shared";
import PhotoGrid, { type PhotoGridMenu } from "../../components/PhotoGrid";
import PhotoMenu from "../../components/PhotoMenu";
import AddToAlbumModal from "../../components/AddToAlbumModal";
import PhotoTileCaption from "../../components/PhotoTileCaption";
import type { PhotoCaptionPrefs } from "../../hooks/usePhotoCaptionPrefs";
import { itemShotData } from "../gallery/galleryHelpers";
import type { useSelectMode } from "../../hooks/useSelectMode";
import { MenuItem } from "../../components/Menu";
import Button from "../../components/Button";
import { COMPARE_MAX, COMPARE_MIN } from "../../lib/compareZoom";
import { useSpeciesName } from "../../lib/speciesName";
import { usePhotoEdits, type PhotoEditPatch } from "../../hooks/usePhotoEdits";

const albumPhotoId = (p: AlbumPhoto) => p.captureId;

// The album's photos, with the remove-selected bar above them in select mode. A tile click opens
// the lightbox, or fills the quad cover tile being picked.
export default function AlbumPhotoGrid({
  items,
  select,
  thumbSizePx,
  captions,
  coverPhotoId,
  coverPicked,
  coverLayout,
  pickingQuadSlot,
  menu,
  speciesLinkState,
  onOpen,
  onPickQuadPhoto,
  onSetCover,
  onAdjustCover,
  onRemove,
  onRate,
  onCompare,
  onReload,
  onUpdateItem,
  smart = false,
}: {
  /** A smart album: taking a photo out excludes it rather than removing it. */
  smart?: boolean;
  items: AlbumPhoto[];
  select: ReturnType<typeof useSelectMode<AlbumPhoto>>;
  thumbSizePx: number;
  captions: PhotoCaptionPrefs;
  coverPhotoId: string | null;
  /** The cover was chosen by hand, so it can be taken back to the automatic one. */
  coverPicked: boolean;
  coverLayout: "single" | "quad";
  pickingQuadSlot: number | null;
  menu: PhotoGridMenu;
  /** So the species page's back link returns to this album. */
  speciesLinkState: object;
  onOpen: (index: number) => void;
  onPickQuadPhoto: (slot: number, photoId: string) => void;
  /** Null goes back to the automatic cover. */
  onSetCover: (photoId: string | null) => void;
  onAdjustCover: (photoUrl: string) => void;
  onRemove: (captureId: string) => Promise<void>;
  onRate: (captureId: string, rating: number | null) => void;
  /** Opens these photos side by side. */
  onCompare?: (captureIds: string[]) => void;
  /** After an edit the server works something out for (names, covers, counts). */
  onReload: () => void;
  onUpdateItem: (captureId: string, patch: PhotoEditPatch) => void;
}) {
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  const { selectMode, selectedIds } = select;
  const closeMenu = () => menu.setOpenKey(null);
  const [addingCaptureId, setAddingCaptureId] = useState<string | null>(null);
  const edits = usePhotoEdits({ reload: onReload, update: onUpdateItem });

  return (
    <>
      {selectMode && selectedIds.size > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-control border border-line bg-surface-muted p-2 text-callout">
          <span className="text-muted">{t("albums.photos.selected", { count: selectedIds.size })}</span>
          {onCompare && selectedIds.size >= COMPARE_MIN && selectedIds.size <= COMPARE_MAX && (
            <Button variant="secondary" size="sm" onClick={() => onCompare([...selectedIds])}>
              {t("gallery.select.compare")}
            </Button>
          )}
          <Button
            variant="danger"
            size="sm"
            onClick={async () => {
              const ids = [...selectedIds];
              select.clear();
              for (const captureId of ids) await onRemove(captureId);
            }}
          >
            {smart ? t("albums.smart.exclude") : t("albums.photos.removeFromAlbum")}
          </Button>
        </div>
      )}
      <PhotoGrid
        items={items}
        idFor={albumPhotoId}
        tileFor={(item) => ({ ...item, alt: speciesName(item) })}
        columnWidth={thumbSizePx}
        select={select}
        menu={menu}
        onOpen={(i) => (pickingQuadSlot != null ? onPickQuadPhoto(pickingQuadSlot, items[i].photoId) : onOpen(i))}
        renderMenu={(item) => {
          const isCover = coverPicked && coverPhotoId === item.photoId;
          return (
            <PhotoMenu
              photo={{ ...item, rating: item.qualityRating, hasRaw: item.hasRawOriginal }}
              onClose={closeMenu}
              speciesLinkState={speciesLinkState}
              onRate={(rating) => onRate(item.captureId, rating)}
              onAddToAlbum={() => setAddingCaptureId(item.captureId)}
              {...edits.menuActions(item.captureId)}
              featured={!!item.isFeatured}
              onToggleFeatured={
                item.speciesId
                  ? () => void edits.toggleFeatured(item.captureId, item.speciesId!, item.photoId, !!item.isFeatured)
                  : undefined
              }
              location={[item.locationLabel, item.regionName].filter(Boolean).join(", ")}
              coverItems={
                <>
                  <MenuItem onSelect={() => onSetCover(isCover ? null : item.photoId)}>
                    {isCover ? t("albums.photos.isCover") : t("albums.photos.setCover")}
                  </MenuItem>
                  {isCover && coverLayout === "single" && (
                    <MenuItem
                      onSelect={() => {
                        closeMenu();
                        onAdjustCover(`/api/photos/${item.photoId}/display`);
                      }}
                    >
                      {t("albums.photos.adjustCover")}
                    </MenuItem>
                  )}
                </>
              }
              endItems={
                <MenuItem
                  danger
                  onSelect={() => {
                    void onRemove(item.captureId);
                    closeMenu();
                  }}
                >
                  {smart ? t("albums.smart.exclude") : t("albums.photos.removeFromAlbum")}
                </MenuItem>
              }
            />
          );
        }}
        renderLabel={(item) => (
          <PhotoTileCaption
            {...captions}
            label={speciesName(item)}
            rating={item.qualityRating}
            onRate={(rating) => onRate(item.captureId, rating)}
            shotLine={captions.showCameraInfo ? itemShotData(item) : null}
          />
        )}
      />
      {edits.dialog((id) => items.find((i) => i.captureId === id))}
      {addingCaptureId && <AddToAlbumModal captureIds={[addingCaptureId]} onClose={() => setAddingCaptureId(null)} />}
    </>
  );
}
