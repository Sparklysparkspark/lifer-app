import type { RefObject } from "react";
import { Link } from "react-router-dom";
import type { AlbumPhoto } from "@lifer/shared";
import MasonryGrid from "../../components/MasonryGrid";
import PhotoTile from "../../components/PhotoTile";
import type { useSelectMode } from "../../hooks/useSelectMode";
import { downloadFile } from "../../lib/downloadFile";

const MENU_ITEM = "block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted";

// The album's photos, with the remove-selected bar above them in select mode. A tile click opens
// the lightbox, or fills the quad cover tile being picked.
export default function AlbumPhotoGrid({
  items,
  select,
  thumbSizePx,
  showLabels,
  coverPhotoId,
  coverLayout,
  pickingQuadSlot,
  menu,
  onOpen,
  onPickQuadPhoto,
  onSetCover,
  onAdjustCover,
  onRemove,
}: {
  items: AlbumPhoto[];
  select: ReturnType<typeof useSelectMode<AlbumPhoto>>;
  thumbSizePx: number;
  showLabels: boolean;
  coverPhotoId: string | null;
  coverLayout: "single" | "quad";
  pickingQuadSlot: number | null;
  menu: { openKey: string | null; setOpenKey: (key: string | null) => void; ref: RefObject<HTMLDivElement | null> };
  onOpen: (index: number) => void;
  onPickQuadPhoto: (slot: number, photoId: string) => void;
  onSetCover: (photoId: string) => void;
  onAdjustCover: (photoUrl: string) => void;
  onRemove: (captureId: string) => Promise<void>;
}) {
  const { selectMode, selectedIds, dragPreviewIds, dragProps } = select;
  const closeMenu = () => menu.setOpenKey(null);

  return (
    <>
      {selectMode && selectedIds.size > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-md border border-line bg-surface-muted p-2 text-sm">
          <span className="text-muted">{selectedIds.size} selected</span>
          <button
            onClick={async () => {
              const ids = [...selectedIds];
              select.clear();
              for (const captureId of ids) await onRemove(captureId);
            }}
            className="text-red-600 hover:underline dark:text-red-400"
          >
            Remove from album
          </button>
        </div>
      )}
      <MasonryGrid
        items={items.map((item, i) => ({ item, i }))}
        columnWidth={thumbSizePx}
        gap={8}
        extraHeightPx={showLabels ? 19 : 0}
        keyFor={({ item }) => item.photoId}
        aspectRatioFor={({ item }) => (item.width && item.height ? item.width / item.height : null)}
        renderItem={({ item, i }, aspectRatio) => {
          const isCover = coverPhotoId === item.photoId;
          return (
            <PhotoTile
              key={item.photoId}
              photoId={item.photoId}
              alt={item.commonName || item.scientificName}
              onOpen={() => (pickingQuadSlot != null ? onPickQuadPhoto(pickingQuadSlot, item.photoId) : onOpen(i))}
              selectMode={selectMode}
              selected={selectedIds.has(item.captureId) || (dragPreviewIds?.has(item.captureId) ?? false)}
              onToggleSelect={(shiftKey) => select.toggle(item.captureId, i, shiftKey)}
              onDragSelectStart={() => dragProps.onDragSelectStart(i)}
              onDragSelectEnter={() => dragProps.onDragSelectEnter(i)}
              aspectRatio={aspectRatio}
              kind={item.kind}
              durationSeconds={item.durationSeconds != null ? Number(item.durationSeconds) : null}
              menuOpen={menu.openKey === item.photoId}
              onToggleMenu={() => menu.setOpenKey(menu.openKey === item.photoId ? null : item.photoId)}
              menuRef={menu.ref}
              menuContent={
                menu.openKey === item.photoId && (
                  <div className="absolute right-0 top-full z-10 mt-1 w-44 rounded-md border border-line bg-surface py-1 shadow-lg">
                    {item.speciesId && (
                      <Link to={`/species/${item.speciesId}`} onClick={closeMenu} className={MENU_ITEM}>
                        View species
                      </Link>
                    )}
                    <button
                      onClick={() => onSetCover(item.photoId)}
                      disabled={isCover}
                      className={`${MENU_ITEM} disabled:opacity-50`}
                    >
                      {isCover ? "Album cover ✓" : "Set as album cover"}
                    </button>
                    {isCover && coverLayout === "single" && (
                      <button
                        onClick={() => {
                          closeMenu();
                          onAdjustCover(`/api/photos/${item.photoId}/display`);
                        }}
                        className={MENU_ITEM}
                      >
                        Adjust position
                      </button>
                    )}
                    {/* Hidden when the only original on file is the RAW. */}
                    {item.originalRef && item.originalKind !== "raw" && (
                      <button
                        onClick={() => {
                          closeMenu();
                          downloadFile(`/api/photos/${item.photoId}/original?download=1`, "original.jpg");
                        }}
                        className={MENU_ITEM}
                      >
                        Download original
                      </button>
                    )}
                    {item.hasRawOriginal && (
                      <button
                        onClick={() => {
                          closeMenu();
                          downloadFile(`/api/photos/${item.photoId}/original-raw?download=1`, "original.raw");
                        }}
                        className={MENU_ITEM}
                      >
                        Download RAW
                      </button>
                    )}
                    <button
                      onClick={() => {
                        onRemove(item.captureId);
                        closeMenu();
                      }}
                      className="block w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-surface-muted dark:text-red-400"
                    >
                      Remove from album
                    </button>
                  </div>
                )
              }
              label={
                showLabels && (
                  <p className="mt-1 truncate text-[11px] text-muted">{item.commonName || item.scientificName}</p>
                )
              }
            />
          );
        }}
      />
    </>
  );
}
