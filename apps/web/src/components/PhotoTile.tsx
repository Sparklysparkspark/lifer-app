import type { ReactNode, RefObject } from "react";
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
}: {
  photoId: string;
  alt: string;
  /** Open the lightbox (or whatever "activate this tile" means) — only called when selectMode is off. */
  onOpen: () => void;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
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
}) {
  return (
    <div className="group relative w-full min-w-0">
      <button
        onClick={() => (selectMode ? onToggleSelect() : onOpen())}
        className="block w-full overflow-hidden text-left"
        style={aspectRatio ? { aspectRatio } : undefined}
      >
        <ProgressiveImg
          thumbSrc={`/api/photos/${photoId}/thumb`}
          fullSrc={`/api/photos/${photoId}/display`}
          alt={alt}
          style={cornerRadiusPx != null ? { borderRadius: cornerRadiusPx } : undefined}
          // ring-inset (not the old ring + ring-offset) matters: ring-offset draws its ring
          // OUTSIDE the image's own box, which this button's overflow-hidden then clips back to
          // a plain square — cutting the corner of that outward ring off square and exposing a
          // sliver of the image's own unrounded corner underneath. An inset ring stays fully
          // inside the image's already-rounded box, so it's never clipped. Blue (not the muted
          // olive `accent` token used for buttons elsewhere) so a selected tile actually reads
          // as selected at a glance.
          className={`block w-full cursor-pointer ${aspectRatio ? "h-full object-cover" : ""} ${
            cornerRadiusPx == null ? "rounded-md" : ""
          } ${selectMode && selected ? "ring-2 ring-inset ring-blue-500" : ""}`}
        />
      </button>
      {selectMode && (
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
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
    </div>
  );
}
