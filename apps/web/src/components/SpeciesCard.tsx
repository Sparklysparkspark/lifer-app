import { memo, useState } from "react";
import { Link } from "react-router-dom";
import { TIER_ORDER, type CollectionItem, type TierValue } from "@lifer/shared";
import { api, apiPath } from "../api/client";
import { cropToImageStyle } from "../lib/crop";
import { tierLabel } from "../lib/speciesGroups";
import { useFitText } from "../hooks/useFitText";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { useConfirm } from "../hooks/useConfirm";
import { useToast } from "../hooks/useToast";
import { checklistLabel, removeFromChecklist } from "../lib/checklistAdditions";
import { errorMessage } from "../lib/errorMessage";
import ProgressiveImg from "./ProgressiveImg";
import PhotoPlaceholder from "./PhotoPlaceholder";
import DotMenu from "./DotMenu";
import TierDetailsModal from "./TierDetailsModal";
import Modal from "./Modal";
import Button from "./Button";
import NameChangedModal from "./NameChangedModal";
import CardCropEditor from "./CardCropEditor";
import { useSpeciesName } from "../lib/speciesName";
import { MENU_ITEM, MENU_ITEM_DANGER, MENU_PANEL, MENU_SEPARATOR } from "../lib/menuClasses";

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
  // Only your own featured photo can be cropped; a reference photo isn't yours to adjust.
  const ownCoverPhotoId = item.coverPhotoUrl?.match(/^\/api\/photos\/([^/]+)\/thumb/)?.[1] ?? null;
  const [croppingCover, setCroppingCover] = useState(false);
  // Errors propagate so CardCropEditor stays open and shows them.
  async function saveCrop(body: object) {
    await api.patch(apiPath("/species/{id}/card-crop", { id: item.speciesId }), body);
    onChanged?.(item.speciesId, "reload");
  }
  // The badges sit inside the card's link: open the tier's details instead of following it.
  const openTier = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setTierOpen(true);
  };
  const openNameChanged = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setNameChangedOpen(true);
  };
  const shownTier = item.localTier ?? item.tier;
  // A local tier only earns the badge when it's rarer here than overall.
  const localRarer =
    !!item.localTier &&
    !!item.tier &&
    TIER_ORDER.indexOf(item.localTier as TierValue) > TIER_ORDER.indexOf(item.tier as TierValue);
  const badge: { label: string; title: string; className: string; onClick?: (e: React.MouseEvent) => void } | null =
    item.nameChanged
      ? {
          label: "Name changed",
          title: "This species was split. Tap to pick which one is in your photos.",
          className: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
          onClick: openNameChanged,
        }
      : item.rediscoveredGhost || item.rediscoveredLost
        ? {
            label: "Rediscovered",
            title: "Rare or undocumented when you found it. You helped rediscover this species.",
            className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
          }
        : item.isLost
          ? {
              label: "Lost",
              title: "Not recorded anywhere in over 25 years",
              className: "bg-surface-muted text-ink",
            }
          : item.isGhost
            ? {
                label: "Ghost",
                title: "Rarely documented anywhere, but still out there to find",
                className: "bg-surface-muted text-ink",
              }
            : item.endemic
              ? {
                  label: "Endemic",
                  title: "Only ever recorded in one country",
                  className: "bg-surface-muted text-ink",
                }
              : item.vagrant
                ? {
                    label: "Vagrant",
                    title:
                      "Records here are concentrated in very few years, likely a vagrant, not an established local presence",
                    className: "bg-surface-muted text-ink",
                  }
                : localRarer
                  ? {
                      label: `${tierLabel(item.localTier!)} here`,
                      title: "Harder to find here than overall. Tap for why.",
                      className: "bg-surface-muted text-muted",
                      onClick: openTier,
                    }
                  : item.userAddedRegion
                    ? {
                        label: "Added by you",
                        title: `You added this to ${checklistLabel(item.userAddedRegion)} yourself`,
                        className: "border border-dashed border-line text-muted",
                      }
                    : null;
  const { openKey: menuOpen, setOpenKey: setMenuOpen, ref: menuRef } = useDropdownMenu<true>();
  const confirm = useConfirm();
  const toast = useToast();
  const speciesName = useSpeciesName();
  const displayName = speciesName(item);
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
      await api.post(apiPath("/species/{id}/archive", { id: item.speciesId }));
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
    setMenuOpen(null);
    if (hasCountryChoice) {
      setHidePickerOpen(true);
      return;
    }
    setHidingFromRegion(true);
    try {
      await api.post(apiPath("/regions/{regionId}/species/{speciesId}/hide", { regionId, speciesId: item.speciesId }));
      onChanged?.(item.speciesId, "removed");
    } catch {
      toast.error("Couldn't hide this species from this region. Try again.");
    } finally {
      setHidingFromRegion(false);
    }
  }

  // Province and country are independent scopes (a vagrant in BC can stay visible in the rest
  // of Canada), so each checked box is its own hide row.
  async function confirmHidePicker() {
    if (!regionId) return;
    const targetIds = [hideProvinceChecked ? regionId : null, hideCountryChecked ? countryRegionId : null].filter(
      (id): id is string => !!id,
    );
    if (targetIds.length === 0) return;
    setHidingFromRegion(true);
    try {
      await Promise.all(
        targetIds.map((id) =>
          api.post(
            apiPath("/regions/{regionId}/species/{speciesId}/hide", { regionId: id, speciesId: item.speciesId }),
          ),
        ),
      );
      setHidePickerOpen(false);
      onChanged?.(item.speciesId, "removed");
    } catch {
      toast.error("Couldn't hide this species. Try again.");
    } finally {
      setHidingFromRegion(false);
    }
  }

  // Takes off only the user's own addition (lib/checklistAdditions.ts). Reloaded rather than
  // dropped: the species stays if it's on the list for another reason, like a photo taken here.
  const [removingAddition, setRemovingAddition] = useState(false);
  async function removeAddition(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const added = item.userAddedRegion;
    if (!added) return;
    setMenuOpen(null);
    setRemovingAddition(true);
    try {
      await removeFromChecklist(added.id, item.speciesId, added.kind);
      toast.success(`Removed ${displayName} from ${checklistLabel(added)}.`);
      onChanged?.(item.speciesId, "reload");
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't remove this species from the checklist. Try again."));
    } finally {
      setRemovingAddition(false);
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
      message: "You can add it back later by searching iNaturalist.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setRemovingOtherTaxa(true);
    try {
      await api.delete(apiPath("/species/{id}/other-taxa", { id: item.speciesId }));
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
      const url = `/species/${item.speciesId}/${path}`;
      await (method === "patch" ? api.patch(url) : api.delete(url));
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
        // useScrollMemory keeps the card at the top of the screen in place on Back.
        data-scroll-anchor={item.speciesId}
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
                  alt={speciesName(item)}
                  className="h-full w-full"
                  style={cropToImageStyle(item.cardCropX, item.cardCropY, item.cardCropSize)}
                />
              ) : (
                <img
                  src={item.coverPhotoUrl}
                  alt={speciesName(item)}
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
                className="absolute left-1.5 bottom-1.5 max-w-[80%] truncate rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white shadow"
                title={`This photo is on the "${item.coverVolumeLabel}" drive`}
              >
                {item.coverVolumeLabel}
              </span>
            )}
          </div>
          <DotMenu open={!!menuOpen} onToggle={toggleMenu} menuRef={menuRef}>
            <div className={`absolute right-0 top-full z-10 mt-1 min-w-[9rem] ${MENU_PANEL}`}>
              {/* Seen/unseen only makes sense before it's actually collected. */}
              {!isCollected &&
                (isSeen ? (
                  <button onClick={(e) => runStateChange(e, "delete", "seen")} disabled={busy} className={MENU_ITEM}>
                    Mark as unseen
                  </button>
                ) : (
                  <button onClick={(e) => runStateChange(e, "patch", "seen")} disabled={busy} className={MENU_ITEM}>
                    Mark as seen
                  </button>
                ))}
              {ownCoverPhotoId && (
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenuOpen(null);
                    setCroppingCover(true);
                  }}
                  className={MENU_ITEM}
                >
                  Adjust card preview
                </button>
              )}
              {/* Independent of state: a collected species can still be targeted. */}
              {isTarget ? (
                <button onClick={(e) => runStateChange(e, "delete", "target")} disabled={busy} className={MENU_ITEM}>
                  Remove from targets
                </button>
              ) : (
                <button onClick={(e) => runStateChange(e, "patch", "target")} disabled={busy} className={MENU_ITEM}>
                  Add to targets
                </button>
              )}
              {shownTier && (
                <button
                  onClick={(e) => {
                    setMenuOpen(null);
                    openTier(e);
                  }}
                  title="Why this tier, or set your own"
                  className={MENU_ITEM}
                >
                  Rarity: {tierLabel(shownTier)}
                  {item.tierOverridden && " (yours)"}
                </button>
              )}
              {/* Archiving a collected species is a no-op server-side. */}
              {!isCollected && (
                <button
                  onClick={archive}
                  disabled={archiving}
                  title="Stop counting this toward your to-collect total (can be undone from the Archived page)"
                  className={MENU_ITEM}
                >
                  {archiving ? "Archiving…" : "Archive"}
                </button>
              )}
              {regionId && !isCollected && (
                <button
                  onClick={hideFromRegion}
                  disabled={hidingFromRegion}
                  title="Hide this species from this region's checklist only. It still shows up in other regions it's on."
                  className={MENU_ITEM}
                >
                  {hidingFromRegion ? "Hiding…" : "Hide from this region"}
                </button>
              )}
              {item.userAddedRegion && (
                <button
                  onClick={removeAddition}
                  disabled={removingAddition}
                  title={`You added this to ${checklistLabel(item.userAddedRegion)}. This takes it off again.`}
                  className={MENU_ITEM}
                >
                  {removingAddition ? "Removing…" : "Remove from this checklist"}
                </button>
              )}
              {item.isOtherTaxa && !isCollected && (
                <>
                  <div className={MENU_SEPARATOR} />
                  <button onClick={removeOtherTaxa} disabled={removingOtherTaxa} className={MENU_ITEM_DANGER}>
                    {removingOtherTaxa ? "Removing…" : "Remove species"}
                  </button>
                </>
              )}
            </div>
          </DotMenu>
        </div>
        {!hideNames && (
          <div
            className={`${compact ? "px-1.5 py-1" : "p-3"} ${isUnseen || (isTarget && !isCollected) ? "opacity-60" : ""}`}
          >
            <p
              ref={nameRef}
              title={shownTier ? `${displayName}, ${tierLabel(shownTier)}` : undefined}
              className="select-text overflow-hidden font-medium leading-tight text-ink"
              style={{ fontSize: nameFontSize }}
            >
              {displayName}
            </p>
            {!hideScientificName && (
              <p className={`select-text truncate italic text-muted text-xs ${compact ? "leading-tight" : ""}`}>
                {item.scientificName}
              </p>
            )}
            {/* One badge at most, the most unusual thing about the species. */}
            {!hideLabels && badge && (
              <div className={compact ? "mt-0.5" : "mt-1"}>
                {badge.onClick ? (
                  <button
                    type="button"
                    onClick={badge.onClick}
                    title={badge.title}
                    className={`inline-block rounded-md px-1.5 py-0.5 text-xs hover:underline ${badge.className}`}
                  >
                    {badge.label}
                  </button>
                ) : (
                  <span
                    title={badge.title}
                    className={`inline-block rounded-md px-1.5 py-0.5 text-xs ${badge.className}`}
                  >
                    {badge.label}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </Link>
      {/* Outside the link: React bubbles clicks from a portal up its tree, so inside it they'd
        also open the species page. */}
      {croppingCover && ownCoverPhotoId && (
        <CardCropEditor
          photoUrl={`/api/photos/${ownCoverPhotoId}/display`}
          initialX={item.cardCropX ?? null}
          initialY={item.cardCropY ?? null}
          initialSize={item.cardCropSize ?? null}
          onClose={() => setCroppingCover(false)}
          onSave={(crop) => saveCrop(crop)}
          onReset={() => saveCrop({ reset: true })}
        />
      )}
      {nameChangedOpen && (
        <NameChangedModal
          speciesId={item.speciesId}
          speciesName={speciesName(item)}
          scientificName={item.scientificName}
          onClose={() => setNameChangedOpen(false)}
          onChanged={() => onChanged?.(item.speciesId, "reload")}
        />
      )}
      {hidePickerOpen && (
        <Modal
          open
          onClose={() => setHidePickerOpen(false)}
          title="Hide from checklist"
          footer={
            <>
              <Button variant="secondary" onClick={() => setHidePickerOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => void confirmHidePicker()}
                loading={hidingFromRegion}
                disabled={!hideProvinceChecked && !hideCountryChecked}
              >
                Hide
              </Button>
            </>
          }
        >
          <p className="mb-3 text-sm text-muted">It stays on the checklists you leave unticked.</p>
          <div className="space-y-1.5 text-sm text-ink">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={hideProvinceChecked}
                onChange={(e) => setHideProvinceChecked(e.target.checked)}
                className="accent-accent"
              />
              {regionName ?? "This region"}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={hideCountryChecked}
                onChange={(e) => setHideCountryChecked(e.target.checked)}
                className="accent-accent"
              />
              All of {countryRegionName ?? "the country"}
            </label>
          </div>
        </Modal>
      )}
      {tierOpen && (
        <TierDetailsModal
          speciesId={item.speciesId}
          speciesName={speciesName(item)}
          regionId={regionId ?? null}
          onClose={() => setTierOpen(false)}
          onChanged={() => onChanged?.(item.speciesId, "reload")}
        />
      )}
    </>
  );
}

export default memo(SpeciesCard);
