// The iNaturalist page's shared card grid: cards with photo previews, Photos-style selection
// (click toggles, Shift for a range, Mod+A for all), a card menu, a selection bar in the sticky
// header, and a window showing every photo. To send, To finish and Completed all use it.
import SelectMark from "../../components/SelectMark";
import MediaCard, { PhotoMosaic, SelectedRing, Thumb, type MosaicPhoto } from "../../components/MediaCard";
import { useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import MagnifierIcon from "../../components/MagnifierIcon";
import Button, { IconButton } from "../../components/Button";
import Menu, { MenuItems, MenuPanel, type MenuAction } from "../../components/Menu";
import { OVERLAY_REVEAL } from "../../lib/buttonClasses";
import Modal from "../../components/Modal";
import ActionRow, { type BarAction } from "../../components/SelectionActionRow";
import { useDropdownMenu } from "../../hooks/useDropdownMenu";
import { matches, shortcutLabels } from "../../lib/keymap";

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
type MenuState = { key: string; point: { x: number; y: number } | null };

/** One card: a click toggles selection, Enter, Space and the magnifier preview its pictures, and a
 *  double-click opens it (its window, or a species). */
function Card({
  name,
  photos,
  lines,
  selected,
  selecting,
  clickOpens,
  onClick,
  onOpen,
  onPreview,
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
  /** Select mode: the tick shows and a click toggles. */
  selecting: boolean;
  /** Outside select mode a click opens it (a species) rather than previewing its pictures. */
  clickOpens: boolean;
  onClick: (e: { shiftKey: boolean }) => void;
  onOpen: () => void;
  onPreview: () => void;
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
      title={name}
      lines={lines}
      selected={selected}
      markLabel={selecting ? t("photoTile.select") : undefined}
      renderBody={({ className, children }) => (
        <div
          role="option"
          aria-selected={selected}
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
}: {
  cards: GridCard[];
  label: string;
  selected: Set<string>;
  onToggle: (key: string, range: boolean) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onOpen: (key: string) => void;
  /** The card's pictures in the Lightbox. */
  onPreview: (key: string) => void;
  /** Select mode (the toolbar's Select): ticks show and clicks toggle. */
  selecting: boolean;
  /** Species cards: outside select mode a click opens the species. */
  clickOpens?: boolean;
  /** The smallest card width, from the View menu's size. */
  cardWidth?: number;
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
        className="grid items-start gap-3"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${cardWidth}px, 1fr))` }}
      >
        {cards.slice(0, shown).map((c) => (
          <Card
            key={c.key}
            name={c.name}
            photos={c.photos}
            lines={c.lines}
            selected={selected.has(c.key)}
            selecting={selecting}
            clickOpens={clickOpens}
            onClick={(e) => onToggle(c.key, e.shiftKey)}
            onOpen={() => onOpen(c.key)}
            onPreview={() => onPreview(c.key)}
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

// Esc, or Select None's Mod+Shift+A, clears the selection (useCardSelection).
const clearShortcuts = () => ["Escape", ...shortcutLabels("selectNone")].join(", ");

/** The selection bar, rendered into the sticky page header so it stays in view. */
export function SelectionBar({
  slot,
  selectedCount,
  selectedLabel,
  shownLabel,
  onClear,
  actions,
  idle,
}: {
  slot: HTMLElement | null;
  selectedCount: number;
  /** Replaces "N selected", e.g. "3 species, 41 observations selected". */
  selectedLabel?: string;
  /** "N sightings" when a filter hides some; null when the tab's own count already says it. */
  shownLabel: string | null;
  onClear: () => void;
  /** Shown while something is selected. */
  actions: BarAction[];
  /** Shown while nothing is selected, e.g. Send all. */
  idle?: ReactNode;
}) {
  const { t } = useTranslation();
  // Select all and none live in the toolbar's Select menu; the bar only appears with something to say.
  if (!slot || (selectedCount === 0 && !shownLabel && !idle)) return null;
  return createPortal(
    <div className="mt-3 flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2 text-footnote">
      {(selectedCount > 0 || shownLabel) && (
        <span className="shrink-0 text-muted">
          {selectedCount > 0
            ? (selectedLabel ?? t("inaturalist.import.selectedCount", { count: selectedCount }))
            : shownLabel}
        </span>
      )}
      {selectedCount > 0 && (
        <Button
          variant="secondary"
          size="sm"
          onClick={onClear}
          tooltip={{
            label: t("inaturalist.import.clearSelection"),
            shortcut: clearShortcuts(),
          }}
        >
          {t("inaturalist.import.clearSelection")}
        </Button>
      )}
      {selectedCount > 0 && actions.length > 0 ? (
        // Wraps onto its own line before the main action would fold into More.
        <div className="flex min-w-64 flex-1">
          <ActionRow actions={actions} />
        </div>
      ) : (
        idle && <div className="flex flex-1 justify-end">{idle}</div>
      )}
    </div>,
    slot,
  );
}

/** The window opened from a card: every photo, with optional click-to-toggle, and its actions. */
export function PhotoWindow({
  name,
  info,
  photos,
  excludedIds,
  onExcludedChange,
  extra,
  footer,
  onClose,
}: {
  name: string;
  /** Lines under the title. */
  info: Array<string | null>;
  /** Under the lines, e.g. the place picker. */
  extra?: ReactNode;
  photos: Array<{ id: string; photoId: string | null }>;
  /** With these, a click on a photo leaves it out or puts it back. */
  excludedIds?: Set<string>;
  onExcludedChange?: (ids: Set<string>) => void;
  footer: ReactNode;
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
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={<span className="break-words">{name}</span>}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.done")}
          </Button>
          {footer}
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
        {picking && (
          <>
            <p className="text-footnote text-muted">{t("inaturalist.import.windowHint")}</p>
            <Button
              variant="link"
              size="sm"
              onClick={() => onExcludedChange(leftOut === 0 ? new Set(photos.map((p) => p.id)) : new Set())}
            >
              {leftOut === 0 ? t("inaturalist.import.untickAll") : t("inaturalist.import.tickAll")}
            </Button>
          </>
        )}
        <ul className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))" }}>
          {photos.slice(0, shown).map((p, i) => {
            if (!picking) {
              return (
                <li key={p.id}>
                  <Thumb photoId={p.photoId} className="aspect-square w-full rounded-control" />
                </li>
              );
            }
            const on = !excludedIds.has(p.id);
            return (
              <li key={p.id} className="relative">
                {/* raw-control: the whole photo is the toggle; the corner tick only shows its state. */}
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  aria-label={t("inaturalist.import.includePhoto", { n: i + 1, count: total })}
                  onClick={() => toggle(p.id)}
                  className={`relative block aspect-square w-full overflow-hidden rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
                >
                  <Thumb photoId={p.photoId} dim={!on} className="h-full w-full" />
                  {on && <SelectedRing />}
                  {!on && (
                    <span className="absolute inset-x-0 bottom-0 bg-surface/90 py-0.5 text-center text-caption font-medium text-ink">
                      {t("inaturalist.import.leftOut")}
                    </span>
                  )}
                </button>
                <SelectMark checked={on} label={t("photoTile.select")} />
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
    </Modal>
  );
}
