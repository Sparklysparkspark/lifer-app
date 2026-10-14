import type { CSSProperties, Ref, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import MasonryGrid from "../../components/MasonryGrid";
import PhotoTile from "../../components/PhotoTile";
import SegmentedControl from "../../components/SegmentedControl";
import InlineSpinner from "../../components/InlineSpinner";
import { downloadFile } from "../../lib/downloadFile";
import { MENU_ITEM, MENU_ITEM_DANGER, MENU_PANEL, MENU_SEPARATOR } from "../../lib/menuClasses";
import type { TripDetail, TripPhoto } from "./types";
import type { TripEdits } from "./useTripEdits";
import { useSpeciesName } from "../../lib/speciesName";
import { backStateFor } from "../../lib/backLabel";

type GridItem = { kind: "placeholder"; key: string } | { kind: "photo"; photo: TripPhoto; photoIndex: number };

// The cover style choice and the trip's photos, led by a loading tile per photo still importing.
export default function TripPhotoGrid({
  trip,
  photos,
  pendingImports,
  thumbSizePx,
  showLabels,
  edits,
  menu,
  onOpen,
}: {
  trip: TripDetail;
  photos: TripPhoto[];
  pendingImports: string[];
  thumbSizePx: number;
  showLabels: boolean;
  edits: TripEdits;
  menu: { openKey: string | null; setOpenKey: (key: string | null) => void; ref: RefObject<HTMLDivElement | null> };
  onOpen: (photoIndex: number) => void;
}) {
  const speciesName = useSpeciesName();
  const { t } = useTranslation();
  const location = useLocation();
  // So the species page's back link returns to this trip.
  const speciesLinkState = backStateFor(location, t, trip.name);
  const gridItems: GridItem[] = [
    ...pendingImports.map((relativePath): GridItem => ({ kind: "placeholder", key: relativePath })),
    ...photos.map((photo, photoIndex): GridItem => ({ kind: "photo", photo, photoIndex })),
  ];

  return (
    <>
      <div className="mb-4 flex items-center gap-2 text-sm text-muted">
        Cover style
        <SegmentedControl
          value={trip.coverLayout}
          onChange={edits.setCoverLayout}
          options={[
            { value: "single", label: "Single photo" },
            { value: "quad", label: "Quad grid" },
          ]}
        />
      </div>
      <MasonryGrid
        items={gridItems}
        columnWidth={thumbSizePx}
        keyFor={(gi) => (gi.kind === "placeholder" ? `pending-${gi.key}` : gi.photo.photoId)}
        aspectRatioFor={(gi) =>
          gi.kind === "photo" && gi.photo.width && gi.photo.height ? gi.photo.width / gi.photo.height : null
        }
        renderItem={(gi, aspectRatio) => {
          if (gi.kind === "placeholder") {
            // Still being processed (EXIF read, thumbnails).
            return (
              <div
                className="flex w-full items-center justify-center rounded-md bg-surface-muted"
                style={{ aspectRatio }}
              >
                <InlineSpinner size="md" label="Importing" />
              </div>
            );
          }
          const { photo, photoIndex } = gi;
          const isCover = trip.coverCaptureId === photo.captureId;
          return (
            <PhotoTile
              key={photo.photoId}
              photoId={photo.photoId}
              alt={speciesName(photo)}
              onOpen={() => onOpen(photoIndex)}
              selectMode={edits.selectMode}
              selected={edits.selectedCaptureIds.has(photo.captureId)}
              aspectRatio={aspectRatio}
              onToggleSelect={() => edits.toggleSelected(photo.captureId)}
              menuOpen={menu.openKey === photo.captureId}
              onToggleMenu={() => menu.setOpenKey(menu.openKey === photo.captureId ? null : photo.captureId)}
              menuRef={menu.ref}
              menuContent={
                <TripPhotoMenu
                  photo={photo}
                  isCover={isCover}
                  coverLayout={trip.coverLayout}
                  edits={edits}
                  speciesLinkState={speciesLinkState}
                  closeMenu={() => menu.setOpenKey(null)}
                />
              }
              label={showLabels && <p className="mt-1 truncate text-xs text-muted">{speciesName(photo)}</p>}
            />
          );
        }}
      />
    </>
  );
}

function TripPhotoMenu({
  ref,
  style,
  photo,
  isCover,
  coverLayout,
  edits,
  speciesLinkState,
  closeMenu,
}: {
  photo: TripPhoto;
  isCover: boolean;
  coverLayout: "single" | "quad";
  edits: TripEdits;
  speciesLinkState: object;
  closeMenu: () => void;
  /** From DotMenu, which measures the panel and moves it to stay on the page. */
  ref?: Ref<HTMLDivElement>;
  style?: CSSProperties;
}) {
  const displayUrl = `/api/photos/${photo.photoId}/display`;
  return (
    <div ref={ref} style={style} className={`absolute right-0 top-full z-10 mt-1 whitespace-nowrap ${MENU_PANEL}`}>
      <Link to={`/species/${photo.speciesId}`} state={speciesLinkState} onClick={closeMenu} className={MENU_ITEM}>
        View species
      </Link>
      <button
        onClick={() => (isCover ? edits.setCover(null) : edits.setCoverAndEdit(photo.captureId, displayUrl))}
        disabled={edits.settingCover === photo.captureId}
        className={MENU_ITEM}
      >
        {isCover ? "Featured photo ✓" : "Set as featured photo"}
      </button>
      {isCover && coverLayout === "single" && (
        <button
          onClick={() => {
            closeMenu();
            edits.setCroppingCoverPhotoUrl(displayUrl);
          }}
          className={MENU_ITEM}
        >
          Adjust position
        </button>
      )}
      {/* Hidden when the only original is the RAW, which Download RAW covers. */}
      {photo.originalRef && photo.originalKind !== "raw" && (
        <button
          onClick={() => {
            closeMenu();
            downloadFile(`/api/photos/${photo.photoId}/original?download=1`, "original.jpg");
          }}
          className={MENU_ITEM}
        >
          Download original
        </button>
      )}
      {photo.hasRaw && (
        <button
          onClick={() => {
            closeMenu();
            downloadFile(`/api/photos/${photo.photoId}/original-raw?download=1`, "original.raw");
          }}
          className={MENU_ITEM}
        >
          Download RAW
        </button>
      )}
      <div className={MENU_SEPARATOR} />
      <button
        onClick={() => {
          closeMenu();
          edits.setConfirmingDeleteCaptureId(photo.captureId);
        }}
        className={MENU_ITEM_DANGER}
      >
        Delete photo
      </button>
    </div>
  );
}
