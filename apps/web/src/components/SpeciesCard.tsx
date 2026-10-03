import { memo, useState } from "react";
import { Link } from "react-router-dom";
import type { CollectionItem } from "@lifer/shared";
import { api } from "../api/client";
import { cropToImageStyle } from "../lib/crop";
import { TIER_LABEL } from "../lib/speciesGroups";
import { useFitText } from "../hooks/useFitText";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { useConfirm } from "../hooks/useConfirm";
import { useToast } from "../hooks/useToast";
import ProgressiveImg from "./ProgressiveImg";
import PhotoPlaceholder from "./PhotoPlaceholder";
import DotMenu from "./DotMenu";
import TierDetailsModal from "./TierDetailsModal";
import NameChangedModal from "./NameChangedModal";

// What a card action did, so the parent can patch its list instead of reloading: a field patch,
// the species leaving this view, or "reload" after a failed optimistic change.
export type SpeciesChange = Partial<CollectionItem> | "removed" | "reload";
export type SpeciesChangeHandler = (speciesId: string | string[], change: SpeciesChange) => void;

// Memoized: a scroll-triggered reveal in a grouped grid would otherwise re-render every mounted
// card, each re-running useFitText's layout read.
function SpeciesCard({
  item,
  regionId,
  regionName,
  countryRegionId,
  countryRegionName,
  backLabel,
  onChanged,
  showVolumeBadge,
  hideLabels,
  hideNames,
  hideScientificName,
  compact,
}: {
  item: CollectionItem;
  regionId?: string;
  /** Display name of regionId, used to label the province-vs-country hide picker. */
  regionName?: string;
  /** The enclosing country when regionId is a province. Only when it differs from regionId
   *  does "Hide from this region" offer a province-vs-country choice. */
  countryRegionId?: string;
  countryRegionName?: string;
  /** Label for SpeciesDetailPage's back link when the card is shown outside the collection. */
  backLabel?: string;
  /** Called after a mark seen/target, archive, hide or remove. Must be stable (the card is memoized). */
  onChanged?: SpeciesChangeHandler;
  /** Show which external drive the cover photo lives on (only when more than one is in use). */
  showVolumeBadge?: boolean;
  /** Skip every badge in the status row. */
  hideLabels?: boolean;
  /** Just the photo, no name box. */
  hideNames?: boolean;
  /** Common name only. */
  hideScientificName?: boolean;
  /** The smallest card sizes: tighter spacing so the name box isn't mostly empty space. */
  compact?: boolean;
}) {
  const isUnseen = item.state === "unseen";
  const isSeen = item.state === "seen";
  const isCollected = item.state === "collected";
  // Independent of state: a collected species can still be a target (for a better photo).
  const isTarget = item.isTarget;
  // A reference photo whose file moved or was deleted falls back to the placeholder.
  const [referencePhotoFailed, setReferencePhotoFailed] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [removingOtherTaxa, setRemovingOtherTaxa] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tierOpen, setTierOpen] = useState(false);
  const [nameChangedOpen, setNameChangedOpen] = useState(false);
  // The badges sit inside the card's link: open the tier's details instead of following it.
  const openTier = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setTierOpen(true);
  };
  const localNoData = !!regionId && !item.localTier && (item.localTierReason === "thin_data" || item.localTierReason === "no_data" || item.localTierReason === "few_photos");
  const { openKey: menuOpen, setOpenKey: setMenuOpen, ref: menuRef } = useDropdownMenu<true>();
  const confirm = useConfirm();
  const toast = useToast();
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
      onChanged?.(item.speciesId, "removed");
    } catch {
      toast.error("Couldn't archive this species. Try again.");
    } finally {
      setArchiving(false);
    }
  }

  const [hidingFromRegion, setHidingFromRegion] = useState(false);
  const [hidePickerOpen, setHidePickerOpen] = useState(false);
  const [hideProvinceChecked, setHideProvinceChecked] = useState(true);
  const [hideCountryChecked, setHideCountryChecked] = useState(false);
  const hasCountryChoice = !!(regionId && countryRegionId && countryRegionId !== regionId);

  // Hides the species from this region's checklist only (e.g. a vagrant), leaving its global
  // record and other regions alone.
  async function hideFromRegion(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!regionId) return;
    if (hasCountryChoice) {
      setHidePickerOpen(true);
      return;
    }
    setMenuOpen(null);
    setHidingFromRegion(true);
    try {
      await api.post(`/regions/${regionId}/species/${item.speciesId}/hide`);
      onChanged?.(item.speciesId, "removed");
    } catch {
      toast.error("Couldn't hide this species from this region. Try again.");
    } finally {
      setHidingFromRegion(false);
    }
  }

  // Province and country are independent scopes (a vagrant in BC can stay visible in the rest
  // of Canada), so each checked box is its own hide row.
  async function confirmHidePicker(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!regionId) return;
    const targetIds = [hideProvinceChecked ? regionId : null, hideCountryChecked ? countryRegionId : null].filter(
      (id): id is string => !!id,
    );
    if (targetIds.length === 0) return;
    setMenuOpen(null);
    setHidingFromRegion(true);
    try {
      await Promise.all(targetIds.map((id) => api.post(`/regions/${id}/species/${item.speciesId}/hide`)));
      setHidePickerOpen(false);
      onChanged?.(item.speciesId, "removed");
    } catch {
      toast.error("Couldn't hide this species. Try again.");
    } finally {
      setHidingFromRegion(false);
    }
  }

  // Other Taxa species have no pack to fall back on, so deleting is the only way back from one
  // added by mistake. The server refuses once a photo exists, so the menu only offers it before.
  async function removeOtherTaxa(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen(null);
    const ok = await confirm({
      title: "Remove this species?",
      message: "This can't be undone. You'd need to search and add it again from iNaturalist.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setRemovingOtherTaxa(true);
    try {
      await api.delete(`/species/${item.speciesId}/other-taxa`);
      onChanged?.(item.speciesId, "removed");
    } catch {
      toast.error("Couldn't remove this species. Try again.");
    } finally {
      setRemovingOtherTaxa(false);
    }
  }

  // Applied locally first; a failure asks the parent to reload the real state.
  async function runStateChange(e: React.MouseEvent, method: "patch" | "delete", path: "seen" | "target") {
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen(null);
    const patch: Partial<CollectionItem> =
      path === "seen" ? { state: method === "patch" ? "seen" : "unseen" } : { isTarget: method === "patch" };
    onChanged?.(item.speciesId, patch);
    setBusy(true);
    try {
      await api[method](`/species/${item.speciesId}/${path}`);
    } catch {
      toast.error("Couldn't update this species. Try again.");
      onChanged?.(item.speciesId, "reload");
    } finally {
      setBusy(false);
    }
  }

  // The card is one big Link, so a click right after drag-selecting the name would navigate and
  // drop the selection. Skip navigating when the click follows a real text selection.
  function handleClickCapture(e: React.MouseEvent) {
    if ((window.getSelection()?.toString().length ?? 0) > 0) {
      e.preventDefault();
    }
  }

  return (
    <>
    <Link
      to={regionId ? `/species/${item.speciesId}?regionId=${regionId}` : `/species/${item.speciesId}`}
      state={backLabel ? { backLabel } : undefined}
      onClickCapture={handleClickCapture}
      // WebKit treats a drag on a link as "drag the link out", which swallows text selection.
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      // No overflow-hidden or opacity on the card itself: either would clip or dim the menu.
      // The image box and text block carry their own clipping and dimming instead.
      className="group block rounded-lg border border-line bg-surface transition hover:shadow-md"
    >
      {/* The menu lives outside the overflow-hidden image box so its panel isn't clipped. */}
      <div className="relative">
        {/* clip-path as well as the radius: WebKit leaves an oversized cropped photo's corners
            unclipped by overflow-hidden alone. Radius is the card's minus its 1px border. */}
        <div
          className={`relative aspect-square overflow-hidden ${
            hideNames
              ? "rounded-[calc(0.5rem-1px)] [clip-path:inset(0_round_calc(0.5rem-1px))]"
              : "rounded-t-[calc(0.5rem-1px)] [clip-path:inset(0_round_calc(0.5rem-1px)_calc(0.5rem-1px)_0_0)]"
          } bg-surface-muted ${isSeen ? "grayscale" : ""} ${
            isUnseen || (isTarget && !isCollected) ? "opacity-60" : ""
          }`}
        >
        {item.coverPhotoUrl && !referencePhotoFailed ? (
          // Only a captured photo has a /display derivative to upgrade to.
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
        </div>
        <DotMenu open={!!menuOpen} onToggle={toggleMenu} menuRef={menuRef}>
          <div className="absolute right-0 top-full z-10 mt-1 min-w-[9rem] rounded-md border border-line bg-surface py-1 shadow-lg">
            {/* Seen/unseen only makes sense before it's actually collected. */}
            {!isCollected &&
              (isSeen ? (
                <button
                  onClick={(e) => runStateChange(e, "delete", "seen")}
                  disabled={busy}
                  className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted disabled:opacity-50"
                >
                  Mark as unseen
                </button>
              ) : (
                <button
                  onClick={(e) => runStateChange(e, "patch", "seen")}
                  disabled={busy}
                  className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted disabled:opacity-50"
                >
                  Mark as seen
                </button>
              ))}
            {/* Independent of state: a collected species can still be targeted. */}
            {isTarget ? (
              <button
                onClick={(e) => runStateChange(e, "delete", "target")}
                disabled={busy}
                className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted disabled:opacity-50"
              >
                Remove from targets
              </button>
            ) : (
              <button
                onClick={(e) => runStateChange(e, "patch", "target")}
                disabled={busy}
                className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted disabled:opacity-50"
              >
                Add to targets
              </button>
            )}
            {/* Archiving a collected species is a no-op server-side. */}
            {!isCollected && (
              <button
                onClick={archive}
                disabled={archiving}
                title="Stop counting this toward your to-collect total (can be undone from the Archived page)"
                className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted disabled:opacity-50"
              >
                {archiving ? "Archiving…" : "Archive"}
              </button>
            )}
            {regionId && !isCollected && !hidePickerOpen && (
              <button
                onClick={hideFromRegion}
                disabled={hidingFromRegion}
                title="Hide this species from this region's checklist only. It still shows up in other regions it's on."
                className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted disabled:opacity-50"
              >
                {hidingFromRegion ? "Hiding…" : "Hide from this region"}
              </button>
            )}
            {regionId && hidePickerOpen && (
              <div className="px-3 py-2 text-xs text-ink" onClick={(e) => e.stopPropagation()}>
                <p className="mb-1.5 font-medium">Hide from:</p>
                <label className="flex items-center gap-1.5 py-0.5">
                  <input
                    type="checkbox"
                    checked={hideProvinceChecked}
                    onChange={(e) => setHideProvinceChecked(e.target.checked)}
                    className="accent-accent"
                  />
                  {regionName ?? "This region"}
                </label>
                <label className="flex items-center gap-1.5 py-0.5">
                  <input
                    type="checkbox"
                    checked={hideCountryChecked}
                    onChange={(e) => setHideCountryChecked(e.target.checked)}
                    className="accent-accent"
                  />
                  All of {countryRegionName ?? "the country"}
                </label>
                <div className="mt-1.5 flex gap-2">
                  <button
                    onClick={confirmHidePicker}
                    disabled={hidingFromRegion || (!hideProvinceChecked && !hideCountryChecked)}
                    className="rounded-md bg-ink px-2 py-1 text-[11px] font-medium text-surface disabled:opacity-50"
                  >
                    {hidingFromRegion ? "Hiding…" : "Hide"}
                  </button>
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setHidePickerOpen(false);
                    }}
                    className="rounded-md border border-line px-2 py-1 text-[11px] text-muted"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {item.isOtherTaxa && !isCollected && (
              <button
                onClick={removeOtherTaxa}
                disabled={removingOtherTaxa}
                className="block w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-surface-muted disabled:opacity-50 dark:text-red-400"
              >
                {removingOtherTaxa ? "Removing…" : "Remove species"}
              </button>
            )}
          </div>
        </DotMenu>
      </div>
      {!hideNames && (
      <div className={`${compact ? "px-1.5 py-1" : "p-3"} ${isUnseen || (isTarget && !isCollected) ? "opacity-60" : ""}`}>
        <p
          ref={nameRef}
          className="select-text overflow-hidden font-medium leading-tight text-ink"
          style={{ fontSize: nameFontSize }}
        >
          {displayName}
        </p>
        {!hideScientificName && (
          <p className={`select-text truncate italic text-muted ${compact ? "text-[10px] leading-tight" : "text-xs"}`}>{item.scientificName}</p>
        )}
        {/* Every badge here is a label, so with labels hidden the row (and its margin) goes too. */}
        {!hideLabels && (item.nameChanged || item.tier || item.localTier || localNoData || item.endemic || item.vagrant || item.isGhost || item.isLost || item.rediscoveredGhost || item.rediscoveredLost) && (
          <div className={`${compact ? "mt-0.5" : "mt-1"} flex flex-wrap items-center gap-1`}>
            {/* The species was split and your photos' place doesn't settle which one they are. */}
            {item.nameChanged && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setNameChangedOpen(true);
                }}
                className="inline-block rounded-md bg-amber-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-800 hover:bg-amber-200"
                title="This species was split. Tap to pick which one is in your photos."
              >
                Name changed
              </button>
            )}
            {item.tier && (
              <button
                type="button"
                onClick={openTier}
                className={
                  item.tier === "unrated"
                    ? "inline-block rounded-md border border-dashed border-line px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted hover:text-ink"
                    : "inline-block rounded-md bg-surface-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted hover:text-ink"
                }
                title={item.tier === "unrated" ? "Not enough data yet to rate how hard this is to find" : "Why this tier?"}
              >
                {TIER_LABEL[item.tier] ?? item.tier}
                {item.tierOverridden && !regionId && <span className="normal-case"> (yours)</span>}
              </button>
            )}
            {/* Region-scoped rarity, only present on a region's checklist. */}
            {item.localTier && (
              <button
                type="button"
                onClick={openTier}
                className="inline-block rounded-md border border-line px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted hover:text-ink"
                title="How hard this species is to find here. Tap for why."
              >
                {TIER_LABEL[item.localTier] ?? item.localTier} here
                {item.tierOverridden && <span className="normal-case"> (yours)</span>}
              </button>
            )}
            {localNoData && (
              <button
                type="button"
                onClick={openTier}
                className="inline-block rounded-md border border-dashed border-line px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted hover:text-ink"
                title="Too few records here to say how hard this is to find"
              >
                Not enough data here
              </button>
            )}
            {item.endemic && (
              <span
                className="inline-block rounded-md bg-amber-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-700"
                title="Only ever recorded in one country"
              >
                Endemic
              </span>
            )}
            {/* Region-scoped: records here cluster in very few years. */}
            {item.vagrant && (
              <span
                className="inline-block rounded-md bg-sky-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-sky-700"
                title="Records here are concentrated in very few years, likely a vagrant, not an established local presence"
              >
                Vagrant
              </span>
            )}
            {/* Sparsely documented anywhere, but verified reachable. */}
            {item.isGhost && (
              <span
                className="inline-block rounded-md bg-violet-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-violet-700"
                title="Rarely documented anywhere, but still out there to find"
              >
                Ghost
              </span>
            )}
            {/* Nothing recorded anywhere in 25+ years. */}
            {item.isLost && (
              <span
                className="inline-block rounded-md bg-rose-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-rose-700"
                title="Not recorded anywhere in over 25 years"
              >
                Lost
              </span>
            )}
            {/* Was Ghost/Lost when you collected it; kept after the live badge clears. */}
            {(item.rediscoveredGhost || item.rediscoveredLost) && (
              <span
                className="inline-block rounded-md bg-emerald-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-emerald-700"
                title="Rare or undocumented when you found it. You helped rediscover this species."
              >
                Rediscovered
              </span>
            )}
          </div>
        )}
      </div>
      )}
    </Link>
    {/* Outside the link: React bubbles clicks from a portal up its tree, so inside it they'd
        also open the species page. */}
    {nameChangedOpen && (
      <NameChangedModal
        speciesId={item.speciesId}
        speciesName={item.commonName ?? item.scientificName}
        scientificName={item.scientificName}
        onClose={() => setNameChangedOpen(false)}
        onChanged={() => onChanged?.(item.speciesId, "reload")}
      />
    )}
    {tierOpen && (
      <TierDetailsModal
        speciesId={item.speciesId}
        speciesName={item.commonName ?? item.scientificName}
        regionId={regionId ?? null}
        onClose={() => setTierOpen(false)}
        onChanged={() => onChanged?.(item.speciesId, "reload")}
      />
    )}
    </>
  );
}

export default memo(SpeciesCard);
