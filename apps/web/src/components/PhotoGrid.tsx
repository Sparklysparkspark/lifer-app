import { memo, useCallback, useState, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from "react";
import MasonryGrid from "./MasonryGrid";
import PhotoTile from "./PhotoTile";
import InlineSpinner from "./InlineSpinner";
import Chevron from "./Chevron";
import { formatNumber } from "../lib/format";
import { useVersionCounts } from "../lib/photoVersions";

/** What a tile shows for one item. */
export interface PhotoGridTileData {
  /** Null shows a placeholder (a photo whose file is gone). */
  photoId: string | null;
  alt: string;
  kind?: "image" | "video" | "audio" | null;
  durationSeconds?: number | string | null;
  width?: number | null;
  height?: number | null;
  /** A version listed apart from its photo, by its name. */
  versionLabel?: string;
}

/** useSelectMode's shape; a page without range or drag select passes just a toggle. */
export interface PhotoGridSelection {
  selectMode: boolean;
  selectedIds: ReadonlySet<string>;
  dragPreviewIds?: ReadonlySet<string> | null;
  toggle: (id: string, index: number, shiftKey: boolean) => void;
  dragProps?: { onDragSelectStart: (index: number) => void; onDragSelectEnter: (index: number) => void };
}

/** useDropdownMenu<string>()'s shape: which tile's menu is open. */
export interface PhotoGridMenu {
  openKey: string | null;
  setOpenKey: Dispatch<SetStateAction<string | null>>;
  ref: RefObject<HTMLDivElement | null>;
}

type Anchor = { key: string; x: number; y: number };
type Cell<T> = { kind: "photo"; item: T; i: number } | { kind: "pending"; key: string };

// 3:2 stands in for an ordinary landscape photo until an upload or import reports real dimensions.
const PENDING_ASPECT = 3 / 2;
const EMPTY: ReadonlySet<string> = new Set();

/** Every photo grid: justified rows (windowed by MasonryGrid), PhotoTile, select mode, the ⋯ and
 *  right-click menu, loading tiles and optional groups. Indices are positions in `items`. Pass
 *  stable `idFor`, `tileFor` and `renderLabel` to keep untouched tiles from re-rendering. */
export default function PhotoGrid<T>({
  items,
  idFor,
  tileFor,
  columnWidth,
  gap,
  cornerRadiusPx,
  groups,
  pending,
  select,
  menu,
  renderMenu,
  renderLabel,
  onOpen,
  empty,
}: {
  items: T[];
  /** Selection and menu id (a capture id). */
  idFor: (item: T) => string;
  tileFor: (item: T) => PhotoGridTileData;
  columnWidth: number;
  gap?: number;
  cornerRadiusPx?: number;
  /** One justified block per group, each under its heading; `i` indexes `items`. With `onToggle`
   *  the heading is a disclosure with a count, as in GroupedSpeciesGrid; `action` sits beside it. */
  groups?: Array<{
    key: string;
    label: ReactNode;
    entries: Array<{ item: T; i: number }>;
    collapsed?: boolean;
    onToggle?: () => void;
    action?: ReactNode;
  }> | null;
  /** Loading tiles for photos still arriving, after the rest or `first`. */
  pending?: { keys: readonly string[]; label: string; first?: boolean };
  select: PhotoGridSelection;
  menu?: PhotoGridMenu;
  /** Built only for the tile whose menu is open. */
  renderMenu?: (item: T) => ReactNode;
  renderLabel?: (item: T, index: number) => ReactNode;
  onOpen: (index: number) => void;
  /** Shown instead of the grid when there is nothing, not even a loading tile. */
  empty?: ReactNode;
}) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const versionCounts = useVersionCounts();
  const setOpenKey = menu?.setOpenKey;
  const toggleMenu = useCallback(
    (key: string) => {
      setAnchor(null);
      setOpenKey?.((open) => (open === key ? null : key));
    },
    [setOpenKey],
  );
  const openContextMenu = useCallback(
    (key: string, point: { x: number; y: number }) => {
      setOpenKey?.(key);
      setAnchor({ key, ...point });
    },
    [setOpenKey],
  );

  if (items.length === 0 && !pending?.keys.length && empty !== undefined) return <>{empty}</>;

  const previewIds = select.dragPreviewIds ?? EMPTY;
  const pendingCells = (pending?.keys ?? []).map((key): Cell<T> => ({ kind: "pending", key }));

  function renderGrid(entries: Array<{ item: T; i: number }>, withPending: boolean) {
    const photos = entries.map(({ item, i }): Cell<T> => ({ kind: "photo", item, i }));
    const cells = !withPending ? photos : pending?.first ? [...pendingCells, ...photos] : [...photos, ...pendingCells];
    return (
      <MasonryGrid
        items={cells}
        columnWidth={columnWidth}
        gap={gap}
        keyFor={(cell) => (cell.kind === "pending" ? `pending-${cell.key}` : idFor(cell.item))}
        aspectRatioFor={(cell) => {
          if (cell.kind === "pending") return PENDING_ASPECT;
          const { width, height } = tileFor(cell.item);
          return width && height ? width / height : null;
        }}
        renderItem={(cell, aspectRatio) => {
          if (cell.kind === "pending")
            return (
              <div
                className="flex w-full items-center justify-center rounded-control bg-surface-muted"
                style={{ aspectRatio }}
              >
                <InlineSpinner size="md" tone="ink" label={pending!.label} />
              </div>
            );
          const id = idFor(cell.item);
          const menuOpen = menu?.openKey === id;
          return (
            <GridTile
              key={id}
              item={cell.item}
              index={cell.i}
              id={id}
              tileFor={tileFor as (item: unknown) => PhotoGridTileData}
              aspectRatio={aspectRatio}
              cornerRadiusPx={cornerRadiusPx}
              selectMode={select.selectMode}
              selected={select.selectedIds.has(id) || previewIds.has(id)}
              versionCount={versionCounts.get(id)}
              menuOpen={menuOpen}
              contextAnchor={menuOpen && anchor?.key === id ? anchor : null}
              menuContent={renderMenu ? (menuOpen ? renderMenu(cell.item) : null) : undefined}
              menuRef={menu?.ref}
              renderLabel={renderLabel as ((item: unknown, index: number) => ReactNode) | undefined}
              onOpen={onOpen}
              toggle={select.toggle}
              dragProps={select.dragProps}
              onToggleMenu={toggleMenu}
              onOpenContextMenu={openContextMenu}
            />
          );
        }}
      />
    );
  }

  if (!groups)
    return renderGrid(
      items.map((item, i) => ({ item, i })),
      true,
    );
  return (
    <div className="space-y-section">
      {groups.map((group, g) => (
        <section key={group.key}>
          {group.onToggle ? (
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2 className="min-w-0">
                {/* raw-control: the group's heading is its disclosure. */}
                <button
                  type="button"
                  onClick={group.onToggle}
                  aria-expanded={!group.collapsed}
                  className="flex items-center gap-2 text-left text-callout font-medium text-ink hover:underline"
                >
                  <Chevron open={!group.collapsed} />
                  <span className="min-w-0 break-words">{group.label}</span>{" "}
                  <span className="text-footnote font-normal text-muted">({formatNumber(group.entries.length)})</span>
                </button>
              </h2>
              {group.action}
            </div>
          ) : (
            <h2 className="mb-2 text-callout font-semibold text-ink">{group.label}</h2>
          )}
          {!group.collapsed && renderGrid(group.entries, g === (pending?.first ? 0 : groups.length - 1))}
        </section>
      ))}
    </div>
  );
}

// Memoized so a selection, rating or menu change only re-renders the tiles it touches.
const GridTile = memo(function GridTile({
  item,
  index,
  id,
  tileFor,
  aspectRatio,
  cornerRadiusPx,
  selectMode,
  selected,
  versionCount,
  menuOpen,
  contextAnchor,
  menuContent,
  menuRef,
  renderLabel,
  onOpen,
  toggle,
  dragProps,
  onToggleMenu,
  onOpenContextMenu,
}: {
  item: unknown;
  index: number;
  id: string;
  tileFor: (item: unknown) => PhotoGridTileData;
  aspectRatio: number;
  cornerRadiusPx?: number;
  selectMode: boolean;
  selected: boolean;
  versionCount?: number;
  menuOpen: boolean;
  contextAnchor: Anchor | null;
  /** Undefined: no menu at all. Null: closed. */
  menuContent: ReactNode | undefined;
  menuRef?: RefObject<HTMLDivElement | null>;
  renderLabel?: (item: unknown, index: number) => ReactNode;
  onOpen: (index: number) => void;
  toggle: PhotoGridSelection["toggle"];
  dragProps?: PhotoGridSelection["dragProps"];
  onToggleMenu: (id: string) => void;
  onOpenContextMenu: (id: string, point: { x: number; y: number }) => void;
}) {
  const tile = tileFor(item);
  return (
    <PhotoTile
      photoId={tile.photoId}
      alt={tile.alt}
      kind={tile.kind ?? undefined}
      durationSeconds={tile.durationSeconds == null ? null : Number(tile.durationSeconds)}
      versionCount={versionCount}
      versionLabel={tile.versionLabel}
      onOpen={() => onOpen(index)}
      selectMode={selectMode}
      selected={selected}
      onToggleSelect={(shiftKey) => toggle(id, index, shiftKey)}
      onDragSelectStart={dragProps && (() => dragProps.onDragSelectStart(index))}
      onDragSelectEnter={dragProps && (() => dragProps.onDragSelectEnter(index))}
      aspectRatio={aspectRatio}
      cornerRadiusPx={cornerRadiusPx}
      menuOpen={menuOpen && !contextAnchor}
      onToggleMenu={() => onToggleMenu(id)}
      menuRef={menuRef}
      menuContent={menuContent}
      onOpenContextMenu={menuContent === undefined ? undefined : (point) => onOpenContextMenu(id, point)}
      contextMenuOpen={!!contextAnchor}
      contextMenuAnchor={contextAnchor}
      label={renderLabel?.(item, index)}
    />
  );
});
