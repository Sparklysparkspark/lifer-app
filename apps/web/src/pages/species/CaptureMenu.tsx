import { useEffect, useRef, useState, type MouseEvent } from "react";
import { TagEditor } from "../../components/Lightbox";
import { useLatest } from "../../hooks/useLatest";
import SpeciesPicker from "../../components/SpeciesPicker";
import RegionBrowser from "../../components/RegionBrowser";
import StarRating from "../../components/StarRating";
import { downloadFile } from "../../lib/downloadFile";
import { locationText } from "./photoGridHelpers";
import type { SpeciesCapture } from "./types";

const MENU_ITEM = "block w-full px-3 py-1.5 text-left text-ink hover:bg-surface-muted";

// Mounted only for the tile whose menu is open, so its sub-editor state resets on close.
export default function CaptureMenu({
  capture: c,
  isCover,
  canRevealInFinder,
  tagOptions,
  onClose,
  onRate,
  onSetCover,
  onAddToAlbum,
  onReveal,
  onCopyPath,
  onTagSpecies,
  onReassign,
  onSetRegion,
  onSetLocationLabel,
  onLocationSettled,
  onTagsChange,
  onDelete,
}: {
  capture: SpeciesCapture;
  isCover: boolean;
  canRevealInFinder: boolean;
  tagOptions: string[];
  onClose: () => void;
  onRate: (rating: number | null) => void;
  onSetCover: () => void;
  onAddToAlbum: () => void;
  onReveal: () => void;
  onCopyPath: () => void;
  onTagSpecies: (speciesId: string) => void;
  onReassign: (speciesId: string) => void;
  onSetRegion: (regionId: string | null) => void;
  onSetLocationLabel: (label: string) => void;
  onLocationSettled: () => void;
  onTagsChange: (tags: string[]) => void;
  onDelete: () => void;
}) {
  const [editor, setEditor] = useState<"tagSpecies" | "reassign" | "location" | "tags" | null>(null);
  const regionChanged = useRef(false);
  const settle = useLatest(onLocationSettled);
  useEffect(
    () => () => {
      if (regionChanged.current) settle.current();
    },
    [settle],
  );

  // stopPropagation: the button swaps itself for its editor before the click bubbles, and
  // useDropdownMenu's outside-click check then sees a detached node and closes the menu.
  function openEditor(e: MouseEvent, which: NonNullable<typeof editor>) {
    e.stopPropagation();
    setEditor(which);
  }

  const location = locationText(c);

  return (
    <div className="absolute right-0 top-full z-10 mt-1 max-h-[70vh] w-64 overflow-y-auto overflow-x-hidden rounded-md border border-line bg-surface py-1 text-xs shadow-lg">
      {/* Stays open on click so a rating can be nudged without reopening the menu. */}
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5">
        <span className="text-muted">Rate</span>
        <StarRating rating={c.quality_rating} onRate={onRate} />
      </div>
      <button onClick={onSetCover} className={MENU_ITEM}>
        {isCover ? "Featured photo ✓" : "Set as featured photo"}
      </button>
      <button onClick={onAddToAlbum} className={MENU_ITEM}>
        Add to album…
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
      {editor === "tagSpecies" ? (
        <div className="px-3 py-1.5">
          <SpeciesPicker autoFocus placeholder="Also features…" onSelect={(s) => onTagSpecies(s.id)} />
        </div>
      ) : (
        <button onClick={(e) => openEditor(e, "tagSpecies")} className={MENU_ITEM}>
          Also features another species…
        </button>
      )}
      {editor === "reassign" ? (
        <div className="px-3 py-1.5">
          <SpeciesPicker autoFocus placeholder="Correct ID to…" onSelect={(s) => onReassign(s.id)} />
        </div>
      ) : (
        <button onClick={(e) => openEditor(e, "reassign")} className={MENU_ITEM}>
          Correct the ID…
        </button>
      )}
      {editor === "location" ? (
        <div className="space-y-2 px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
          <input
            type="text"
            autoFocus
            defaultValue={c.location_label ?? ""}
            placeholder="Custom place name (e.g. Prince George)…"
            onBlur={(e) => {
              if (e.target.value.trim() !== (c.location_label ?? "")) onSetLocationLabel(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            className="w-full rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink outline-none focus:border-accent"
          />
          <p className="text-[10px] uppercase tracking-wide text-muted">Attached to region</p>
          {/* Fires on every drill-down click, so it saves without closing the menu. */}
          <RegionBrowser
            regionId={c.region_id}
            onChange={(regionId) => {
              regionChanged.current = true;
              onSetRegion(regionId);
            }}
            allowAnyRegion
          />
        </div>
      ) : (
        <button onClick={(e) => openEditor(e, "location")} className={MENU_ITEM}>
          {location ? `Location: ${location}` : "Set location…"}
        </button>
      )}
      {editor === "tags" ? (
        <div className="px-3 py-1.5">
          <TagEditor tags={c.tags} existingTags={tagOptions} onChange={onTagsChange} />
        </div>
      ) : (
        <button onClick={(e) => openEditor(e, "tags")} className={MENU_ITEM}>
          Edit tags…
        </button>
      )}
      <button
        onClick={onDelete}
        className="block w-full px-3 py-1.5 text-left text-red-600 hover:bg-surface-muted dark:text-red-400"
      >
        Delete {c.photo_kind === "video" ? "video" : "photo"}
      </button>
    </div>
  );
}
