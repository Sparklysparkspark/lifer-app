import SelectMark from "./SelectMark";
import { SelectedRing } from "./MediaCard";
import { memo, useContext, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { CompactGridContext } from "./compactGrid";
import ProgressiveImg from "./ProgressiveImg";
import PhotoPlaceholder from "./PhotoPlaceholder";
import Menu from "./Menu";

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
  versionCount,
  versionLabel,
  burstCount,
  contextMenuOpen,
  onOpenContextMenu,
  contextMenuAnchor,
}: {
  /** Null shows a placeholder, for an item whose file is gone. */
  photoId: string | null;
  alt: string;
  /** Defaults to "image". A video tile shows its poster frame and plays a muted preview on hover; a
   *  recording shows its waveform with a badge. */
  kind?: "image" | "video" | "audio";
  /** Video only: shown in a corner badge. */
  durationSeconds?: number | null;
  /** More than one: a stack badge ("3 versions") for a photo with prints, edits or exports. */
  versionCount?: number;
  /** A version listed apart from its photo: its name in the same stack badge. */
  versionLabel?: string;
  /** Frames in the photo's burst: more than one shows "+N" for the others. */
  burstCount?: number;
  /** Only called when selectMode is off. */
  onOpen: () => void;
  selectMode: boolean;
  selected: boolean;
  /** shiftKey extends the selection as a range from the last-clicked tile. */
  onToggleSelect: (shiftKey: boolean) => void;
  /** Rendered below the image (caption, rating, or both). */
  label?: ReactNode;
  /** Overrides the default `rounded-control` corners. */
  cornerRadiusPx?: number;
  /** The grid's ratio for this photo; crops via object-cover. Omit for natural aspect. */
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
  const { t } = useTranslation();
  const [videoHovering, setVideoHovering] = useState(false);
  // Phone layout: square corners and no caption, so the grid reads as one seamless sheet.
  const compact = useContext(CompactGridContext);
  if (compact) {
    cornerRadiusPx = 0;
    label = undefined;
  }
  const isVideo = kind === "video";
  const durationLabel =
    durationSeconds != null
      ? `${Math.floor(durationSeconds / 60)}:${String(Math.round(durationSeconds % 60)).padStart(2, "0")}`
      : null;
  const imgClassName = `block w-full cursor-pointer ${aspectRatio ? "h-full object-cover" : ""} ${
    cornerRadiusPx == null ? "rounded-control" : ""
  }`;

  return (
    // The tile's image shares its accessible name with the species card on the collection page,
    // so the e2e tests need this to know they're looking at a photo grid.
    <div data-testid="photo-tile" className="group relative w-full min-w-0">
      {/* raw-control: the whole photo is the button (open, select, drag-select, right-click). */}
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
        className="relative block w-full overflow-hidden text-left"
        style={aspectRatio ? { aspectRatio } : undefined}
      >
        {photoId === null ? (
          <PhotoPlaceholder className={`h-full w-full ${cornerRadiusPx == null ? "rounded-control" : ""}`} />
        ) : isVideo && videoHovering ? (
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
            className={imgClassName}
          />
        )}
        {selectMode && selected && <SelectedRing radiusPx={cornerRadiusPx} />}
        {(versionLabel || (versionCount != null && versionCount > 1)) && (
          <VersionStackBadge
            label={versionLabel ?? t("versions.badge", { count: versionCount })}
            title={versionLabel}
          />
        )}
        {burstCount != null && burstCount > 1 && kind !== "video" && kind !== "audio" && (
          // design-token: a scrim over the photo, as the video badge in the same corner.
          <span className="pointer-events-none absolute bottom-2 right-2 rounded-badge bg-black/60 px-1.5 py-0.5 text-caption text-white">
            <span aria-hidden>{t("bursts.badge", { count: burstCount - 1 })}</span>
            <span className="sr-only">{t("bursts.badgeLabel", { count: burstCount })}</span>
          </span>
        )}
      </button>
      {(isVideo ? !videoHovering : kind === "audio") && (
        <div className="pointer-events-none absolute bottom-2 right-2 flex items-center gap-1 rounded-badge bg-black/60 px-1.5 py-0.5 text-caption text-white">
          <span aria-hidden>{isVideo ? "▶" : "♪"}</span>
          {!isVideo && <span className="sr-only">{t("photoTile.recording")}</span>}
          {durationLabel && <span>{durationLabel}</span>}
        </div>
      )}
      {selectMode && (
        <SelectMark
          checked={selected}
          onChange={(e) => onToggleSelect((e.nativeEvent as MouseEvent).shiftKey ?? false)}
          label={t("photoTile.select")}
        />
      )}
      {label}
      {!selectMode && menuContent !== undefined && (
        <Menu open={menuOpen} onToggle={onToggleMenu} menuRef={menuRef}>
          {menuContent}
        </Menu>
      )}
      {!selectMode && menuContent !== undefined && contextMenuOpen && (
        <Menu open={contextMenuOpen} onToggle={onToggleMenu} menuRef={menuRef} anchorPoint={contextMenuAnchor}>
          {menuContent}
        </Menu>
      )}
    </div>
  );
}

export default memo(PhotoTile);

/** The stack badge in a photo's corner: how many versions it has, or which version it is. */
export function VersionStackBadge({ label, title }: { label: string; title?: string }) {
  return (
    <span
      title={title}
      // design-token: a scrim over the photo, as the video badge beside it.
      className="pointer-events-none absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-badge bg-black/60 px-1.5 py-0.5 text-caption text-white"
    >
      <StackIcon />
      <span className="truncate">{label}</span>
    </span>
  );
}

/** Two offset frames: a photo with versions behind it. */
export function StackIcon({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="1.5" y="5" width="9.5" height="9.5" rx="1.5" />
      <path d="M5 2.5h7a1.5 1.5 0 0 1 1.5 1.5v7" />
    </svg>
  );
}
