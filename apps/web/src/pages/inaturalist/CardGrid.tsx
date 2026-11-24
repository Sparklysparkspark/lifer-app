// The iNaturalist page's shared card grid: cards with photo previews, Photos-style selection
// (click toggles, Shift for a range, Mod+A for all), a card menu, a selection bar in the sticky
// header, and a side panel showing every photo. To send, To finish and Completed all use it.
import SelectMark from "../../components/SelectMark";
import MediaCard, { PhotoMosaic, SelectedRing, Thumb, type MosaicPhoto } from "../../components/MediaCard";
import { useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import MagnifierIcon from "../../components/MagnifierIcon";
import Button, { IconButton } from "../../components/Button";
import Menu, { MenuItems, MenuPanel, type MenuAction } from "../../components/Menu";
import { OVERLAY_REVEAL } from "../../lib/buttonClasses";
import SidePanel from "../../components/SidePanel";
import { SelectionBar as SharedSelectionBar, type BarAction } from "../../components/SelectionActionRow";
import { useDropdownMenu } from "../../hooks/useDropdownMenu";
import { matches } from "../../lib/keymap";
import { useTooltip } from "../../components/Tooltip";

// Cards render in pages so thousands stay quick; the photo window pages its photos too.
export const PAGE_SIZE = 120;
const WINDOW_PAGE_SIZE = 200;

/** The trail back from one species to the tab's species list; Esc and the browser's Back go there too. */
export function SpeciesTrail({ speciesName, onBack }: { speciesName: string; onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <nav
      aria-label={t("inaturalist.species.trailLabel")}
      className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-callout"
    >
      <Button
        variant="link"
        size="md"
        className="text-link!"
        onClick={onBack}
        tooltip={{ label: t("inaturalist.species.backTip"), shortcut: t("inaturalist.species.backShortcut") }}
      >
        {t("inaturalist.species.allSpecies")}
      </Button>
      <span aria-hidden className="text-muted">
        /
      </span>
      <h2 className="min-w-0 break-words font-medium text-ink" aria-current="page">
        {speciesName}
      </h2>
    </nav>
  );
}

export type CardPhoto = MosaicPhoto;
// The mosaic's tile count: past it the last tile shows +N and opens the card, as a click does.
const MOSAIC_TILES = 3;

/** Two lines at most, so one long name can't stretch a whole row; the full text shows on hover. */
function Clamped({ text, className = "" }: { text: string; className?: string }) {
  const [clamped, setClamped] = useState(false);
  const tip = useTooltip({ label: text });
  const enter = tip.props.onPointerEnter as (e: PointerEvent<HTMLElement>) => void;
  return (
    <>
      <span
        {...tip.props}
        onPointerEnter={(e) => {
          setClamped(e.currentTarget.scrollHeight > e.currentTarget.clientHeight + 1);
          enter(e);
        }}
        className={`line-clamp-2 wrap-anywhere ${className}`}
      >
        {text}
      </span>
      {clamped && tip.node}
    </>
  );
}
type MenuState = { key: string; point: { x: number; y: number } | null };

/** One card: a click toggles selection, Enter, Space and the magnifier preview its pictures, and a
 *  double-click opens it (its window, or a species). */
function Card({
  name,
  photos,
  lines,
  selected,
  active,
  selecting,
  clickOpens,
  onClick,
  onOpen,
  onPreview,
  openLabel,
  menuItems,
  menuOpen,
  menuPoint,
  onMenu,
  menuRef,
}: {
  name: string;
  photos: CardPhoto[];
  /** Muted lines under the name; empty ones are skipped. */
  lines: ReactNode[];
  selected: boolean;
  /** Its side panel is open: highlighted like a selection, without being selected. */
  active: boolean;
  /** Select mode: the tick shows and a click toggles. */
  selecting: boolean;
  /** Outside select mode a click opens it (a species) rather than previewing its pictures. */
  clickOpens: boolean;
  onClick: (e: { shiftKey: boolean }) => void;
  onOpen: () => void;
  onPreview: () => void;
  /** The +N tile's name; it opens the card. */
  openLabel?: string;
  menuItems: MenuAction[];
  menuOpen: boolean;
  menuPoint: { x: number; y: number } | null;
  /** Opens the menu at a point (right-click) or from its button (null), or closes it (false). */
  onMenu: (point: { x: number; y: number } | null | false) => void;
  menuRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const panel = (
    <MenuPanel>
      <MenuItems items={menuItems} />
    </MenuPanel>
  );

  return (
    <MediaCard
      as="li"
      media={<PhotoMosaic photos={photos} />}
      mediaClassName="aspect-[4/3]"
      title={<Clamped text={name} />}
      lines={lines.map((line) =>
        typeof line === "string" ? <Clamped className="text-footnote text-muted" text={line} /> : line,
      )}
      selected={selected || active}
      markLabel={selecting ? t("photoTile.select") : undefined}
      mediaOverlay={
        photos.length > MOSAIC_TILES && (
          // Over the mosaic's last tile; beside the card body, so it never selects or opens the card.
          <div className="grid h-full w-full grid-cols-3 grid-rows-2 gap-0.5">
            {/* raw-control: the photo tile is the button; the mosaic draws the +N under it. */}
            <button
              type="button"
              aria-label={openLabel ?? t("inaturalist.import.showAllPhotos", { count: photos.length })}
              onClick={(e) => {
                // WebKit doesn't focus a clicked button; the window hands focus back to this tile.
                e.currentTarget.focus();
                onOpen();
              }}
              // design-token: a light wash over the photo scrim, as the overlay pills use.
              className="pointer-events-auto col-start-3 row-start-2 cursor-pointer transition-colors hover:bg-white/15 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
            />
          </div>
        )
      }
      renderBody={({ className, children }) => (
        <div
          role="option"
          aria-selected={selected}
          aria-current={active || undefined}
          aria-label={name}
          tabIndex={0}
          onClick={(e) => {
            // Outside select mode a click looks (pictures, or into a species); a modified click selects.
            if (!selecting && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
              if (e.detail <= 1) (clickOpens ? onOpen : onPreview)();
              return;
            }
            // A double-click opens without changing the selection: its second click undoes the first.
            if (e.detail <= 1) onClick(e);
            else if (e.detail === 2) onClick({ shiftKey: false });
          }}
          onDoubleClick={selecting ? onOpen : undefined}
          onKeyDown={(e) => {
            // Space shows the pictures, as in the Gallery; Enter opens it.
            if (matches(e, "peek")) {
              e.preventDefault();
              onPreview();
            } else if (matches(e, "open")) {
              e.preventDefault();
              onOpen();
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            const box = e.currentTarget.getBoundingClientRect();
            // The keyboard's menu key reports no pointer, so the menu opens at the card.
            onMenu(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: box.left + 8, y: box.top + 8 });
          }}
          className={`${className} cursor-default select-none`}
        >
          {children}
        </div>
      )}
      actions={
        <>
          {/* Preview and ⋯ are one matched pair: the same overlay pill, as the Gallery tile's ⋯. */}
          <IconButton
            tone="overlay"
            aria-label={t("inaturalist.import.preview")}
            tooltip={{ shortcut: t("inaturalist.import.previewShortcut") }}
            onClick={onPreview}
            className={OVERLAY_REVEAL}
          >
            <MagnifierIcon />
          </IconButton>
          <Menu
            open={menuOpen && !menuPoint}
            onToggle={() => onMenu(menuOpen ? false : null)}
            menuRef={menuRef}
            // A flex box, not a line box, so the ⋯ pill sits on the same line as Preview's.
            className="relative flex"
          >
            {panel}
          </Menu>
          {menuPoint && (
            <Menu open={menuOpen} onToggle={() => onMenu(false)} menuRef={menuRef} anchorPoint={menuPoint}>
              {panel}
            </Menu>
          )}
        </>
      }
    />
  );
}

export interface GridCard {
  key: string;
  name: string;
  photos: CardPhoto[];
  lines: ReactNode[];
  menu: MenuAction[];
  /** The +N tile's name when opening isn't "every photo", e.g. a species. */
  openLabel?: string;
}

/** The grid of cards, paged, as a multi-select list. */
export function CardGrid({
  cards,
  label,
  selected,
  onToggle,
  onSelectAll,
  onClearSelection,
  onOpen,
  onPreview,
  selecting,
  clickOpens = false,
  cardWidth = 150,
  activeKey = null,
}: {
  cards: GridCard[];
  label: string;
  selected: Set<string>;
  onToggle: (key: string, range: boolean) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onOpen: (key: string) => void;
  /** The card's pictures in the Lightbox, from one of them. */
  onPreview: (key: string, index?: number) => void;
  /** Select mode (the toolbar's Select): ticks show and clicks toggle. */
  selecting: boolean;
  /** Outside select mode a click opens the card (a species, or a sighting's window) instead of previewing. */
  clickOpens?: boolean;
  /** The smallest card width, from the View menu's size. */
  cardWidth?: number;
  /** The card whose side panel is open. */
  activeKey?: string | null;
}) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(PAGE_SIZE);
  // One card menu open at a time, from its ⋯ button or a right-click.
  const menu = useDropdownMenu<MenuState>();
  return (
    <>
      <ul
        role="listbox"
        aria-multiselectable
        aria-label={label}
        onClick={(e) => {
          // The gaps between cards are background too.
          if (e.target === e.currentTarget) onClearSelection();
        }}
        onKeyDown={(e) => {
          // Mod+A selects every listed card, as in the Gallery.
          if (matches(e, "selectAll")) {
            e.preventDefault();
            onSelectAll();
          }
        }}
        // Rows stretch every card to the tallest; the clamped text keeps that bounded.
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${cardWidth}px, 1fr))` }}
      >
        {cards.slice(0, shown).map((c) => (
          <Card
            key={c.key}
            name={c.name}
            photos={c.photos}
            lines={c.lines}
            selected={selected.has(c.key)}
            active={c.key === activeKey}
            selecting={selecting}
            clickOpens={clickOpens}
            onClick={(e) => onToggle(c.key, e.shiftKey)}
            onOpen={() => onOpen(c.key)}
            onPreview={() => onPreview(c.key)}
            openLabel={c.openLabel}
            menuItems={c.menu}
            menuOpen={menu.openKey?.key === c.key}
            menuPoint={menu.openKey?.key === c.key ? menu.openKey.point : null}
            onMenu={(point) => menu.setOpenKey(point === false ? null : { key: c.key, point })}
            menuRef={menu.ref}
          />
        ))}
      </ul>
      {cards.length > shown && (
        <Button variant="secondary" size="sm" onClick={() => setShown((n) => n + PAGE_SIZE)}>
          {t("manageList.showMore", { count: Math.min(PAGE_SIZE, cards.length - shown) })}
        </Button>
      )}
    </>
  );
}

/** Arrow keys move between a photo grid's buttons, a row at a time for up and down. */
function moveFocus(e: KeyboardEvent<HTMLUListElement>) {
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -2, ArrowDown: 2 }[e.key];
  if (!step) return;
  const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0) return;
  const columns = getComputedStyle(e.currentTarget).gridTemplateColumns.split(" ").filter(Boolean).length || 1;
  const next = at + (Math.abs(step) === 2 ? Math.sign(step) * columns : step);
  e.preventDefault();
  buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
}

/** The selection bar in the sticky page header: the shared select bar while selecting, else a
 *  quiet line with how many a filter leaves and the tab's idle action (Send all, Check now). */
export function SelectionBar({
  slot,
  selecting,
  selectedCount,
  total,
  onSelectAll,
  onClear,
  emptyText,
  shownLabel,
  actions,
  idle,
}: {
  slot: HTMLElement | null;
  selecting: boolean;
  /** Sightings or observations selected; a selected species counts all of its own. */
  selectedCount: number;
  /** How many Select all would select, counted the same way. */
  total: number;
  onSelectAll: () => void;
  onClear: () => void;
  emptyText: string;
  /** "N sightings" when a filter hides some; null when the tab's own count already says it. */
  shownLabel: string | null;
  /** Shown while something is selected. */
  actions: BarAction[];
  /** Shown while nothing is selected, e.g. Send all. */
  idle?: ReactNode;
}) {
  if (!slot) return null;
  if (selecting || selectedCount > 0)
    return createPortal(
      // Full width at the header's foot, its border over the header's own.
      <div className="-mx-6 mt-3 -mb-[17px]">
        <SharedSelectionBar
          count={selectedCount}
          total={total}
          onSelectAll={onSelectAll}
          onDeselectAll={onClear}
          emptyText={emptyText}
          actions={actions}
        />
      </div>,
      slot,
    );
  if (!shownLabel && !idle) return null;
  return createPortal(
    <div className="mt-3 flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2 text-footnote">
      {shownLabel && <span className="shrink-0 text-muted">{shownLabel}</span>}
      {idle && <div className="flex flex-1 justify-end">{idle}</div>}
    </div>,
    slot,
  );
}

/** The side panel opened from a card: every photo, with optional click-to-toggle, and its actions.
 *  A panel rather than a dialog, so the grid stays usable beside it and another card swaps it. */
export function PhotoWindow({
  name,
  info,
  photos,
  excludedIds,
  onExcludedChange,
  extra,
  footer,
  primary,
  onPhotoOpen,
  onClose,
}: {
  name: string;
  /** Lines under the title. */
  info: Array<string | null>;
  /** Under the lines, e.g. the place picker. */
  extra?: ReactNode;
  photos: CardPhoto[];
  /** With these, each photo's corner tick leaves it out or puts it back. */
  excludedIds?: Set<string>;
  onExcludedChange?: (ids: Set<string>) => void;
  /** Secondary actions, before Done. */
  footer?: ReactNode;
  /** The main action, last, after Done. */
  primary?: ReactNode;
  /** A click on a photo opens it in the viewer at that index. */
  onPhotoOpen?: (index: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(WINDOW_PAGE_SIZE);
  const total = photos.length;
  const picking = excludedIds !== undefined && onExcludedChange !== undefined && total > 1;
  const leftOut = picking ? photos.filter((p) => excludedIds.has(p.id)).length : 0;

  function toggle(id: string) {
    const next = new Set(excludedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onExcludedChange?.(next);
  }

  return (
    <SidePanel
      open
      onClose={onClose}
      title={<span className="break-words">{name}</span>}
      footerStart={
        picking && (
          // Each shows only when it would change something, so a half-ticked sighting offers both.
          <span className="flex gap-3">
            {leftOut > 0 && (
              <Button variant="link" size="sm" onClick={() => onExcludedChange(new Set())}>
                {t("inaturalist.import.tickAll")}
              </Button>
            )}
            {leftOut < total && (
              <Button variant="link" size="sm" onClick={() => onExcludedChange(new Set(photos.map((p) => p.id)))}>
                {t("inaturalist.import.untickAll")}
              </Button>
            )}
          </span>
        )
      }
      footer={
        <>
          {footer}
          <Button variant="secondary" onClick={onClose}>
            {t("common.done")}
          </Button>
          {primary}
        </>
      }
    >
      <div className="space-y-3">
        <div>
          {info.map(
            (line, i) =>
              line && (
                <p key={i} className="text-footnote text-muted">
                  {line}
                </p>
              ),
          )}
        </div>
        {extra}
        {picking && <p className="text-footnote text-muted">{t("inaturalist.import.windowHint")}</p>}
        <ul
          className="grid gap-1.5"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))" }}
          onKeyDown={moveFocus}
        >
          {photos.slice(0, shown).map((p, i) => {
            const on = !picking || !excludedIds.has(p.id);
            const thumb = (
              <>
                <Thumb photoId={p.photoId} src={p.src} dim={!on} className="h-full w-full" />
                {picking && on && <SelectedRing />}
                {!on && (
                  <span className="absolute inset-x-0 bottom-0 bg-surface/90 py-0.5 text-center text-caption font-medium text-ink">
                    {t("inaturalist.import.leftOut")}
                  </span>
                )}
              </>
            );
            return (
              <li key={p.id} className="relative">
                {onPhotoOpen ? (
                  // raw-control: the whole photo is the button that opens the viewer.
                  <button
                    type="button"
                    aria-label={t("inaturalist.import.openPhoto", { n: i + 1, count: total })}
                    onClick={(e) => {
                      // WebKit doesn't focus a clicked button; the viewer hands focus back to it.
                      e.currentTarget.focus();
                      onPhotoOpen(i);
                    }}
                    className={`relative block aspect-square w-full cursor-pointer overflow-hidden rounded-control transition-opacity hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
                  >
                    {thumb}
                  </button>
                ) : (
                  <div className="relative block aspect-square w-full overflow-hidden rounded-control">{thumb}</div>
                )}
                {picking && (
                  <SelectMark
                    checked={on}
                    label={t("inaturalist.import.includePhoto", { n: i + 1, count: total })}
                    onChange={() => toggle(p.id)}
                  />
                )}
              </li>
            );
          })}
        </ul>
        {total > shown && (
          <Button variant="secondary" size="sm" onClick={() => setShown((n) => n + WINDOW_PAGE_SIZE)}>
            {t("manageList.showMore", { count: Math.min(WINDOW_PAGE_SIZE, total - shown) })}
          </Button>
        )}
      </div>
    </SidePanel>
  );
}
