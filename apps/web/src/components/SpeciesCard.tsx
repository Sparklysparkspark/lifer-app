import { memo, useState } from "react";
import { matches } from "../lib/keymap";
import { Tooltip } from "./Tooltip";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { TIER_ORDER, type CollectionItem, type TierValue } from "@lifer/shared";
import { api, apiPath } from "../api/client";
import { cropToImageStyle } from "../lib/crop";
import { cardCropUrl } from "../lib/cardImage";
import { tierLabel } from "../lib/speciesGroups";
import { useFitText } from "../hooks/useFitText";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { useConfirm } from "../hooks/useConfirm";
import { useToast } from "../hooks/useToast";
import { addToChecklist, checklistLabel, removeFromChecklist } from "../lib/checklistAdditions";
import { errorMessage } from "../lib/errorMessage";
import ProgressiveImg from "./ProgressiveImg";
import PhotoPlaceholder from "./PhotoPlaceholder";
import Menu, { MenuItem, MenuPanel, MenuSeparator } from "./Menu";
import Checkbox from "./Checkbox";
import MediaCard from "./MediaCard";
import TierDetailsModal from "./TierDetailsModal";
import Modal from "./Modal";
import Button from "./Button";
import NameChangedModal from "./NameChangedModal";
import CardCropEditor from "./CardCropEditor";
import { namePartClass, useSpeciesName, useSpeciesNameParts } from "../lib/speciesName";
import SpeciesNameText from "./SpeciesNameText";

// What a card action did, so the parent can patch its list instead of reloading: a field patch,
// the species leaving this view, or "reload" after a failed optimistic change.
export type SpeciesChange = Partial<CollectionItem> | "removed" | "reload";
export type SpeciesChangeHandler = (speciesId: string | string[], change: SpeciesChange) => void;

// The seen and target marks: house line icons (an eye, a target), not text glyphs.
function MarkIcon({ d }: { d: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}
const SEEN_ICON = "M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z";
const TARGET_ICON = "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM12 11.5v1";
// The light chip the marks and the photo count sit on over a photo.
const CHIP = "rounded-full bg-surface/90 text-muted shadow";
const MARK = `flex h-5 w-5 items-center justify-center ${CHIP}`;

function speciesLinkSearch(regionId?: string, tripId?: string): string {
  const params = new URLSearchParams();
  if (regionId) params.set("regionId", regionId);
  if (tripId) params.set("trip", tripId);
  const search = params.toString();
  return search ? `?${search}` : "";
}

// Memoized: a scroll-triggered reveal in a grouped grid would otherwise re-render every mounted
// card, each re-running useFitText's layout read.
function SpeciesCard({
  item,
  regionId,
  regionName,
  countryRegionId,
  countryRegionName,
  backLabel,
  tripId,
  onChanged,
  showVolumeBadge,
  hideLabels,
  hideNames,
  compact,
  cardImageSide,
  selectMode = false,
  selected = false,
  onToggleSelect,
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
  /** Opened from a trip: the species page shows that trip's photos first. */
  tripId?: string;
  /** Called after a mark seen/target, archive, hide or remove. Must be stable (the card is memoized). */
  onChanged?: SpeciesChangeHandler;
  /** Show which external drive the cover photo lives on (only when more than one is in use). */
  showVolumeBadge?: boolean;
  /** Skip every badge in the status row. */
  hideLabels?: boolean;
  /** Just the photo, no name box. */
  hideNames?: boolean;
  /** The smallest card sizes: tighter spacing so the name box isn't mostly empty space. */
  compact?: boolean;
  /** Pixel side of the card's photo square, so a cropped photo loads only that much. */
  cardImageSide?: number;
  /** Select mode: a click picks the card instead of opening it, and the menu is hidden. */
  selectMode?: boolean;
  selected?: boolean;
  /** Must be stable (the card is memoized). */
  onToggleSelect?: (speciesId: string, shiftKey: boolean) => void;
}) {
  const { t } = useTranslation();
  const isSeen = item.state === "seen";
  const isCollected = item.state === "collected";
  // Not photographed and not marked seen (a target still counts as its own state's look).
  const isUncollected = !isCollected && !isSeen;
  // Independent of state: a collected species can still be a target (for a better photo).
  const isTarget = item.isTarget;
  // A reference photo whose file moved or was deleted falls back to the placeholder.
  const [referencePhotoFailed, setReferencePhotoFailed] = useState(false);
  // One retry, a moment later, before the placeholder: a busy server refuses a burst of images.
  const [referenceRetry, setReferenceRetry] = useState(false);
  // Your own photo with a crop: a square the server cut to it, at the card's size.
  const [cardImageFailed, setCardImageFailed] = useState(false);
  const cardImageUrl = cardCropUrl(item, cardImageSide);
  const [archiving, setArchiving] = useState(false);
  const [removingOtherTaxa, setRemovingOtherTaxa] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tierOpen, setTierOpen] = useState(false);
  const [nameChangedOpen, setNameChangedOpen] = useState(false);
  // Only your own featured photo can be cropped; a reference photo isn't yours to adjust.
  const ownCoverPhotoId = item.coverPhotoUrl?.match(/^\/api\/photos\/([^/]+)\/thumb/)?.[1] ?? null;
  const [croppingCover, setCroppingCover] = useState(false);
  // Errors propagate so CardCropEditor stays open and shows them. The shown photo's id: on a trip
  // or album card it can differ from the featured photo, and keeps its own crop.
  async function saveCrop(body: object) {
    await api.patch(apiPath("/species/{id}/card-crop", { id: item.speciesId }), { ...body, photoId: ownCoverPhotoId });
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
    item.heard
      ? {
          label: t("speciesCard.badge.heard"),
          title: t("speciesCard.badge.heardTitle"),
          className: "bg-surface-muted text-ink",
        }
      : item.nameChanged
        ? {
            label: t("speciesCard.badge.nameChanged"),
            title: t("speciesCard.badge.nameChangedTitle"),
            className: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
            onClick: openNameChanged,
          }
        : item.rediscoveredGhost || item.rediscoveredLost
          ? {
              label: t("speciesCard.badge.rediscovered"),
              title: t("speciesCard.badge.rediscoveredTitle"),
              className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
            }
          : item.isLost
            ? {
                label: t("speciesCard.badge.lost"),
                title: t("speciesCard.badge.lostTitle"),
                className: "bg-surface-muted text-ink",
              }
            : item.isGhost
              ? {
                  label: t("speciesCard.badge.ghost"),
                  title: t("speciesCard.badge.ghostTitle"),
                  className: "bg-surface-muted text-ink",
                }
              : item.endemic
                ? {
                    label: t("speciesCard.badge.endemic"),
                    title: t("speciesCard.badge.endemicTitle"),
                    className: "bg-surface-muted text-ink",
                  }
                : item.vagrant
                  ? {
                      label: t("speciesCard.badge.vagrant"),
                      title: t("speciesCard.badge.vagrantTitle"),
                      className: "bg-surface-muted text-ink",
                    }
                  : localRarer
                    ? {
                        label: t("speciesCard.badge.localTier", { tier: tierLabel(item.localTier!) }),
                        title: t("speciesCard.badge.localTierTitle"),
                        className: "bg-surface-muted text-muted",
                        onClick: openTier,
                      }
                    : item.userAddedRegion
                      ? {
                          label: t("speciesCard.badge.addedByYou"),
                          title: t("speciesCard.badge.addedByYouTitle", { list: checklistLabel(item.userAddedRegion) }),
                          className: "border border-dashed border-line text-muted",
                        }
                      : null;
  const { openKey: menuOpen, setOpenKey: setMenuOpen, ref: menuRef } = useDropdownMenu<true>();
  const confirm = useConfirm();
  const toast = useToast();
  const speciesName = useSpeciesName();
  const { primary: primaryName, secondary: secondaryName } = useSpeciesNameParts()(item);
  const displayName = primaryName.text;
  // Wraps and shrinks rather than truncating: an ellipsis can cut off the epithet that tells
  // look-alike species apart. Starts at text-footnote.
  const { ref: secondNameRef, fontSize: secondNameFontSize } = useFitText(
    [secondaryName.map((p) => p.text).join(" "), hideNames],
    { maxPx: 12, minPx: 8 },
  );

  // The card is already gone from the grid, so undo reloads it back in.
  async function undoRemoval(request: Promise<unknown>) {
    try {
      await request;
      onChanged?.(item.speciesId, "reload");
    } catch {
      toast.error(t("speciesCard.undoFailed"));
    }
  }

  function hiddenToast(regionIds: string[]) {
    const [first, ...rest] = regionIds;
    toast.show(t("speciesCard.hiddenToast", { name: displayName }), {
      tone: "success",
      actions: [
        {
          label: t("species.edits.undo"),
          onClick: () =>
            undoRemoval(
              api.delete(
                apiPath(
                  "/regions/{regionId}/species/{speciesId}/hide",
                  { regionId: first, speciesId: item.speciesId },
                  { cascadeRegionIds: rest.join(",") },
                ),
              ),
            ),
        },
      ],
    });
  }

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
      toast.show(t("speciesCard.archivedToast", { name: displayName }), {
        tone: "success",
        actions: [
          {
            label: t("species.edits.undo"),
            onClick: () => undoRemoval(api.delete(apiPath("/species/{id}/archive", { id: item.speciesId }))),
          },
        ],
      });
    } catch {
      toast.error(t("speciesCard.archiveFailed"));
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
      hiddenToast([regionId]);
    } catch {
      toast.error(t("speciesCard.hideFromRegionFailed"));
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
      hiddenToast(targetIds);
    } catch {
      toast.error(t("speciesCard.hideFailed"));
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
      onChanged?.(item.speciesId, "reload");
      toast.show(t("speciesCard.removedFromList", { name: displayName, list: checklistLabel(added) }), {
        tone: "success",
        actions: [
          {
            label: t("species.edits.undo"),
            onClick: () =>
              void addToChecklist(added.id, item.speciesId, added.kind)
                .then(() => onChanged?.(item.speciesId, "reload"))
                .catch(() => toast.error(t("speciesCard.undoFailed"))),
          },
        ],
      });
    } catch (err) {
      toast.error(errorMessage(err, t("speciesCard.removeFromListFailed")));
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
      title: t("speciesCard.removeConfirm.title"),
      message: t("speciesCard.removeConfirm.message"),
      confirmLabel: t("speciesCard.removeConfirm.confirm"),
      danger: true,
    });
    if (!ok) return;
    setRemovingOtherTaxa(true);
    try {
      await api.delete(apiPath("/species/{id}/other-taxa", { id: item.speciesId }));
      onChanged?.(item.speciesId, "removed");
    } catch {
      toast.error(t("speciesCard.removeFailed"));
    } finally {
      setRemovingOtherTaxa(false);
    }
  }

  // Applied locally first; a failure asks the parent to reload the real state.
  async function runStateChange(e: React.MouseEvent | null, method: "patch" | "delete", path: "seen" | "target") {
    e?.preventDefault();
    e?.stopPropagation();
    setMenuOpen(null);
    const patch: Partial<CollectionItem> =
      path === "seen" ? { state: method === "patch" ? "seen" : "unseen" } : { isTarget: method === "patch" };
    onChanged?.(item.speciesId, patch);
    setBusy(true);
    try {
      const url = `/species/${item.speciesId}/${path}`;
      await (method === "patch" ? api.patch(url) : api.delete(url));
      if (e && method === "patch") {
        toast.show(
          path === "seen"
            ? t("speciesCard.markedSeen", { name: displayName })
            : t("speciesCard.addedToTargets", { name: displayName }),
          {
            tone: "success",
            actions: [{ label: t("species.edits.undo"), onClick: () => runStateChange(null, "delete", path) }],
          },
        );
      }
    } catch {
      toast.error(t("speciesCard.updateFailed"));
      onChanged?.(item.speciesId, "reload");
    } finally {
      setBusy(false);
    }
  }

  // The card is one big Link, so a click right after drag-selecting the name would navigate and
  // drop the selection. Skip navigating when the click follows a real text selection.
  function handleClickCapture(e: React.MouseEvent) {
    if (selectMode) {
      e.preventDefault();
      e.stopPropagation();
      onToggleSelect?.(item.speciesId, e.shiftKey);
      return;
    }
    if ((window.getSelection()?.toString().length ?? 0) > 0) {
      e.preventDefault();
    }
  }

  return (
    <>
      <MediaCard
        media={
          <>
            {item.coverPhotoUrl && !referencePhotoFailed ? (
              // Only a captured photo has a /display derivative to upgrade to.
              item.coverPhotoUrl.startsWith("/api/photos/") ? (
                cardImageUrl && !cardImageFailed ? (
                  // dead-thumb-ok: the whole card links to the species page. A square cut to the crop.
                  <img
                    src={cardImageUrl}
                    alt={speciesName(item)}
                    decoding="async"
                    className="h-full w-full object-cover"
                    onError={() => setCardImageFailed(true)}
                  />
                ) : (
                  <ProgressiveImg
                    thumbSrc={item.coverPhotoUrl}
                    fullSrc={item.coverPhotoUrl.replace(/\/thumb$/, "/display")}
                    alt={speciesName(item)}
                    className="h-full w-full"
                    style={cropToImageStyle(item.cardCropX, item.cardCropY, item.cardCropSize)}
                  />
                )
              ) : (
                // dead-thumb-ok: the whole card links to the species page.
                <img
                  src={
                    referenceRetry
                      ? `${item.coverPhotoUrl}${item.coverPhotoUrl.includes("?") ? "&" : "?"}retry=1`
                      : item.coverPhotoUrl
                  }
                  alt={speciesName(item)}
                  decoding="async"
                  className="h-full w-full object-cover"
                  style={{
                    objectPosition: `${item.referenceFocalX ?? 50}% ${item.referenceFocalY ?? 50}%`,
                  }}
                  onError={() => {
                    if (referenceRetry) setReferencePhotoFailed(true);
                    else setTimeout(() => setReferenceRetry(true), 2000);
                  }}
                />
              )
            ) : (
              <PhotoPlaceholder className="h-full w-full" />
            )}
            {(isSeen || isTarget) && (
              <div className="absolute left-1.5 top-1.5 flex gap-1">
                {isSeen && (
                  <span className={MARK} title={t("speciesCard.seenTitle")}>
                    <MarkIcon d={SEEN_ICON} />
                  </span>
                )}
                {isTarget && (
                  <span className={MARK} title={t("speciesCard.targetTitle")}>
                    <MarkIcon d={TARGET_ICON} />
                  </span>
                )}
              </div>
            )}
            {showVolumeBadge && item.coverVolumeLabel && (
              <span
                // design-token: a label over a photo, dark in both themes.
                className={`absolute left-1.5 bottom-1.5 truncate rounded-full bg-black/60 px-2 py-0.5 text-footnote font-medium text-white shadow max-w-[80%]`}
                title={t("speciesCard.volumeTitle", { drive: item.coverVolumeLabel })}
              >
                {item.coverVolumeLabel}
              </span>
            )}
          </>
        }
        mediaClassName={`aspect-square ${isSeen ? "cover-seen" : isUncollected ? "cover-uncollected" : ""}`}
        title={
          hideNames ? undefined : (
            <span title={shownTier ? `${displayName}, ${tierLabel(shownTier)}` : displayName}>{displayName}</span>
          )
        }
        titleClassName={`line-clamp-2 select-text ${namePartClass(primaryName)}`}
        lines={
          secondaryName.length > 0
            ? [
                <p
                  key="second"
                  ref={secondNameRef}
                  className={`select-text break-words text-muted text-footnote ${compact ? "leading-tight" : ""}`}
                  style={{ fontSize: secondNameFontSize }}
                >
                  <SpeciesNameText parts={secondaryName} />
                </p>,
              ]
            : []
        }
        badge={
          // One badge at most, the most unusual thing about the species.
          !hideLabels && badge ? (
            badge.onClick ? (
              <Tooltip content={badge.title ? { label: badge.title } : undefined}>
                {(tip) => (
                  // raw-control: drawn as the badge it is, so it reads the same as the plain one.
                  <button
                    type="button"
                    {...tip}
                    onClick={badge.onClick}
                    className={`inline-block rounded-badge px-1.5 py-0.5 text-footnote hover:underline ${badge.className}`}
                  >
                    {badge.label}
                  </button>
                )}
              </Tooltip>
            ) : (
              <span
                title={badge.title}
                className={`inline-block rounded-badge px-1.5 py-0.5 text-footnote ${badge.className}`}
              >
                {badge.label}
              </span>
            )
          ) : null
        }
        textClassName={isUncollected ? "text-uncollected" : ""}
        compact={compact}
        selected={selectMode && selected}
        markLabel={selectMode ? t("speciesCard.select", { name: displayName }) : undefined}
        actions={
          !selectMode && (
            <Menu open={!!menuOpen} onToggle={toggleMenu} menuRef={menuRef} className="relative">
              {/* Built only while open: a screen of cards would otherwise look up every label each render. */}
              {menuOpen && (
                <MenuPanel className="min-w-[9rem]">
                  {/* Seen/unseen only makes sense before it's actually collected. */}
                  {!isCollected &&
                    (isSeen ? (
                      <MenuItem onSelect={(e) => runStateChange(e, "delete", "seen")} disabled={busy}>
                        {t("speciesCard.menu.markUnseen")}
                      </MenuItem>
                    ) : (
                      <MenuItem onSelect={(e) => runStateChange(e, "patch", "seen")} disabled={busy}>
                        {t("speciesCard.menu.markSeen")}
                      </MenuItem>
                    ))}
                  {ownCoverPhotoId && (
                    <MenuItem
                      onSelect={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setMenuOpen(null);
                        setCroppingCover(true);
                      }}
                    >
                      {t("speciesCard.menu.adjustPreview")}
                    </MenuItem>
                  )}
                  {/* Independent of state: a collected species can still be targeted. */}
                  {isTarget ? (
                    <MenuItem onSelect={(e) => runStateChange(e, "delete", "target")} disabled={busy}>
                      {t("speciesCard.menu.removeTarget")}
                    </MenuItem>
                  ) : (
                    <MenuItem onSelect={(e) => runStateChange(e, "patch", "target")} disabled={busy}>
                      {t("speciesCard.menu.addTarget")}
                    </MenuItem>
                  )}
                  {shownTier && (
                    <MenuItem
                      onSelect={(e) => {
                        setMenuOpen(null);
                        openTier(e);
                      }}
                      title={t("speciesCard.menu.rarityTitle")}
                    >
                      {item.tierOverridden
                        ? t("speciesCard.menu.rarityYours", { tier: tierLabel(shownTier) })
                        : t("speciesCard.menu.rarity", { tier: tierLabel(shownTier) })}
                    </MenuItem>
                  )}
                  {/* Archiving a collected species is a no-op server-side. */}
                  {!isCollected && (
                    <MenuItem onSelect={archive} disabled={archiving} title={t("speciesCard.menu.archiveTitle")}>
                      {archiving ? t("common.saving") : t("speciesCard.menu.archive")}
                    </MenuItem>
                  )}
                  {regionId && !isCollected && (
                    <MenuItem
                      onSelect={hideFromRegion}
                      disabled={hidingFromRegion}
                      title={t("speciesCard.menu.hideTitle")}
                    >
                      {hidingFromRegion ? t("speciesCard.menu.hiding") : t("speciesCard.menu.hide")}
                    </MenuItem>
                  )}
                  {item.userAddedRegion && (
                    <MenuItem
                      onSelect={removeAddition}
                      disabled={removingAddition}
                      title={t("speciesCard.menu.removeAdditionTitle", { list: checklistLabel(item.userAddedRegion) })}
                    >
                      {removingAddition ? t("speciesCard.menu.removing") : t("speciesCard.menu.removeAddition")}
                    </MenuItem>
                  )}
                  {item.isOtherTaxa && !isCollected && (
                    <>
                      <MenuSeparator />
                      <MenuItem onSelect={removeOtherTaxa} disabled={removingOtherTaxa} danger>
                        {removingOtherTaxa ? t("speciesCard.menu.removing") : t("speciesCard.menu.removeSpecies")}
                      </MenuItem>
                    </>
                  )}
                </MenuPanel>
              )}
            </Menu>
          )
        }
        renderBody={({ className, children }) => (
          <Link
            to={`/species/${item.speciesId}${speciesLinkSearch(regionId, tripId)}`}
            state={backLabel ? { backLabel } : undefined}
            // useScrollMemory keeps the card at the top of the screen in place on Back.
            data-scroll-anchor={item.speciesId}
            onClickCapture={handleClickCapture}
            role={selectMode ? "checkbox" : undefined}
            aria-checked={selectMode ? selected : undefined}
            onKeyDown={(e) => {
              if (selectMode && matches(e, "toggle")) {
                e.preventDefault();
                e.currentTarget.click();
              }
            }}
            // WebKit treats a drag on a link as "drag the link out", which swallows text selection.
            draggable={false}
            onDragStart={(e) => e.preventDefault()}
            className={className}
          >
            {children}
          </Link>
        )}
      />
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
          title={t("speciesCard.menu.hide")}
          footer={
            <>
              <Button variant="secondary" onClick={() => setHidePickerOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                onClick={() => void confirmHidePicker()}
                loading={hidingFromRegion}
                disabled={!hideProvinceChecked && !hideCountryChecked}
              >
                {t("speciesCard.hidePicker.hide")}
              </Button>
            </>
          }
        >
          <p className="mb-3 text-callout text-muted">{t("speciesCard.hidePicker.note")}</p>
          <div className="space-y-1.5">
            <Checkbox checked={hideProvinceChecked} onChange={setHideProvinceChecked}>
              {regionName ?? t("speciesCard.hidePicker.thisRegion")}
            </Checkbox>
            <Checkbox checked={hideCountryChecked} onChange={setHideCountryChecked}>
              {countryRegionName
                ? t("speciesCard.hidePicker.allOf", { country: countryRegionName })
                : t("speciesCard.hidePicker.allOfCountry")}
            </Checkbox>
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
