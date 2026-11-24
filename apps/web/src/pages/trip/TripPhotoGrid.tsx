import { useState, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import PhotoGrid, { type PhotoGridMenu, type PhotoGridSelection } from "../../components/PhotoGrid";
import { usePhotoEdits } from "../../hooks/usePhotoEdits";
import PhotoMenu from "../../components/PhotoMenu";
import PhotoTileCaption from "../../components/PhotoTileCaption";
import AddToAlbumModal from "../../components/AddToAlbumModal";
import type { PhotoCaptionPrefs } from "../../hooks/usePhotoCaptionPrefs";
import { itemShotData } from "../gallery/galleryHelpers";
import SegmentedControl from "../../components/SegmentedControl";
import { MenuGroup, MenuItem } from "../../components/Menu";
import type { TripDetail, TripPhoto } from "./types";
import type { TripEdits } from "./useTripEdits";
import { useSpeciesName } from "../../lib/speciesName";
import { backStateFor } from "../../lib/backLabel";

const tripPhotoId = (p: TripPhoto) => p.captureId;

// The trip's photos, led by a loading tile per photo still importing.
export default function TripPhotoGrid({
  trip,
  photos,
  pendingImports,
  thumbSizePx,
  captions,
  edits,
  select,
  menu,
  onOpen,
  onReload,
  groups,
}: {
  trip: TripDetail;
  photos: TripPhoto[];
  /** Headed groups (groupTripPhotos), indexing into `photos`; null for one grid. */
  groups?: ComponentProps<typeof PhotoGrid<TripPhoto>>["groups"];
  pendingImports: string[];
  thumbSizePx: number;
  captions: PhotoCaptionPrefs;
  edits: TripEdits;
  select: PhotoGridSelection;
  menu: PhotoGridMenu;
  onOpen: (photoIndex: number) => void;
  /** After an edit the server works something out for (names, counts, the cover). */
  onReload: () => void;
}) {
  const speciesName = useSpeciesName();
  const { t } = useTranslation();
  const location = useLocation();
  const [addingCaptureId, setAddingCaptureId] = useState<string | null>(null);
  // So the species page's back link returns to this trip.
  const speciesLinkState = backStateFor(location, t, trip.name);
  const closeMenu = () => menu.setOpenKey(null);
  const photoEdits = usePhotoEdits({ reload: onReload });

  return (
    <>
      <PhotoGrid
        items={photos}
        groups={groups}
        idFor={tripPhotoId}
        tileFor={(photo) => ({ ...photo, alt: speciesName(photo) })}
        columnWidth={thumbSizePx}
        select={select}
        menu={menu}
        pending={{ keys: pendingImports, first: true, label: t("trips.photoMenu.importing") }}
        onOpen={onOpen}
        renderMenu={(photo) => (
          <PhotoMenu
            photo={{ ...photo, rating: photo.qualityRating }}
            onClose={closeMenu}
            speciesLinkState={speciesLinkState}
            onRate={(rating) => void edits.rateCapture(photo.captureId, rating)}
            coverItems={
              <TripCoverItems
                photo={photo}
                isCover={trip.coverCaptureId === photo.captureId}
                coverLayout={trip.coverLayout}
                edits={edits}
                closeMenu={closeMenu}
              />
            }
            onAddToAlbum={() => setAddingCaptureId(photo.captureId)}
            {...photoEdits.menuActions(photo.captureId)}
            location={photo.locationLabel}
            onDelete={() => void edits.deletePhoto(photo.captureId)}
            onDeleteWithRaw={() => void edits.deletePhoto(photo.captureId, true)}
          />
        )}
        renderLabel={(photo) => (
          <PhotoTileCaption
            {...captions}
            label={speciesName(photo)}
            rating={photo.qualityRating}
            onRate={(rating) => void edits.rateCapture(photo.captureId, rating)}
            shotLine={captions.showCameraInfo ? itemShotData(photo) : null}
          />
        )}
      />
      {photoEdits.dialog((id) => photos.find((p) => p.captureId === id))}
      {addingCaptureId && <AddToAlbumModal captureIds={[addingCaptureId]} onClose={() => setAddingCaptureId(null)} />}
    </>
  );
}

// The trip's cover choices, in the shared photo menu.
function TripCoverItems({
  photo,
  isCover,
  coverLayout,
  edits,
  closeMenu,
}: {
  photo: TripPhoto;
  isCover: boolean;
  coverLayout: "single" | "quad";
  edits: TripEdits;
  closeMenu: () => void;
}) {
  const { t } = useTranslation();
  const displayUrl = `/api/photos/${photo.photoId}/display`;
  return (
    <>
      {/* Stays open: the cover's style choice appears below once it's the cover. */}
      <MenuItem
        keepOpen
        onSelect={() => (isCover ? edits.setCover(null) : edits.setCoverAndEdit(photo.captureId, displayUrl))}
        disabled={edits.settingCover === photo.captureId}
      >
        {isCover ? t("trips.photoMenu.isCover") : t("trips.photoMenu.useAsCover")}
      </MenuItem>
      {/* Only on the cover's own menu, so the choice sits next to the cover it changes. */}
      {isCover && (
        <MenuGroup label={t("trips.photoMenu.coverStyle")}>
          <SegmentedControl
            value={coverLayout}
            onChange={edits.setCoverLayout}
            options={[
              { value: "single", label: t("trips.photoMenu.coverSingle") },
              { value: "quad", label: t("trips.photoMenu.coverQuad") },
            ]}
          />
        </MenuGroup>
      )}
      {isCover && coverLayout === "single" && (
        <MenuItem
          onSelect={() => {
            closeMenu();
            edits.setCroppingCoverPhotoUrl(displayUrl);
          }}
        >
          {t("trips.photoMenu.adjustPosition")}
        </MenuItem>
      )}
    </>
  );
}
