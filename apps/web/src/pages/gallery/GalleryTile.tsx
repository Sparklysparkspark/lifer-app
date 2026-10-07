import { memo, type ReactNode, type RefObject } from "react";
import { Link } from "react-router-dom";
import PhotoTile from "../../components/PhotoTile";
import StarRating from "../../components/StarRating";
import SpeciesPicker from "../../components/SpeciesPicker";
import { TagEditor } from "../../components/Lightbox";
import { downloadFile } from "../../lib/downloadFile";
import type { ContextAnchor, GalleryItem } from "./types";
import type { GalleryEdits } from "./useGalleryEdits";

const MENU_ITEM = "block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted";

// Memoized so a selection, rating or menu change only re-renders the tiles it touches. Every
// callback takes ids/indices so the page can pass the same function to every tile.
const GalleryTile = memo(function GalleryTile({
  item,
  index,
  aspectRatio,
  cornerRadiusPx,
  selectMode,
  selected,
  menuOpen,
  contextMenuAnchor,
  menuContent,
  menuRef,
  shotLine,
  showLabels,
  showRatings,
  showCameraInfo,
  missingDate,
  savingDate,
  onOpen,
  onToggleSelect,
  onDragStart,
  onDragEnter,
  onToggleMenu,
  onOpenContextMenu,
  onRate,
  onSetTakenAt,
}: {
  item: GalleryItem;
  index: number;
  aspectRatio: number;
  cornerRadiusPx: number;
  selectMode: boolean;
  selected: boolean;
  menuOpen: boolean;
  contextMenuAnchor: ContextAnchor | null;
  // Null for closed tiles: keeps the trigger without building their panels.
  menuContent: ReactNode | null;
  menuRef: RefObject<HTMLDivElement | null>;
  shotLine: string | null;
  showLabels: boolean;
  showRatings: boolean;
  showCameraInfo: boolean;
  missingDate: boolean;
  savingDate: boolean;
  onOpen: (index: number) => void;
  onToggleSelect: (captureId: string, index: number, shiftKey: boolean) => void;
  onDragStart: (index: number) => void;
  onDragEnter: (index: number) => void;
  onToggleMenu: (photoId: string) => void;
  onOpenContextMenu: (photoId: string, point: { x: number; y: number }) => void;
  onRate: (captureId: string, rating: number | null) => void;
  onSetTakenAt: (captureId: string, value: string) => void;
}) {
  return (
    <PhotoTile
      photoId={item.photoId}
      alt={item.commonName ?? item.scientificName}
      kind={item.kind}
      durationSeconds={item.durationSeconds}
      onOpen={() => onOpen(index)}
      selectMode={selectMode}
      selected={selected}
      onToggleSelect={(shiftKey) => onToggleSelect(item.captureId, index, shiftKey)}
      onDragSelectStart={() => onDragStart(index)}
      onDragSelectEnter={() => onDragEnter(index)}
      aspectRatio={aspectRatio}
      cornerRadiusPx={cornerRadiusPx}
      menuOpen={menuOpen && !contextMenuAnchor}
      onToggleMenu={() => onToggleMenu(item.photoId)}
      menuRef={menuRef}
      onOpenContextMenu={(point) => onOpenContextMenu(item.photoId, point)}
      contextMenuOpen={menuOpen && !!contextMenuAnchor}
      contextMenuAnchor={contextMenuAnchor}
      menuContent={menuContent}
      label={
        <>
          {showLabels && (
            <p className="mt-1 truncate text-[11px] text-muted">{item.commonName ?? item.scientificName}</p>
          )}
          {showRatings && (
            // Tighter under a name so the two read as one caption.
            <div className={showLabels ? "mt-0.5" : "mt-1"}>
              <StarRating rating={item.qualityRating} onRate={(rating) => onRate(item.captureId, rating)} />
            </div>
          )}
          {showCameraInfo && shotLine && <p className="text-[9px] text-muted">{shotLine}</p>}
          {missingDate && (
            <input
              type="date"
              disabled={savingDate}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => e.target.value && onSetTakenAt(item.captureId, e.target.value)}
              className="mt-1 w-full rounded border border-line bg-surface px-1.5 py-0.5 text-[11px] text-ink disabled:opacity-50"
            />
          )}
        </>
      }
    />
  );
});

export default GalleryTile;

// Built only for the tile whose menu is open. Which sub-editor is showing lives in `edits`, so it
// survives the menu closing and reopening.
export function GalleryTileMenu({
  item,
  edits,
  canRevealInFinder,
  closeMenu,
}: {
  item: GalleryItem;
  edits: GalleryEdits;
  canRevealInFinder: boolean;
  closeMenu: () => void;
}) {
  const wide = edits.reassigningCaptureId === item.captureId || edits.editingTagsCaptureId === item.captureId;
  return (
    <div
      className={`absolute right-0 top-full z-10 mt-1 rounded-md border border-line bg-surface py-1 shadow-lg ${wide ? "w-56" : "w-44"}`}
    >
      <Link
        to={`/species/${item.speciesId}`}
        onClick={(e) => {
          e.stopPropagation();
          closeMenu();
        }}
        className={MENU_ITEM}
      >
        View species
      </Link>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void edits.toggleFeatured(item);
          closeMenu();
        }}
        className={MENU_ITEM}
      >
        {item.isFeatured ? "Remove from featured" : "Set as featured"}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          edits.setAddingToAlbumCaptureId(item.captureId);
          closeMenu();
        }}
        className={MENU_ITEM}
      >
        Add to album…
      </button>
      {edits.editingTagsCaptureId === item.captureId ? (
        <div className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
          <TagEditor
            tags={item.tags}
            existingTags={edits.tagOptions}
            onChange={(tags) => edits.tagCapture(item.captureId, tags)}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            edits.setEditingTagsCaptureId(item.captureId);
          }}
          className={MENU_ITEM}
        >
          Edit tags…
        </button>
      )}
      {edits.reassigningCaptureId === item.captureId ? (
        <div className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
          <SpeciesPicker
            autoFocus
            placeholder="Correct ID to…"
            onSelect={(s) => edits.reassignSpecies(item.captureId, s.id)}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            edits.setReassigningCaptureId(item.captureId);
          }}
          className={MENU_ITEM}
        >
          Correct the ID…
        </button>
      )}
      {/* When the only original is the RAW, "Download RAW" below already covers it. */}
      {item.originalRef && item.originalKind !== "raw" && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
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
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            closeMenu();
            downloadFile(`/api/photos/${item.photoId}/original-raw?download=1`, "original.raw");
          }}
          className={MENU_ITEM}
        >
          Download RAW
        </button>
      )}
      {canRevealInFinder && item.originalRef && !item.originalManaged && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void edits.revealInFinder(item.originalRef!);
          }}
          className={MENU_ITEM}
        >
          Reveal in Finder
        </button>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          edits.single.request(item.captureId);
          closeMenu();
        }}
        className="block w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-surface-muted dark:text-red-400"
      >
        Delete {item.kind === "video" ? "video" : "photo"}
      </button>
    </div>
  );
}

/** A hidden photo's menu (the Gallery's "Hidden" filter): it can only be brought back. */
export function HiddenTileMenu({ onUnhide }: { onUnhide: () => void }) {
  return (
    <div className="absolute right-0 top-full z-10 mt-1 w-44 rounded-md border border-line bg-surface py-1 shadow-lg">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onUnhide();
        }}
        className={MENU_ITEM}
      >
        Unhide
      </button>
    </div>
  );
}
