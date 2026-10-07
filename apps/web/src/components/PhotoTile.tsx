import { memo, useState, type ReactNode, type RefObject } from "react";
import ProgressiveImg from "./ProgressiveImg";
import DotMenu from "./DotMenu";

// Photo-grid tile: image, select checkbox, hover "..." menu trigger and optional caption. The page
// owns which menu is open; pass `null` as menuContent for closed tiles. Memoized: pass stable callbacks.
function PhotoTile({
  photoId,
  alt,
  onOpen,
  selectMode,
  selected,
  onToggleSelect,
  label,
  cornerRadiusPx,
  aspectRatio,
  menuOpen,
  onToggleMenu,
  menuRef,
  menuContent,
  onDragSelectStart,
  onDragSelectEnter,
  kind,
  durationSeconds,
  contextMenuOpen,
  onOpenContextMenu,
  contextMenuAnchor,
}: {
  photoId: string;
  alt: string;
  /** Defaults to "image". A video tile shows its poster frame and plays a muted preview on hover. */
  kind?: "image" | "video";
  /** Video only: shown in a corner badge. */
  durationSeconds?: number | null;
  /** Only called when selectMode is off. */
  onOpen: () => void;
  selectMode: boolean;
  selected: boolean;
  /** shiftKey extends the selection as a range from the last-clicked tile. */
  onToggleSelect: (shiftKey: boolean) => void;
  /** Rendered below the image (caption, rating, or both). */
  label?: ReactNode;
  /** Overrides the default `rounded-md` corners. */
  cornerRadiusPx?: number;
  /** MasonryGrid's clamped ratio; crops via object-cover. Omit for natural aspect. */
  aspectRatio?: number;
  menuOpen: boolean;
  onToggleMenu: () => void;
  /** Only attached while the menu is open (useDropdownMenu's contract). */
  menuRef?: RefObject<HTMLDivElement | null>;
  menuContent?: ReactNode;
  /** Opt-in drag range select. When present the caller resolves clicks itself (via a window
   *  mouseup), so the plain click toggle is skipped. */
  onDragSelectStart?: () => void;
  onDragSelectEnter?: () => void;
  /** Right-click opens the same menu at the click point; only used with `menuContent`. */
  onOpenContextMenu?: (point: { x: number; y: number }) => void;
  contextMenuOpen?: boolean;
  contextMenuAnchor?: { x: number; y: number } | null;
}) {
  const [videoHovering, setVideoHovering] = useState(false);
  const isVideo = kind === "video";
  const durationLabel =
    durationSeconds != null
      ? `${Math.floor(durationSeconds / 60)}:${String(Math.round(durationSeconds % 60)).padStart(2, "0")}`
      : null;
  const imgClassName = `block w-full cursor-pointer ${aspectRatio ? "h-full object-cover" : ""} ${
    cornerRadiusPx == null ? "rounded-md" : ""
  } ${selectMode && selected ? "ring-2 ring-inset ring-blue-500" : ""}`;

  return (
    // The tile's image shares its accessible name with the species card on the collection page,
    // so the e2e tests need this to know they're looking at a photo grid.
    <div data-testid="photo-tile" className="group relative w-full min-w-0">
      <button
        onClick={(e) => {
          if (!selectMode) return onOpen();
          if (!onDragSelectStart) onToggleSelect(e.shiftKey);
        }}
        onMouseDown={(e) => {
          if (selectMode && onDragSelectStart) {
            // Stops the native image-drag ghost from hijacking the range-select gesture.
            e.preventDefault();
            onDragSelectStart();
          }
        }}
        onMouseEnter={() => {
          if (selectMode && onDragSelectEnter) onDragSelectEnter();
          if (isVideo) setVideoHovering(true);
        }}
        onMouseLeave={() => {
          if (isVideo) setVideoHovering(false);
        }}
        onContextMenu={(e) => {
          if (!onOpenContextMenu || selectMode) return;
          e.preventDefault();
          onOpenContextMenu({ x: e.clientX, y: e.clientY });
        }}
        className="block w-full overflow-hidden text-left"
        style={aspectRatio ? { aspectRatio } : undefined}
      >
        {isVideo && videoHovering ? (
          // A poster plus preload="auto" avoids a blank tile while the first frame decodes.
          <video
            src={`/api/photos/${photoId}/video`}
            poster={`/api/photos/${photoId}/thumb`}
            preload="auto"
            autoPlay
            muted
            loop
            playsInline
            style={cornerRadiusPx != null ? { borderRadius: cornerRadiusPx } : undefined}
            className={imgClassName}
          />
        ) : (
          <ProgressiveImg
            thumbSrc={`/api/photos/${photoId}/thumb`}
            fullSrc={`/api/photos/${photoId}/display`}
            alt={alt}
            style={cornerRadiusPx != null ? { borderRadius: cornerRadiusPx } : undefined}
            // ring-inset stays inside the rounded box, so overflow-hidden never clips it square.
            className={imgClassName}
          />
        )}
      </button>
      {isVideo && !videoHovering && (
        <div className="pointer-events-none absolute bottom-2 right-2 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white">
          <span aria-hidden>▶</span>
          {durationLabel && <span>{durationLabel}</span>}
        </div>
      )}
      {selectMode && (
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => onToggleSelect((e.nativeEvent as MouseEvent).shiftKey ?? false)}
          // z-[1]: a caller's `label` overlay renders after this and would otherwise sit on top.
          className="absolute left-2 top-2 z-[1] h-4 w-4 accent-accent"
          aria-label="Select photo"
        />
      )}
      {label}
      {!selectMode && menuContent !== undefined && (
        <DotMenu open={menuOpen} onToggle={onToggleMenu} menuRef={menuRef}>
          {menuContent}
        </DotMenu>
      )}
      {!selectMode && menuContent !== undefined && contextMenuOpen && (
        <DotMenu open={contextMenuOpen} onToggle={onToggleMenu} menuRef={menuRef} anchorPoint={contextMenuAnchor}>
          {menuContent}
        </DotMenu>
      )}
    </div>
  );
}

export default memo(PhotoTile);
