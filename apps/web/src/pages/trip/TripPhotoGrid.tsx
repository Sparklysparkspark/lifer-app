import type { RefObject } from "react";
import { Link } from "react-router-dom";
import MasonryGrid from "../../components/MasonryGrid";
import PhotoTile from "../../components/PhotoTile";
import InlineSpinner from "../../components/InlineSpinner";
import { downloadFile } from "../../lib/downloadFile";
import type { TripDetail, TripPhoto } from "./types";
import type { TripEdits } from "./useTripEdits";

const MENU_ITEM = "block w-full px-3 py-1.5 text-left text-ink hover:bg-surface-muted";

type GridItem = { kind: "placeholder"; key: string } | { kind: "photo"; photo: TripPhoto; photoIndex: number };

function layoutButtonClass(active: boolean): string {
  return `rounded-md border px-2 py-1 text-xs ${
    active ? "border-ink bg-surface-muted text-ink" : "border-line hover:bg-surface-muted"
  }`;
}

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
  const gridItems: GridItem[] = [
    ...pendingImports.map((relativePath): GridItem => ({ kind: "placeholder", key: relativePath })),
    ...photos.map((photo, photoIndex): GridItem => ({ kind: "photo", photo, photoIndex })),
  ];

  return (
    <>
      <div className="mb-4 flex items-center gap-2 text-sm text-muted">
        Cover style
        <button
          onClick={() => edits.setCoverLayout("single")}
          className={layoutButtonClass(trip.coverLayout === "single")}
        >
          Single photo
        </button>
        <button onClick={() => edits.setCoverLayout("quad")} className={layoutButtonClass(trip.coverLayout === "quad")}>
          Quad grid
        </button>
      </div>
      <MasonryGrid
        items={gridItems}
        columnWidth={thumbSizePx}
        extraHeightPx={showLabels ? 19 : 0}
        keyFor={(gi) => (gi.kind === "placeholder" ? `pending-${gi.key}` : gi.photo.photoId)}
        aspectRatioFor={(gi) =>
          gi.kind === "photo" && gi.photo.width && gi.photo.height ? gi.photo.width / gi.photo.height : null
        }
        renderItem={(gi, aspectRatio) => {
          if (gi.kind === "placeholder") {
            // Still being processed (EXIF read, thumbnails).
            return (
              <div className="flex aspect-square w-full items-center justify-center rounded-md bg-surface-muted">
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
              alt={photo.commonName ?? photo.scientificName}
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
                  closeMenu={() => menu.setOpenKey(null)}
                />
              }
              label={
                showLabels && (
                  <p className="mt-1 truncate text-[11px] text-muted">{photo.commonName ?? photo.scientificName}</p>
                )
              }
            />
          );
        }}
      />
    </>
  );
}

function TripPhotoMenu({
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
  const displayUrl = `/api/photos/${photo.photoId}/display`;
  return (
    <div className="absolute right-0 top-full z-10 mt-1 whitespace-nowrap rounded-md border border-line bg-surface py-1 text-xs shadow-lg">
      <Link to={`/species/${photo.speciesId}`} onClick={closeMenu} className={MENU_ITEM}>
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
      <button
        onClick={() => {
          closeMenu();
          edits.setConfirmingDeleteCaptureId(photo.captureId);
        }}
        className="block w-full px-3 py-1.5 text-left text-rose-700 hover:bg-surface-muted dark:text-rose-400"
      >
        Delete photo
      </button>
    </div>
  );
}
