import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { createPortal, flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { api, apiPath } from "../../api/client";
import Button, { IconButton } from "../Button";
import InfoTip from "../InfoTip";
import Lightbox from "../Lightbox";
import PhotoArrows from "../PhotoArrows";
import MagnifierIcon from "../MagnifierIcon";
import MediaCard from "../MediaCard";
import PhotoPlaceholder from "../PhotoPlaceholder";
import ProbableGroupText from "../ProbableGroupText";
import ProgressiveImg from "../ProgressiveImg";
import SpeciesPicker, { type SpeciesResult, type SuggestedSpecies } from "../SpeciesPicker";
import SuggestionCard from "../SuggestionCard";
import Switch from "../Switch";
import ZoomPane from "../ZoomPane";
import WindowTitleBar from "../WindowTitleBar";
import { useEscapeToClose } from "../../hooks/useEscapeToClose";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useLatest } from "../../hooks/useLatest";
import { isTypingTarget } from "../../hooks/useKeyboardShortcuts";
import { matches, shortcutLabel } from "../../lib/keymap";
import { FIT, frameView, zoomView, type View } from "../../lib/compareZoom";
import { formatPercent, metaLine } from "../../lib/format";
import { OVERLAY_REVEAL } from "../../lib/buttonClasses";
import { markDragBlocked } from "../../lib/modalDragBlock";
import { useSpeciesName } from "../../lib/speciesName";
import type { CompareTarget, ReviewRowBase } from "./useImportReview";
import { compareCandidates, nextToConfirm, percentOf, toConfirm } from "./compareQueue";

type RefPhoto = { url: string; credit: string | null };

// Import compare mode: the user's photo, opened zoomed on the animal, beside the photos of a species
// to check it against. Enter confirms the species shown and brings up the next photo to confirm; a
// set of ticked photos is confirmed together.
export default function ImportCompareView<R extends ReviewRowBase>({
  rows,
  target,
  regionId,
  photoUrl,
  nameOf,
  onConfirm,
  onNoAnimal,
  onClose,
}: {
  rows: R[];
  target: CompareTarget;
  regionId: string | null;
  /** The photo to show for a row; null when the browser can't draw it (a video, a RAW without a preview). */
  photoUrl: (row: R) => string | null;
  nameOf: (row: R) => string;
  onConfirm: (keys: string[], species: SpeciesResult) => void;
  /** Leaves the photos out as having no animal in them. */
  onNoAnimal: (keys: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  const [currentKey, setCurrentKey] = useState(target.key);
  const [group, setGroup] = useState(target.group);
  const [typed, setTyped] = useState<SuggestedSpecies[]>([]);
  const [activeId, setActiveId] = useState<string | null>(target.speciesId ?? null);
  const [galleries, setGalleries] = useState<Record<string, RefPhoto[]>>({});
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [leftView, setLeftView] = useState<View>(FIT);
  const [rightView, setRightView] = useState<View>(FIT);
  const [linked, setLinked] = useState(false);
  // The left photo's framing on its subject, worked out once it has loaded and its size is known.
  const [subjectView, setSubjectView] = useState<View | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  // The last card in the strip is a species search while this is set.
  const [searching, setSearching] = useState(false);
  // A photo opened full screen in the Lightbox; compare keeps its state underneath.
  const [viewer, setViewer] = useState<"left" | "right" | null>(null);
  useFocusTrap(dialogRef);
  useEscapeToClose(() => {
    if (searching) setSearching(false);
    else if (isTypingTarget(document.activeElement)) (document.activeElement as HTMLElement).blur();
    else onClose();
  });
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // The title-bar drag strip would otherwise swallow clicks on the header.
    markDragBlocked(true);
    return () => {
      document.body.style.overflow = previous;
      markDragBlocked(false);
    };
  }, []);
  // Rendered before focusing, so a letter typed to start the search lands in the field.
  function startSearch() {
    flushSync(() => setSearching(true));
    searchRef.current?.querySelector("input")?.focus();
  }

  const row = rows.find((r) => r.key === currentKey);
  const queue = group ?? rows.filter((r) => r.key === currentKey || toConfirm(r)).map((r) => r.key);
  const candidates = compareCandidates(rows, group ?? [currentKey], typed);
  const active = candidates.find((c) => c.id === activeId) ?? candidates[0];
  const photos = active ? galleries[active.id] : undefined;
  const photo = photos?.[Math.min(galleryIndex, photos.length - 1)];

  // A new species starts on its first (featured) photo.
  const [galleryFor, setGalleryFor] = useState(active?.id);
  if (galleryFor !== active?.id) {
    setGalleryFor(active?.id);
    setGalleryIndex(0);
  }

  const activeSpeciesId = active?.id;
  const requested = useRef(new Set<string>());
  useEffect(() => {
    if (!activeSpeciesId || requested.current.has(activeSpeciesId)) return;
    requested.current.add(activeSpeciesId);
    const single = [{ url: `/api/species/${activeSpeciesId}/reference-photo/display`, credit: null }];
    api
      .get(apiPath("/species/{id}/reference-photos", { id: activeSpeciesId }))
      .then((res) => res.photos)
      // The card's own photo is there even when the list isn't.
      .catch(() => [])
      .then((list) => setGalleries((g) => ({ ...g, [activeSpeciesId]: list.length > 0 ? list : single })));
  }, [activeSpeciesId]);

  // The open photo can leave the list (removed from the import): nothing left to compare.
  const onCloseRef = useLatest(onClose);
  useEffect(() => {
    if (!row) onCloseRef.current();
  }, [row, onCloseRef]);

  const setLeft = (v: View) => {
    setLeftView(v);
    if (linked) setRightView(v);
  };
  const setRight = (v: View) => {
    setRightView(v);
    if (linked) setLeftView(v);
  };
  function onPhotoLoad(e: SyntheticEvent<HTMLImageElement>) {
    const img = e.currentTarget;
    const framed =
      row?.subject && img.naturalHeight && img.offsetHeight
        ? frameView(row.subject, img.naturalWidth / img.naturalHeight / (img.offsetWidth / img.offsetHeight))
        : FIT;
    setSubjectView(framed);
    setLeft(framed);
  }
  const zoomed = leftView.scale > 1 || rightView.scale > 1;
  const fitBoth = () => {
    setLeftView(FIT);
    setRightView(FIT);
  };
  const toggleZoom = () => (zoomed ? fitBoth() : setLeft(subjectView ?? FIT));
  function zoomBoth(factor: number) {
    setLeftView((v) => zoomView(v, v.scale * factor));
    setRightView((v) => zoomView(v, v.scale * factor));
  }

  function showPhoto(key: string) {
    setCurrentKey(key);
    setActiveId(null);
  }
  // After a confirm or a skip: the next photo still to do, or out when there's none.
  function moveOn(keys: string[]) {
    const next = nextToConfirm(rows, row!.key, keys);
    if (!next) return onClose();
    setGroup(null);
    showPhoto(next);
  }
  function confirm() {
    if (!active || !row) return;
    const keys = group ?? [row.key];
    onConfirm(keys, active);
    moveOn(keys);
  }
  function noAnimal() {
    if (!row) return;
    const keys = group ?? [row.key];
    onNoAnimal(keys);
    moveOn(keys);
  }
  // Skip: on to the next photo, deciding and marking nothing (Down does the same).
  const skipTo = () => queue[queue.indexOf(currentKey) + 1];
  function skip() {
    const to = skipTo();
    if (to) showPhoto(to);
  }
  function notThis() {
    const i = candidates.indexOf(active!);
    if (i < candidates.length - 1) setActiveId(candidates[i + 1].id);
  }
  function addTyped(species: SpeciesResult) {
    if (!candidates.some((c) => c.id === species.id)) setTyped((prev) => [...prev, { ...species, score: 0 }]);
    setActiveId(species.id);
    setSearching(false);
  }
  const page = (step: number) =>
    photos && photos.length > 1 && setGalleryIndex((i) => (i + step + photos.length) % photos.length);

  const latest = useLatest({
    queue,
    currentKey,
    candidates,
    confirm,
    noAnimal,
    fitBoth,
    toggleZoom,
    zoomBoth,
    page,
    showPhoto,
    startSearch,
    viewer,
  });
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const l = latest.current;
      // The Lightbox over compare has the keys.
      if (l.viewer || isTypingTarget(e.target) || e.defaultPrevented || e.altKey) return;
      const at = l.queue.indexOf(l.currentKey);
      if (matches(e, "importNoAnimal")) l.noAnimal();
      else if (matches(e, "zoomFit")) l.fitBoth();
      else if (matches(e, "zoomIn") || matches(e, "zoomOut")) l.zoomBoth(matches(e, "zoomIn") ? 1.5 : 1 / 1.5);
      else if (e.metaKey || e.ctrlKey) return;
      else if (matches(e, "next")) l.page(1);
      else if (matches(e, "previous")) l.page(-1);
      else if (matches(e, "nextGroup") || matches(e, "previousGroup")) {
        const to = l.queue[at + (matches(e, "nextGroup") ? 1 : -1)];
        if (to) l.showPhoto(to);
      } else if (matches(e, "confirm")) {
        // Enter on a focused button presses that button instead.
        if (e.target instanceof Element && e.target.closest("button, a")) return;
        l.confirm();
      } else if (matches(e, "zoomToggle")) l.toggleZoom();
      else if (matches(e, "compareSpecies")) {
        const pick = l.candidates[Number(e.code.slice(-1)) - 1];
        if (pick) setActiveId(pick.id);
      } else if (/^\p{L}$/u.test(e.key)) {
        // Any other letter starts a species search; the key lands in the field.
        l.startSearch();
        return;
      } else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [latest]);

  if (!row) return null;
  const leftSrc = photoUrl(row);
  const at = queue.indexOf(currentKey);
  const activeName = active ? speciesName(active) : null;
  const runnerUp = candidates.find((c) => c !== active);
  const count = group?.length ?? 1;
  const probably = row.suggestions[0]?.probably;
  const captionHeight = probably ? "h-20" : "h-14";

  const percent = active ? percentOf(active) : null;
  const openLeft = () => setViewer("left");
  const openRight = () => setViewer("right");
  const meta = metaLine([
    percent != null ? t("species.suggestion.match", { percent: formatPercent(percent / 100) }) : null,
    photos && photos.length > 1
      ? t("import.compare.referencePosition", {
          current: Math.min(galleryIndex, photos.length - 1) + 1,
          total: photos.length,
        })
      : null,
    photo?.credit,
  ]);
  return createPortal(
    <div
      ref={dialogRef}
      data-overlay
      // raw-control: a full-window viewer like CompareView and Lightbox, not a sized dialog.
      role="dialog"
      // raw-control: as above.
      aria-modal="true"
      aria-label={t("import.compare.label")}
      tabIndex={-1}
      // raw-control: as above. design-token: the viewer takes focus to hold the keys; its controls show rings.
      className="fixed inset-0 z-50 flex flex-col bg-surround outline-none"
      data-testid="import-compare"
    >
      <WindowTitleBar title={t("import.compare.title")} />
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-page py-2">
        {/* The help sits by the title, as on every page; the title itself moves up on the mac. */}
        <div className="flex min-w-0 flex-1 basis-48 items-center gap-2">
          <div className="min-w-0">
            <h2 className="window-title-elsewhere text-headline text-ink">{t("import.compare.title")}</h2>
            <p className="text-callout tabular-nums text-muted">
              {group
                ? t("import.compare.groupPosition", { current: at + 1, total: queue.length })
                : t("import.compare.position", { current: at + 1, total: queue.length })}
            </p>
          </div>
          <InfoTip
            paragraphs={[t("import.compare.help.keys"), t("import.compare.help.zoom"), t("import.compare.help.search")]}
          />
        </div>
        <div className="flex items-center gap-1">
          <IconButton aria-label={t("shortcuts.action.zoomOut")} onClick={() => zoomBoth(1 / 1.5)}>
            −
          </IconButton>
          <IconButton aria-label={t("shortcuts.action.zoomIn")} onClick={() => zoomBoth(1.5)}>
            +
          </IconButton>
          {(zoomed || (subjectView?.scale ?? 1) > 1) && (
            <Button
              variant="secondary"
              size="sm"
              onClick={toggleZoom}
              tooltip={{ label: t("import.compare.zoomToggle"), shortcut: shortcutLabel("zoomToggle") }}
            >
              {zoomed ? t("compare.fit") : t("import.compare.subject")}
            </Button>
          )}
        </div>
        <label className="flex items-center gap-2 text-callout text-ink">
          <Switch
            checked={linked}
            label={t("import.compare.linkZoom")}
            onChange={(on) => {
              setLinked(on);
              if (on) setRightView(leftView);
            }}
          />
          {t("import.compare.linkZoom")}
        </label>
        <Button size="sm" variant="secondary" onClick={onClose}>
          {t("common.done")}
        </Button>
      </header>

      <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-1 gap-3 p-3 sm:grid-cols-2">
        <figure className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-panel border border-line bg-surface">
          <ZoomPane
            view={leftView}
            onViewChange={setLeft}
            onOpen={leftSrc ? openLeft : undefined}
            openLabel={t("import.compare.openPhoto")}
            className="min-h-0 flex-1 bg-surface-muted"
          >
            {leftSrc ? (
              <img src={leftSrc} alt={nameOf(row)} onLoad={onPhotoLoad} className="h-full w-full object-contain" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-callout text-muted">
                {t("import.compare.noPreview")}
              </div>
            )}
          </ZoomPane>
          {/* Both captions are this one fixed height, so the two photo frames match. A genus line gets
              room for two lines so a long name wraps instead of ending in "...". */}
          <figcaption className={`${captionHeight} shrink-0 border-t border-line px-3 py-2`}>
            <p
              className={`text-callout text-ink wrap-anywhere ${probably ? "truncate" : "line-clamp-2"}`}
              title={nameOf(row)}
            >
              {t("import.compare.yourPhoto", { name: nameOf(row) })}
            </p>
            {probably && (
              <p className="line-clamp-2 text-footnote text-muted wrap-anywhere" title={probably.name}>
                <ProbableGroupText group={probably} />
              </p>
            )}
          </figcaption>
        </figure>

        <figure className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-panel border border-line bg-surface">
          {/* The arrows sit on the photo, as in the Lightbox; they show on hover or focus, always on touch. */}
          <div className="group relative flex min-h-0 flex-1 flex-col">
            <ZoomPane
              view={rightView}
              onViewChange={setRight}
              onOpen={photo ? openRight : undefined}
              openLabel={t("import.compare.openPhoto")}
              className="min-h-0 flex-1 bg-surface-muted"
            >
              {photo ? (
                <ProgressiveImg
                  thumbSrc={photo.url.replace(/\/display(?=\?|$)/, "/thumb")}
                  fullSrc={photo.url}
                  alt={activeName ?? ""}
                  className="h-full w-full object-contain"
                />
              ) : active ? (
                <PhotoPlaceholder className="h-full w-full" />
              ) : (
                <p className="flex h-full w-full items-center justify-center p-4 text-center text-callout text-muted">
                  {t("import.compare.noSuggestions")}
                </p>
              )}
            </ZoomPane>
            {photos && photos.length > 1 && (
              <PhotoArrows
                className={OVERLAY_REVEAL}
                onPrevious={() => page(-1)}
                onNext={() => page(1)}
                previousLabel={t("lightbox.previous")}
                nextLabel={t("lightbox.next")}
              />
            )}
          </div>
          <figcaption className={`${captionHeight} shrink-0 border-t border-line px-3 py-2`}>
            <p className="truncate text-callout font-medium text-ink" title={activeName ?? undefined}>
              {activeName ?? " "}
            </p>
            <p className="truncate text-footnote tabular-nums text-muted" title={meta || undefined}>
              {meta || " "}
            </p>
          </figcaption>
        </figure>
      </div>

      <footer className="flex shrink-0 flex-wrap items-end gap-3 border-t border-line bg-surface px-page py-3">
        <div className="flex min-w-0 max-w-full gap-2">
          {candidates.length > 0 && (
            // p-1 -m-1 keeps overflow-x-auto from clipping the highlighted card's ring.
            <div className="-m-1 flex min-w-0 gap-2 overflow-x-auto p-1">
              {candidates.map((c) => (
                <SuggestionCard
                  key={c.id}
                  suggestion={c}
                  matchPercent={percentOf(c)}
                  highlighted={c === active}
                  onSelect={() => setActiveId(c.id)}
                  onViewPhoto={() => setActiveId(c.id)}
                />
              ))}
            </div>
          )}
          {/* Outside the scrolling strip, so the results list that opens above it isn't clipped. */}
          {/* The same card either way; searching, its hint line becomes the field. */}
          {/* Searching, it widens to the results popover's width (w-56, anchoredBox's minimum), never past the window. */}
          <div
            ref={searchRef}
            data-search-card
            className={`max-w-[calc(100vw-2rem)] shrink-0 transition-[width] duration-150 motion-reduce:transition-none ${searching ? "w-56" : "w-32"}`}
          >
            <MediaCard
              className="h-full"
              // As tall as the collapsed card's square (w-32), so widening never makes the strip taller.
              mediaClassName="h-32"
              media={
                <div
                  className={`flex h-full w-full items-center justify-center bg-surface-muted ${searching ? "text-accent" : "text-muted"}`}
                >
                  <MagnifierIcon className="h-6 w-6" />
                </div>
              }
              title={t("import.compare.searchCard")}
              titleClassName="text-footnote"
              lines={[
                searching ? (
                  <div className="mt-1">
                    <SpeciesPicker
                      anchorRef={searchRef}
                      regionId={regionId}
                      onSelect={addTyped}
                      ariaLabel={t("import.compare.searchCard")}
                      placeholder={
                        runnerUp
                          ? t("import.compare.search", { example: speciesName(runnerUp) })
                          : t("import.compare.searchAny")
                      }
                    />
                  </div>
                ) : (
                  t("import.compare.searchCardHint")
                ),
              ]}
              compact
              selected={searching}
              renderBody={(props) =>
                searching ? (
                  <div {...props} />
                ) : (
                  // raw-control: the whole card is the button, as on SuggestionCard.
                  <button type="button" onClick={startSearch} {...props} />
                )
              }
            />
          </div>
        </div>
        {/* Wraps onto its own line on a narrow window, so every action shows without scrolling. */}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={skip}
            disabled={!skipTo()}
            tooltip={{ label: t("import.compare.skipTip"), shortcut: shortcutLabel("nextGroup") }}
          >
            {t("import.compare.skip")}
            <span className="ml-1.5 text-muted" aria-hidden>
              {shortcutLabel("nextGroup")}
            </span>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={noAnimal}
            tooltip={{ label: t("import.review.noAnimalTip"), shortcut: shortcutLabel("importNoAnimal") }}
          >
            {t("import.compare.noAnimal")}
          </Button>
          {active && candidates.indexOf(active) < candidates.length - 1 && (
            <Button variant="secondary" size="sm" onClick={notThis}>
              {t("import.compare.notThis")}
            </Button>
          )}
          <Button
            size="sm"
            onClick={confirm}
            disabled={!active}
            tooltip={{ label: t("shortcuts.action.confirm"), shortcut: shortcutLabel("confirm") }}
          >
            {t("import.compare.confirm", { count })}
          </Button>
        </div>
      </footer>
      {viewer === "left" && leftSrc && (
        <Lightbox
          slides={[{ url: leftSrc, caption: nameOf(row) }]}
          index={0}
          onIndexChange={() => {}}
          onClose={() => setViewer(null)}
        />
      )}
      {viewer === "right" && photos && (
        <Lightbox
          slides={photos.map((p) => ({
            url: p.url,
            thumbUrl: p.url.replace(/\/display(?=\?|$)/, "/thumb"),
            caption: [activeName, p.credit].filter(Boolean).join(" · "),
          }))}
          index={Math.min(galleryIndex, photos.length - 1)}
          // Paging there pages here too, so compare shows the photo you left on.
          onIndexChange={setGalleryIndex}
          onClose={() => setViewer(null)}
        />
      )}
    </div>,
    document.body,
  );
}
