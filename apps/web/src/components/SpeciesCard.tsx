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
  regionName,
  countryRegionId,
  countryRegionName,
  backLabel,
  onArchived,
  showVolumeBadge,
  hideLabels,
}: {
  item: CollectionItem;
  regionId?: string;
  /** Display name of the currently-viewed region (regionId) — only needed to label the two
   *  checkboxes in the province-vs-country hide picker below. */
  regionName?: string;
  /** The enclosing country's region id, when regionId itself refers to a province/state —
   *  same id as regionId when already viewing a country directly (see CollectionPage's
   *  countryAncestorFor). Only when this differs from regionId does "Hide from this region"
   *  offer a province-vs-country choice; otherwise there's nothing to disambiguate. */
  countryRegionId?: string;
  countryRegionName?: string;
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
  /** Collections' own "Hide labels" display toggle — purely cosmetic, doesn't touch the
   *  underlying data, just skips rendering every badge in this same row (tier, local tier,
   *  Endemic, Vagrant, Ghost, Lost, Rediscovered). */
  hideLabels?: boolean;
}) {
  const isUnseen = item.state === "unseen";
  const isSeen = item.state === "seen";
  const isCollected = item.state === "collected";
  // Independent of state (migration 090) — a species already collected can still be targeted
  // (e.g. "I only have a bad photo, I want a better one"), so it no longer implies "not gotten
  // yet" the way it used to when target was one exclusive state value.
  const isTarget = item.isTarget;
  // A reference photo whose file has since moved or been deleted would otherwise show the
  // browser's own broken-image icon — falls back to the same "no photo" placeholder instead.
  const [referencePhotoFailed, setReferencePhotoFailed] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [removingOtherTaxa, setRemovingOtherTaxa] = useState(false);
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

  const [hidingFromRegion, setHidingFromRegion] = useState(false);
  const [hidePickerOpen, setHidePickerOpen] = useState(false);
  const [hideProvinceChecked, setHideProvinceChecked] = useState(true);
  const [hideCountryChecked, setHideCountryChecked] = useState(false);
  // Only meaningful when regionId refers to a province/state whose enclosing country is a
  // DIFFERENT region — viewing a country directly has nothing to disambiguate, so the plain
  // one-click hide below still applies there.
  const hasCountryChoice = !!(regionId && countryRegionId && countryRegionId !== regionId);

  // Region-scoped archive (migration 100) — hides this species from THIS region's checklist
  // only (e.g. a vagrant entry, like Japanese Quail turning up in BC/Canada) without touching
  // its global record or its presence on any other region's checklist. Only offered when
  // actually viewing a specific region (regionId prop), unlike the global "Archive" action above.
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
      onArchived?.();
    } catch {
      alert("Couldn't hide this species from this region. Try again.");
    } finally {
      setHidingFromRegion(false);
    }
  }

  // Confirms whichever of the two checkboxes above are on — a province-only vagrant (like
  // Japanese Quail in BC) should stay visible in the rest of Canada, so the two scopes are
  // independent, not radio-exclusive; hiding "both" just means two separate rows in
  // region_species_hidden, one per region id.
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
      onArchived?.();
    } catch {
      alert("Couldn't hide this species. Try again.");
    } finally {
      setHidingFromRegion(false);
    }
  }

  // Other Taxa species have no pack/reseed story to fall back on — one added by accident (or
  // just to try the feature) has no other way back except deleting it outright. Only offered
  // before any photo exists (see the card's own menu below) — the server itself refuses once
  // one does (see the route's own comment), so hiding it client-side at that point avoids a
  // guaranteed error.
  async function removeOtherTaxa(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm("Remove this species entirely? This can't be undone — you'd need to search and add it again from iNaturalist.")) {
      setMenuOpen(null);
      return;
    }
    setMenuOpen(null);
    setRemovingOtherTaxa(true);
    try {
      await api.delete(`/species/${item.speciesId}/other-taxa`);
      onArchived?.();
    } catch {
      alert("Couldn't remove this species. Try again.");
    } finally {
      setRemovingOtherTaxa(false);
    }
  }

  async function runStateChange(e: React.MouseEvent, method: "patch" | "delete", path: "seen" | "target") {
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen(null);
    setBusy(true);
    try {
      await api[method](`/species/${item.speciesId}/${path}`);
      onArchived?.();
    } catch {
      alert("Couldn't update this species. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // The whole card is one big Link so most of it is click-to-navigate, but that swallows
  // text selection on the name/scientific-name below: a click still fires (and navigates)
  // right after a drag-to-select releases, which discards the selection the instant it's
  // made — it LOOKS like the text can't be selected at all, even though the drag itself
  // worked. Bail out of navigating whenever the click follows an actual text selection.
  function handleClickCapture(e: React.MouseEvent) {
    if ((window.getSelection()?.toString().length ?? 0) > 0) {
      e.preventDefault();
    }
  }

  return (
    <Link
      to={regionId ? `/species/${item.speciesId}?regionId=${regionId}` : `/species/${item.speciesId}`}
      state={backLabel ? { backLabel } : undefined}
      onClickCapture={handleClickCapture}
      // An anchor is natively draggable in WebKit (Safari/the desktop app's WKWebView) — a
      // click-and-drag gesture starting on one is treated as "drag this link out" (to make a
      // bookmark/new tab) rather than a text selection, unlike Chrome. That swallowed the drag
      // before it ever became a selection, so handleClickCapture above (which only cancels
      // navigation AFTER a real selection exists) never had anything to act on. Blocking the
      // native drag here is what lets the gesture fall through to an ordinary text selection.
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      // Deliberately no overflow-hidden here (only rounded-lg + border) — the card used to clip
      // its own contents to this rounded shape, but that meant the dropdown menu below, however
      // far outside the image box it escaped to, was still a DOM descendant of THIS element and
      // still got clipped by it once the card itself was small enough. The image box below now
      // carries its own overflow-hidden + matching top corner radius instead, so the card still
      // reads as one rounded rectangle without anything clipping the menu.
      // The unseen/target dimming used to live here, on the whole card — but `opacity` composites
      // its entire subtree as one group, which meant the dropdown menu (a DOM descendant, however
      // far it now escapes the image's own clipping) rendered dimmed too. Applied instead to just
      // the two content pieces below (the image box, the text block) so the menu stays solid.
      className="group block rounded-lg border border-line bg-surface transition hover:shadow-md"
    >
      {/* The dropdown trigger+panel live in this OUTER relative wrapper, not inside the image
         box below — that box needs overflow-hidden to crop the cover photo, but a menu panel
         nested inside an overflow-hidden ancestor gets clipped the moment it renders below the
         box's own edge (exactly what happened at small card sizes, where there's less slack
         before the panel's true position collides with the clip). Keeping the trigger here
         instead means the panel's containing block is this wrapper (no overflow-hidden), so it
         paints in full regardless of card size. */}
      <div className="relative">
        <div
          className={`relative aspect-square overflow-hidden rounded-t-lg bg-surface-muted ${isSeen ? "grayscale" : ""} ${
            isUnseen || (isTarget && !isCollected) ? "opacity-60" : ""
          }`}
        >
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
            {/* Independent of state — even an already-collected species can still be targeted,
               e.g. to go back for a better photo. */}
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
            {/* Archiving a species you've already collected would be a no-op server-side (see
               ALREADY_OWNED_SQL), so it's not offered there. */}
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
                title="Hide this species from this region's checklist only — it still shows up if you browse another region it's on"
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
                className="block w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-surface-muted disabled:opacity-50"
              >
                {removingOtherTaxa ? "Removing…" : "Remove Species"}
              </button>
            )}
          </div>
        </DotMenu>
      </div>
      <div className={`p-3 ${isUnseen || (isTarget && !isCollected) ? "opacity-60" : ""}`}>
        <p
          ref={nameRef}
          className="select-text overflow-hidden font-medium leading-tight text-ink"
          style={{ fontSize: nameFontSize }}
        >
          {displayName}
        </p>
        <p className="select-text truncate text-xs italic text-muted">{item.scientificName}</p>
        {(item.tier || item.localTier || item.endemic || item.vagrant || item.isGhost || item.isLost || item.rediscoveredGhost || item.rediscoveredLost) && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {!hideLabels && item.tier && (
              <span
                className={
                  item.tier === "unrated"
                    ? "inline-block rounded-md border border-dashed border-line px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted"
                    : "inline-block rounded-md bg-surface-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted"
                }
                title={item.tier === "unrated" ? "Not enough data yet to rate how hard this is to find" : undefined}
              >
                {TIER_LABEL[item.tier] ?? item.tier}
              </span>
            )}
            {/* Region-scoped rarity — only present when viewing a region's checklist,
               ranked against species actually found there instead of the global,
               effort-weighted score. */}
            {!hideLabels && item.localTier && (
              <span
                className="inline-block rounded-md border border-line px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted"
                title="How rare and hard to find this species is in this region specifically"
              >
                {TIER_LABEL[item.localTier] ?? item.localTier} here
              </span>
            )}
            {!hideLabels && item.endemic && (
              <span
                className="inline-block rounded-md bg-amber-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-700"
                title="Only ever recorded in one country"
              >
                Endemic
              </span>
            )}
            {/* Region-scoped, same as localTier above — records here cluster in very few
               years rather than spreading out, a real vagrancy signature explaining why
               localTier reads rarer than raw record count alone would suggest. */}
            {!hideLabels && item.vagrant && (
              <span
                className="inline-block rounded-md bg-sky-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-sky-700"
                title="Records here are concentrated in very few years, likely a vagrant, not an established local presence"
              >
                Vagrant
              </span>
            )}
            {/* Global documentation is sparse (few total records anywhere, or no reference
               photo found) but the species is verified reachable — not deep-sea, not silent
               since before 1950. A "you'd be one of few who's photographed this" badge. */}
            {!hideLabels && item.isGhost && (
              <span
                className="inline-block rounded-md bg-violet-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-violet-700"
                title="Rarely documented anywhere, but still out there to find"
              >
                Ghost
              </span>
            )}
            {/* Nothing recorded anywhere in 25+ years. */}
            {!hideLabels && item.isLost && (
              <span
                className="inline-block rounded-md bg-rose-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-rose-700"
                title="Not recorded anywhere in over 25 years"
              >
                Lost
              </span>
            )}
            {/* Was Ghost/Lost the moment you collected it, but isn't anymore — a permanent
               record of that moment (migration 069), even after fresh global data catches up
               and clears the live badge above. */}
            {!hideLabels && (item.rediscoveredGhost || item.rediscoveredLost) && (
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
    </Link>
  );
}

export default memo(SpeciesCard);
