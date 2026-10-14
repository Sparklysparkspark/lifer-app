import type { CSSProperties, Ref } from "react";
import StarRating from "../../components/StarRating";
import { downloadFile } from "../../lib/downloadFile";
import { MENU_ITEM, MENU_ITEM_DANGER, MENU_PANEL, MENU_SEPARATOR } from "../../lib/menuClasses";
import { locationText } from "./photoGridHelpers";
import type { CaptureEdit } from "../../components/CaptureEditModal";
import type { SpeciesCapture } from "./types";

// Mounted only for the tile whose menu is open, so its sub-editor state resets on close.
export default function CaptureMenu({
  ref,
  style,
  capture: c,
  isCover,
  canRevealInFinder,
  onClose,
  onRate,
  onSetCover,
  onAddToAlbum,
  onReveal,
  onCopyPath,
  onEdit,
  onDelete,
}: {
  /** From DotMenu, which measures the panel and moves it to stay on the page. */
  ref?: Ref<HTMLDivElement>;
  style?: CSSProperties;
  capture: SpeciesCapture;
  isCover: boolean;
  canRevealInFinder: boolean;
  onClose: () => void;
  onRate: (rating: number | null) => void;
  onSetCover: () => void;
  onAddToAlbum: () => void;
  onReveal: () => void;
  onCopyPath: () => void;
  /** Opens one of the longer edits in a dialog (the page closes this menu). */
  onEdit: (edit: CaptureEdit) => void;
  onDelete: () => void;
}) {
  const location = locationText(c);

  return (
    <div
      ref={ref}
      style={style}
      className={`absolute right-0 top-full z-10 mt-1 max-h-[70vh] w-64 overflow-y-auto overflow-x-hidden ${MENU_PANEL}`}
    >
      {/* Stays open on click so a rating can be nudged without reopening the menu. */}
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5">
        <span className="text-muted">Rate</span>
        <StarRating rating={c.quality_rating} onRate={onRate} />
      </div>
      <button onClick={onSetCover} className={MENU_ITEM}>
        {isCover ? "Featured photo ✓" : "Set as featured photo"}
      </button>
      <button onClick={onAddToAlbum} className={MENU_ITEM}>
        Add to album
      </button>
      {c.original_ref && c.original_available === false ? (
        <p className="w-full px-3 py-1.5 text-left text-muted">
          {c.original_volume_label
            ? `Connect "${c.original_volume_label}" to view this original`
            : "Original unavailable"}
        </p>
      ) : (
        c.original_ref && (
          <>
            {/* A RAW-only original is already covered by "Download RAW". */}
            {c.original_kind !== "raw" && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose();
                  downloadFile(`/api/photos/${c.photo_id}/original?download=1`, "original.jpg");
                }}
                className={MENU_ITEM}
              >
                Download original
              </button>
            )}
            {c.has_raw_original && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose();
                  downloadFile(`/api/photos/${c.photo_id}/original-raw?download=1`, "original.raw");
                }}
                className={MENU_ITEM}
              >
                Download RAW
              </button>
            )}
            {!c.original_managed && (
              <>
                {canRevealInFinder && (
                  <button onClick={onReveal} className={MENU_ITEM}>
                    Reveal in Finder
                  </button>
                )}
                <button onClick={onCopyPath} className={MENU_ITEM}>
                  Copy original's path
                </button>
              </>
            )}
          </>
        )
      )}
      <button onClick={() => onEdit("tagSpecies")} className={MENU_ITEM}>
        Also features another species
      </button>
      <button onClick={() => onEdit("reassign")} className={MENU_ITEM}>
        Correct the ID
      </button>
      <button onClick={() => onEdit("location")} className={MENU_ITEM}>
        {location ? `Location: ${location}` : "Set location"}
      </button>
      <button onClick={() => onEdit("tags")} className={MENU_ITEM}>
        Edit tags
      </button>
      <div className={MENU_SEPARATOR} />
      <button onClick={onDelete} className={MENU_ITEM_DANGER}>
        Delete {c.photo_kind === "video" ? "video" : "photo"}
      </button>
    </div>
  );
}
