import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { apiPath, type ApiResponse } from "../../api/client";
import { useApiRoute } from "../../lib/resource";
import { matches } from "../../lib/keymap";
import { formatNumber } from "../../lib/format";
import { Tooltip } from "../../components/Tooltip";
import type { GalleryItem } from "./types";
import { coverOf } from "./useGalleryBursts";

type Scene = ApiResponse<"/captures/{id}/scene">;

// Fixed tile size, so a tile's x position is known without measuring and only the visible ones draw.
const TILE = 56;
const GAP = 4;
// Wider between bursts than between frames, so the bursts read as groups.
const BURST_GAP = 16;
// Tiles drawn past each edge, so a quick scroll never shows a gap.
const OVERSCAN_PX = TILE * 6;
// The viewer's dark backdrop, as its caption: the summary text, the open burst's band, and the
// current photo's outline and focus ring.
const ON_DARK = {
  text: "text-footnote text-white/50", // design-token: caption text on the dark backdrop
  band: "bg-white/10", // design-token: a faint band on the dark backdrop
  current: "ring-2 ring-white", // design-token: the current photo's outline on the dark backdrop
  // design-token: a focus ring that shows on the dark backdrop
  focus: "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white",
};
// Before the strip is laid out (and in tests): about a laptop window's width.
const FALLBACK_WIDTH = 1000;

interface Tile {
  item: GalleryItem;
  burst: number;
  /** The frame in its burst; null for a folded burst's stack tile. */
  frame: number | null;
  x: number;
}

/** The photo's burst unfolded, every other burst of the scene a tile of its own, in time order. */
function tilesOf(scene: Scene["scene"], current: number): Tile[] {
  const tiles: Tile[] = [];
  let x = 0;
  scene.forEach((b, burst) => {
    if (burst > 0) x += BURST_GAP - GAP;
    const unfold = burst === current || b.frames.length === 1;
    const shown = unfold ? b.frames : [coverOf(b.frames)];
    shown.forEach((item, i) => {
      tiles.push({ item, burst, frame: unfold ? i : null, x });
      x += TILE + GAP;
    });
  });
  return tiles;
}

function locate(data: Scene | null, captureId: string) {
  if (!data) return null;
  for (let b = 0; b < data.scene.length; b++) {
    const f = data.scene[b].frames.findIndex((it) => it.captureId === captureId);
    if (f >= 0) return { burst: b, frame: f };
  }
  return null;
}

/** The viewer's mini gallery of the photo's burst and the bursts around it in its scene. Picking a
 *  tile (click, or the arrow keys while the strip has focus) moves the viewer there; a folded burst
 *  opens on its cover, which unfolds it. Nothing shows for a photo alone. */
export default function SceneStrip({
  captureId,
  onPick,
}: {
  captureId: string;
  /** The picked photo, and every photo of the scene in order. */
  onPick: (item: GalleryItem, scene: GalleryItem[]) => void;
}) {
  const { t } = useTranslation();
  const fetched = useApiRoute(apiPath("/captures/{id}/scene", { id: captureId })).data;
  // Moving within the scene keeps the strip drawn while the next answer loads.
  const [kept, setKept] = useState<Scene | null>(null);
  if (fetched && fetched !== kept) setKept(fetched);
  const data = fetched ?? (locate(kept, captureId) ? kept : null);
  const at = locate(data, captureId);
  const tiles = data && at ? tilesOf(data.scene, at.burst) : [];
  const currentTile = tiles.findIndex((tile) => tile.item.captureId === captureId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, width: 0 });
  const width = view.width || FALLBACK_WIDTH;
  const focusNext = useRef(false);
  const tileX = currentTile >= 0 ? tiles[currentTile].x : 0;
  const totalWidth = tiles.length ? tiles[tiles.length - 1].x + TILE : 0;

  // The current photo stays in view, centred when the strip scrolls.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || currentTile < 0) return;
    const w = el.clientWidth || FALLBACK_WIDTH;
    const left = Math.max(0, Math.min(tileX - w / 2 + TILE / 2, totalWidth - w));
    el.scrollLeft = left;
    setView({ left, width: el.clientWidth });
  }, [currentTile, tileX, totalWidth]);
  useLayoutEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    scrollRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
  });

  if (!data || !at || tiles.length < 2) return null;
  const frames = data.scene.flatMap((b) => b.frames);
  const burstSize = data.scene[at.burst].frames.length;
  const bursts = data.scene.length;
  const summary =
    burstSize > 1 && bursts > 1
      ? t("bursts.burstAndScene", { photos: burstSize, bursts })
      : burstSize > 1
        ? t("bursts.burstOnly", { count: burstSize })
        : t("bursts.sceneOnly", { count: bursts });
  const pick = (tile: Tile) => onPick(tile.item, frames);
  const onKeyDown = (e: KeyboardEvent) => {
    const to = matches(e, "previous")
      ? currentTile - 1
      : matches(e, "next")
        ? currentTile + 1
        : matches(e, "listFirst")
          ? 0
          : matches(e, "listLast")
            ? tiles.length - 1
            : null;
    if (to === null) return;
    // The viewer's own arrows would step through the grid instead.
    e.preventDefault();
    e.stopPropagation();
    const tile = tiles[Math.max(0, Math.min(to, tiles.length - 1))];
    if (tile.item.captureId === captureId) return;
    focusNext.current = true;
    pick(tile);
  };
  const visible = tiles.filter(
    (tile) => tile.x + TILE >= view.left - OVERSCAN_PX && tile.x <= view.left + width + OVERSCAN_PX,
  );
  const own = tiles.filter((tile) => tile.burst === at.burst);

  return (
    <div className="mt-2 w-full">
      <p className={ON_DARK.text}>{summary}</p>
      {data.truncated && <p className={ON_DARK.text}>{t("bursts.truncated", { count: frames.length })}</p>}
      <div
        ref={scrollRef}
        role="toolbar"
        aria-label={t("bursts.stripLabel")}
        onKeyDown={onKeyDown}
        onScroll={(e) => setView({ left: e.currentTarget.scrollLeft, width: e.currentTarget.clientWidth })}
        className="mt-1 overflow-x-auto py-1"
      >
        <div className="relative mx-auto" style={{ width: totalWidth, height: TILE }}>
          {burstSize > 1 && (
            <div
              aria-hidden
              className={`absolute -inset-y-1 rounded-control ${ON_DARK.band}`}
              style={{ left: own[0].x - 2, width: own[own.length - 1].x + TILE - own[0].x + 4 }}
            />
          )}
          {visible.map((tile) => {
            const count = data.scene[tile.burst].frames.length;
            const current = tile.item.captureId === captureId;
            const label =
              tile.frame !== null && tile.burst === at.burst && count > 1
                ? t("bursts.frame", { index: tile.frame + 1, count })
                : t("bursts.burst", { index: tile.burst + 1, total: bursts, count });
            return (
              <Tooltip key={tile.item.captureId} content={{ label }}>
                {(tip) => (
                  // raw-control: a thumbnail on the viewer's dark backdrop.
                  <button
                    {...tip}
                    type="button"
                    tabIndex={current ? 0 : -1}
                    aria-label={label}
                    aria-current={current || undefined}
                    onClick={() => !current && pick(tile)}
                    className={`absolute top-0 overflow-hidden rounded-control transition-opacity ${ON_DARK.focus} ${
                      current ? ON_DARK.current : "opacity-70 hover:opacity-100"
                    }`}
                    style={{ left: tile.x, width: TILE, height: TILE }}
                  >
                    <img
                      src={`/api/photos/${tile.item.photoId}/thumb`}
                      alt=""
                      draggable={false}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                    {tile.frame === null && (
                      // design-token: a scrim over the photo, as the grid's stack badge.
                      <span className="pointer-events-none absolute bottom-0.5 right-0.5 rounded-badge bg-black/60 px-1 text-caption text-white">
                        {formatNumber(count)}
                      </span>
                    )}
                  </button>
                )}
              </Tooltip>
            );
          })}
        </div>
      </div>
    </div>
  );
}
