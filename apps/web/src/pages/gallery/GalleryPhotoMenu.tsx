import type { CSSProperties, Ref } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { MenuItem, MenuPanel } from "../../components/Menu";
import PhotoMenu from "../../components/PhotoMenu";
import { backStateFor } from "../../lib/backLabel";
import type { GalleryItem } from "./types";
import type { GalleryEdits } from "./useGalleryEdits";

// Built only for the tile whose menu is open. Which sub-editor is showing lives in `edits`, so it
// survives the menu closing and reopening.
export function GalleryPhotoMenu({
  ref,
  style,
  item,
  edits,
  closeMenu,
  onAdjustTime,
}: {
  item: GalleryItem;
  edits: GalleryEdits;
  closeMenu: () => void;
  onAdjustTime?: () => void;
  /** From Menu, which measures the panel and moves it to stay on the page. */
  ref?: Ref<HTMLDivElement>;
  style?: CSSProperties;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const editTags = () => edits.setEditing({ captureId: item.captureId, edit: "tags" });
  const correctId = () => edits.setEditing({ captureId: item.captureId, edit: "reassign" });
  const tagSpecies = () => edits.setEditing({ captureId: item.captureId, edit: "tagSpecies" });
  return (
    <PhotoMenu
      ref={ref}
      style={style}
      photo={{ ...item, rating: item.qualityRating, hasRaw: item.hasRawOriginal }}
      onClose={closeMenu}
      speciesLinkState={backStateFor(location, t)}
      onRate={(rating) => void edits.rateCapture(item.captureId, rating)}
      featured={!!item.isFeatured}
      onToggleFeatured={() => void edits.toggleFeatured(item)}
      onAddToAlbum={() => edits.setAddingToAlbumCaptureId(item.captureId)}
      onEditTags={editTags}
      onCorrectId={correctId}
      onTagSpecies={tagSpecies}
      location={[item.locationLabel, item.regionName].filter(Boolean).join(", ")}
      onSetLocation={() => edits.setPlacingCaptureId(item.captureId)}
      onAdjustTime={onAdjustTime}
      onInatSent={edits.reload}
      onVersionsChange={edits.reload}
      onHide={() => void edits.hide([item.captureId])}
      onDelete={() => void edits.deletePhoto(item.captureId)}
      onDeleteWithRaw={() => void edits.deletePhoto(item.captureId, true)}
    />
  );
}

/** A hidden photo's menu (the Gallery's "Hidden" filter): it can only be brought back. */
export function HiddenTileMenu({
  ref,
  style,
  onUnhide,
}: {
  onUnhide: () => void;
  /** From Menu, which measures the panel and moves it to stay on the page. */
  ref?: Ref<HTMLDivElement>;
  style?: CSSProperties;
}) {
  const { t } = useTranslation();
  return (
    <MenuPanel ref={ref} style={style} className="w-44">
      <MenuItem onSelect={onUnhide}>{t("photoMenu.unhide")}</MenuItem>
    </MenuPanel>
  );
}
