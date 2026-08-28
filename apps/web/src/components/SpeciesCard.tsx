import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { CollectionItem } from "@lifer/shared";
import { api } from "../api/client";
import { cropToImageStyle } from "../lib/crop";
import { useFitText } from "../hooks/useFitText";
import ProgressiveImg from "./ProgressiveImg";
import PhotoPlaceholder from "./PhotoPlaceholder";

const TIER_LABEL: Record<string, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
  unrated: "Unrated",
};

export default function SpeciesCard({
  item,
  regionId,
  backLabel,
  onArchived,
  showVolumeBadge,
}: {
  item: CollectionItem;
  regionId?: string;
  /** What SpeciesDetailPage's own back link should say — this card is reused from more than
   *  one page (the main collection, a trip's species view), so the right label depends on
   *  which one rendered it. Omitted on the main collection, whose "Collection" default is
   *  already correct. See BackToCollectionLink's own comment. */
  backLabel?: string;
  /** Called after this card's own archive action succeeds — archived species are excluded
   *  server-side, so the parent needs to refetch to actually remove this card from view. */
  onArchived?: () => void;
  /** Whether to show which external drive the cover photo lives on — passed down from
   *  useStorageVolumes().multiDriveInUse rather than checked per-card, so the badge only
   *  ever shows up once there's actually more than one place photos could be (see
   *  ~/.claude/plans/multi-drive-storage.md). */
  showVolumeBadge?: boolean;
}) {
  const isUnseen = item.state === "unseen";
  const isSeen = item.state === "seen";
  // A reference photo whose file has since moved or been deleted would otherwise show the
  // browser's own broken-image icon — falls back to the same "no photo" placeholder instead.
  const [referencePhotoFailed, setReferencePhotoFailed] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const displayName = item.commonName ?? item.scientificName;
  const { ref: nameRef, fontSize: nameFontSize } = useFitText([displayName]);

  // A hover-only affordance never surfaces on touch devices, and clicking a button stacked
  // over a whole-card <Link> is fragile — a small always-visible menu button, closed by any
  // outside click, is discoverable everywhere and only navigates when its own item is chosen.
  useEffect(() => {
    if (!menuOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("click", onClickOutside);
    return () => document.removeEventListener("click", onClickOutside);
  }, [menuOpen]);

  function toggleMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen((open) => !open);
  }

  async function archive(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen(false);
    setArchiving(true);
    try {
      await api.post(`/species/${item.speciesId}/archive`);
      onArchived?.();
    } catch {
      alert("Couldn't archive this species — try again.");
    } finally {
      setArchiving(false);
    }
  }

  return (
    <Link
      to={regionId ? `/species/${item.speciesId}?regionId=${regionId}` : `/species/${item.speciesId}`}
      state={backLabel ? { backLabel } : undefined}
      className={`group block overflow-hidden rounded-lg border border-line bg-surface transition hover:shadow-md ${
        isUnseen ? "opacity-60" : ""
      }`}
    >
      <div className={`relative aspect-square overflow-hidden bg-surface-muted ${isSeen ? "grayscale" : ""}`}>
        {item.coverPhotoUrl && !referencePhotoFailed ? (
          // Only a captured photo (served from /api/photos/.../thumb) has a matching
          // /display derivative to upgrade to; an external reference-photo thumbnail has no
          // such counterpart to swap in, so it's left as-is.
          item.coverPhotoUrl.startsWith("/api/photos/") ? (
            <ProgressiveImg
              thumbSrc={item.coverPhotoUrl}
              fullSrc={item.coverPhotoUrl.replace(/\/thumb$/, "/display")}
              alt={item.commonName ?? item.scientificName}
              className="h-full w-full"
              style={cropToImageStyle(item.cardCropX, item.cardCropY, item.cardCropSize)}
            />
          ) : (
            <img
              src={item.coverPhotoUrl}
              alt={item.commonName ?? item.scientificName}
              className="h-full w-full object-cover"
              style={{
                objectPosition: `${item.referenceFocalX ?? 50}% ${item.referenceFocalY ?? 50}%`,
              }}
              onError={() => setReferencePhotoFailed(true)}
            />
          )
        ) : (
          <PhotoPlaceholder className="h-full w-full" />
        )}
        {isSeen && (
          <span
            className="absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-white/90 text-xs font-bold text-stone-600 shadow"
            title="Seen, not yet photographed"
          >
            ✓
          </span>
        )}
        {showVolumeBadge && item.coverVolumeLabel && (
          <span
            className="absolute left-1.5 bottom-1.5 max-w-[80%] truncate rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white shadow"
            title={`This photo is on the "${item.coverVolumeLabel}" drive`}
          >
            {item.coverVolumeLabel}
          </span>
        )}
        {/* Archiving a species you've already collected/seen would be a no-op server-side
           (see ALREADY_OWNED_SQL), so the menu doesn't offer it there at all. */}
        {/* On a real pointer (hover-capable) device, the button sits top-right and only
           appears on card hover, so it doesn't compete for attention with the whole grid
           visible at once. A touch device has no hover to reveal it with, so there it's
           pinned bottom-right and always visible instead — same reasoning that made
           bottom-right the natural "always-on" corner. The dropdown opens the opposite
           direction from wherever the button sits, so it never gets clipped by this
           container's own overflow-hidden. */}
        {item.state !== "collected" && (
          <div ref={menuRef} className="absolute bottom-1.5 right-1.5 [@media(hover:hover)]:bottom-auto [@media(hover:hover)]:top-1.5">
            <button
              onClick={toggleMenu}
              title="More actions"
              className={`flex h-6 w-6 items-center justify-center rounded-full bg-white/90 text-sm leading-none text-stone-600 shadow transition hover:bg-white ${
                menuOpen
                  ? "opacity-100"
                  : "opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
              }`}
            >
              ⋮
            </button>
            {menuOpen && (
              <div className="absolute bottom-7 right-0 z-10 min-w-[8rem] rounded-md border border-line bg-surface py-1 shadow-lg [@media(hover:hover)]:bottom-auto [@media(hover:hover)]:top-7">
                <button
                  onClick={archive}
                  disabled={archiving}
                  title="Stop counting this toward your to-collect total (can be undone from the Archived page)"
                  className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted disabled:opacity-50"
                >
                  {archiving ? "Archiving…" : "Archive"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="p-3">
        <p
          ref={nameRef}
          className="overflow-hidden font-medium leading-tight text-ink"
          style={{ fontSize: nameFontSize }}
        >
          {displayName}
        </p>
        <p className="truncate text-xs italic text-muted">{item.scientificName}</p>
        {(item.tier || item.localTier || item.endemic || item.vagrant) && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {item.tier && (
              <span
                className={
                  item.tier === "unrated"
                    ? "inline-block rounded-full border border-dashed border-line px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted"
                    : "inline-block rounded-full bg-surface-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted"
                }
                title={item.tier === "unrated" ? "Not enough data yet to rate how hard this is to find" : undefined}
              >
                {TIER_LABEL[item.tier] ?? item.tier}
              </span>
            )}
            {/* Region-scoped rarity — only present when viewing a region's checklist,
               ranked against species actually found there instead of the global,
               effort-weighted score. */}
            {item.localTier && (
              <span
                className="inline-block rounded-full border border-line px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted"
                title="Rarity ranked against other species in this region specifically"
              >
                {TIER_LABEL[item.localTier] ?? item.localTier} here
              </span>
            )}
            {item.endemic && (
              <span
                className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-700"
                title="Only ever recorded in one country"
              >
                Endemic
              </span>
            )}
            {/* Region-scoped, same as localTier above — records here cluster in very few
               years rather than spreading out, a real vagrancy signature explaining why
               localTier reads rarer than raw record count alone would suggest. */}
            {item.vagrant && (
              <span
                className="inline-block rounded-full bg-sky-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-sky-700"
                title="Records here are concentrated in very few years — likely a vagrant, not an established local presence"
              >
                Vagrant
              </span>
            )}
          </div>
        )}
      </div>
    </Link>
  );
}
