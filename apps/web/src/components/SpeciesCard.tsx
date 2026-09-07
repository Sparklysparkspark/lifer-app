import { memo, useState } from "react";
import { Link } from "react-router-dom";
import type { CollectionItem } from "@lifer/shared";
import { api } from "../api/client";
import { cropToImageStyle } from "../lib/crop";
import { useFitText } from "../hooks/useFitText";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import ProgressiveImg from "./ProgressiveImg";
import PhotoPlaceholder from "./PhotoPlaceholder";
import DotMenu from "./DotMenu";

const TIER_LABEL: Record<string, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
  unrated: "Unrated",
};

// Memoized — grouped views (GroupedSpeciesGrid) can have many groups mounting cards
// concurrently; without this, every scroll-triggered visibleCount bump re-rendered EVERY
// already-mounted card across every group (not just the newly revealed ones), each re-running
// useFitText's synchronous layout reflow. That's what turned ordinary scrolling in a grouped
// view into a sustained freeze, not just the one-time switch (see the visibleCount reset above).
function SpeciesCard({
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
  const isTarget = item.state === "target";
  // A reference photo whose file has since moved or been deleted would otherwise show the
  // browser's own broken-image icon — falls back to the same "no photo" placeholder instead.
  const [referencePhotoFailed, setReferencePhotoFailed] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [busy, setBusy] = useState(false);
  const { openKey: menuOpen, setOpenKey: setMenuOpen, ref: menuRef } = useDropdownMenu<true>();
  const displayName = item.commonName ?? item.scientificName;
  const { ref: nameRef, fontSize: nameFontSize } = useFitText([displayName]);

  function toggleMenu() {
    setMenuOpen(menuOpen ? null : true);
  }

  async function archive(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen(null);
    setArchiving(true);
    try {
      await api.post(`/species/${item.speciesId}/archive`);
      onArchived?.();
    } catch {
      alert("Couldn't archive this species. Try again.");
    } finally {
      setArchiving(false);
    }
  }

  // The backend's INSERT ... ON CONFLICT DO NOTHING can't switch a "seen" row straight into
  // "target" (or vice versa) — undoOtherState clears whichever one is currently set before the
  // real patch, so switching between them is one click here even though it's two requests.
  async function runStateChange(e: React.MouseEvent, method: "patch" | "delete", path: "seen" | "target", undoOtherState?: "seen" | "target") {
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen(null);
    setBusy(true);
    try {
      if (undoOtherState) await api.delete(`/species/${item.speciesId}/${undoOtherState}`);
      await api[method](`/species/${item.speciesId}/${path}`);
      onArchived?.();
    } catch {
      alert("Couldn't update this species. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Link
      to={regionId ? `/species/${item.speciesId}?regionId=${regionId}` : `/species/${item.speciesId}`}
      state={backLabel ? { backLabel } : undefined}
      className={`group block overflow-hidden rounded-lg border border-line bg-surface transition hover:shadow-md ${
        isUnseen || isTarget ? "opacity-60" : ""
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
        {/* Archiving a species you've already collected would be a no-op server-side (see
           ALREADY_OWNED_SQL), so the menu doesn't offer it there at all — but seen/target
           marking still make sense right up until it's actually collected. */}
        {item.state !== "collected" && (
          <DotMenu open={!!menuOpen} onToggle={toggleMenu} menuRef={menuRef}>
            <div className="absolute right-0 top-full z-10 mt-1 min-w-[9rem] rounded-md border border-line bg-surface py-1 shadow-lg">
              {item.state === "seen" ? (
                <button
                  onClick={(e) => runStateChange(e, "delete", "seen")}
                  disabled={busy}
                  className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted disabled:opacity-50"
                >
                  Mark as unseen
                </button>
              ) : (
                <button
                  onClick={(e) => runStateChange(e, "patch", "seen", item.state === "target" ? "target" : undefined)}
                  disabled={busy}
                  className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted disabled:opacity-50"
                >
                  Mark as seen
                </button>
              )}
              {item.state === "target" ? (
                <button
                  onClick={(e) => runStateChange(e, "delete", "target")}
                  disabled={busy}
                  className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted disabled:opacity-50"
                >
                  Remove from targets
                </button>
              ) : (
                <button
                  onClick={(e) => runStateChange(e, "patch", "target", item.state === "seen" ? "seen" : undefined)}
                  disabled={busy}
                  className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted disabled:opacity-50"
                >
                  Add to targets
                </button>
              )}
              <button
                onClick={archive}
                disabled={archiving}
                title="Stop counting this toward your to-collect total (can be undone from the Archived page)"
                className="block w-full border-t border-line px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted disabled:opacity-50"
              >
                {archiving ? "Archiving…" : "Archive"}
              </button>
            </div>
          </DotMenu>
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
        {(item.tier || item.localTier || item.endemic || item.vagrant || item.isGhost || item.isLost || item.rediscoveredGhost || item.rediscoveredLost) && (
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
                title="How rare and hard to find this species is in this region specifically"
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
                title="Records here are concentrated in very few years, likely a vagrant, not an established local presence"
              >
                Vagrant
              </span>
            )}
            {/* Global documentation is sparse (few total records anywhere, or no reference
               photo found) but the species is verified reachable — not deep-sea, not silent
               since before 1950. A "you'd be one of few who's photographed this" badge. */}
            {item.isGhost && (
              <span
                className="inline-block rounded-full bg-violet-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-violet-700"
                title="Rarely documented anywhere, but still out there to find"
              >
                Ghost
              </span>
            )}
            {/* Nothing recorded anywhere in 25+ years. */}
            {item.isLost && (
              <span
                className="inline-block rounded-full bg-rose-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-rose-700"
                title="Not recorded anywhere in over 25 years"
              >
                Lost
              </span>
            )}
            {/* Was Ghost/Lost the moment you collected it, but isn't anymore — a permanent
               record of that moment (migration 069), even after fresh global data catches up
               and clears the live badge above. */}
            {(item.rediscoveredGhost || item.rediscoveredLost) && (
              <span
                className="inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-emerald-700"
                title="Rare or undocumented when you found it. You helped rediscover this species."
              >
                Rediscovered
              </span>
            )}
          </div>
        )}
      </div>
    </Link>
  );
}

export default memo(SpeciesCard);
