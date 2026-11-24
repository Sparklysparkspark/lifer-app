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
import { useSpeciesName } from "../../lib/speciesName";
import { usePhotoEdits, type PhotoEditPatch } from "../../hooks/usePhotoEdits";

const albumPhotoId = (p: AlbumPhoto) => p.captureId;

// The album's photos. A tile click opens
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
  onRemove: (captureIds: string[]) => Promise<void>;
  onRate: (captureId: string, rating: number | null) => void;
  /** After an edit the server works something out for (names, covers, counts). */
  onReload: () => void;
  onUpdateItem: (captureId: string, patch: PhotoEditPatch) => void;
}) {
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  const closeMenu = () => menu.setOpenKey(null);
  const [addingCaptureId, setAddingCaptureId] = useState<string | null>(null);
  const edits = usePhotoEdits({ reload: onReload, update: onUpdateItem });

  return (
    <>
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
                    void onRemove([item.captureId]);
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
