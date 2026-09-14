import { useState, type ReactNode, type RefObject } from "react";
import ProgressiveImg from "./ProgressiveImg";
import DotMenu from "./DotMenu";

// The photo-grid tile shell — image, select-mode checkbox, hover-revealed "⋯" menu trigger, and
// an optional caption — previously hand-rebuilt near-identically in GalleryPage,
// SpeciesDetailPage, and TripDetailPage (same DOM shape, same class strings, same interaction:
// click opens the lightbox unless select mode is on, in which case it toggles selection
// instead). Deliberately does NOT own the dropdown menu's OPEN/CLOSED state itself — each page
// already tracks "which one photo's menu is open" as a single piece of state so opening one
// tile's menu closes any other tile's (see useDropdownMenu), which only works if that state
// lives at the page level, not inside every individual tile. `menuContent`, when provided, is
// rendered as the ENTIRE dropdown panel (including its own width/positioning classes) exactly
// as the caller wants it — panel width can genuinely differ per open state (Gallery's own menu
// widens when its inline "correct the ID" species picker is showing), so this doesn't try to
// impose one fixed shape on every caller's menu.
export default function PhotoTile({
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
  /** Defaults to "image". A "video" tile shows the same poster-frame stills (thumb_path/
   *  display_path are poster webps for a video, see uploads/image.ts's generateVideoDerivatives)
   *  by default, swapping to an autoplaying muted looping preview on hover — real playback with
   *  controls only happens in the Lightbox, not inline in the grid. */
  kind?: "image" | "video";
  /** Only meaningful when kind is "video" — shown in a small corner badge so a video reads as
   *  one at a glance, before a user ever hovers it. */
  durationSeconds?: number | null;
  /** Open the lightbox (or whatever "activate this tile" means) — only called when selectMode is off. */
  onOpen: () => void;
  selectMode: boolean;
  selected: boolean;
  /** shiftKey lets a caller extend the selection as a RANGE from the last-clicked tile instead
   *  of toggling just this one — see GalleryPage's own toggleSelected for the range logic. */
  onToggleSelect: (shiftKey: boolean) => void;
  /** Rendered directly below the image — a caption, star rating, or both, per caller's needs. */
  label?: ReactNode;
  /** Gallery's own dynamic corner radius (scales down at small grid sizes) — omit for the
   *  ordinary fixed `rounded-md` every other caller uses. */
  cornerRadiusPx?: number;
  /** MasonryGrid's clamped per-item ratio (see its own MIN_ASPECT_RATIO comment) — crops the
   *  image to it via object-cover instead of rendering at the photo's full natural height.
   *  Omit outside a masonry context to keep the old natural-aspect, uncropped behavior. */
  aspectRatio?: number;
  menuOpen: boolean;
  onToggleMenu: () => void;
  /** Only meaningful (and only needs to be attached) while menuOpen is true — matches
   *  useDropdownMenu's own "ref only tracks the currently-open one" contract. */
  menuRef?: RefObject<HTMLDivElement | null>;
  menuContent?: ReactNode;
  /** Opt-in click-and-drag range select — a caller that provides this owns the whole
   *  select/toggle decision itself (via a window-level mouseup, since a drag's release can land
   *  outside this tile entirely), so the plain onClick toggle below is skipped whenever this is
   *  present rather than double-handling the same click. Callers that don't pass it (shift-click
   *  is still available everywhere) keep the original click-to-toggle behavior unchanged. */
  onDragSelectStart?: () => void;
  onDragSelectEnter?: () => void;
  /** Right-click support — only meaningful when `menuContent` is also provided (same content,
   *  just a second way to trigger it). `onOpenContextMenu` reports the click's viewport
   *  coordinates so the caller can position `contextMenuAnchor` and open its own dropdown state,
   *  since (same as menuOpen/onToggleMenu above) only the page knows which one tile's menu is
   *  the currently-open one across the whole grid. */
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
    <div className="group relative w-full min-w-0">
      <button
        onClick={(e) => {
          if (!selectMode) return onOpen();
          if (!onDragSelectStart) onToggleSelect(e.shiftKey);
        }}
        onMouseDown={(e) => {
          if (selectMode && onDragSelectStart) {
            // Stops the browser's native image-drag-ghost from starting instead of our own
            // range-select gesture.
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
          // Muted+looped, no controls — a quick preview, not real playback (that only happens
          // in the Lightbox). Falls back to the poster frame instantly on mouseleave/error.
          // `poster` + `preload="auto"` matter: without a poster, the tile shows nothing at all
          // for however long the browser takes to fetch/decode the first real video frame after
          // this element replaces the poster <img> — reading as the whole tile "disappearing"
          // for a beat before playback actually starts, rather than a smooth crossfade.
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
            // ring-inset (not the old ring + ring-offset) matters: ring-offset draws its ring
            // OUTSIDE the image's own box, which this button's overflow-hidden then clips back
            // to a plain square — cutting the corner of that outward ring off square and
            // exposing a sliver of the image's own unrounded corner underneath. An inset ring
            // stays fully inside the image's already-rounded box, so it's never clipped. Blue
            // (not the muted olive `accent` token used for buttons elsewhere) so a selected
            // tile actually reads as selected at a glance.
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
          className="absolute left-2 top-2 h-4 w-4 accent-accent"
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
        <DotMenu
          open={contextMenuOpen}
          onToggle={onToggleMenu}
          menuRef={menuRef}
          anchorPoint={contextMenuAnchor}
        >
          {menuContent}
        </DotMenu>
      )}
    </div>
  );
}
