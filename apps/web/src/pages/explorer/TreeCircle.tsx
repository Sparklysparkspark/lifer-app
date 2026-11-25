// The Tree of life as a circle (sunburst): the focused group in the middle, three rings of the
// groups inside it, each arc sized by its catalogue species and filled outward by your share.
// Clicking a group zooms into it; the middle steps back out. An "N more groups" arc, standing in
// for groups too thin to draw, zooms into just those groups, laid out across the whole circle. Arrow keys move between arcs. A small
// target marks the arcs holding species on your targets; right-click opens the marks menu. With
// rarity on, a thin band along each arc's outer edge shows its species' average tier, apart from
// the green of your share.
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../../lib/format";
import { matches } from "../../lib/keymap";
import { RarityLegend, Swatch } from "./RarityChip";
import { circleArcs, RARITY_FILL, rarityOf, rarityText, type Arc, type TreeIndex, type TreeNode } from "./treeModel";

const SIZE = 600;
const C = SIZE / 2;
const INNER = 96;
const OUTER = C - 4;
const RINGS = 3;
const RING = (OUTER - INNER) / RINGS;

const point = (r: number, a: number) => `${(C + r * Math.sin(a)).toFixed(2)} ${(C - r * Math.cos(a)).toFixed(2)}`;
function arcPath(r0: number, r1: number, start: number, end: number): string {
  // An SVG arc can't end where it starts, so a lone child leaves a hairline.
  const span = Math.min(end - start, 2 * Math.PI - 1e-4);
  const a1 = start + span;
  const large = span > Math.PI ? 1 : 0;
  return `M${point(r1, start)}A${r1} ${r1} 0 ${large} 1 ${point(r1, a1)}L${point(r0, a1)}A${r0} ${r0} 0 ${large} 0 ${point(r0, start)}Z`;
}
// The rarity band's width, and the canvas gap that keeps it off the share fill below it.
const BAND = 8;
const GAP = 2;
// The empty part of an arc: in dark mode a step lighter than the line, so the green stands out 3:1.
const EMPTY = "fill-line dark:fill-surface-muted";
// The marker's distance in from an arc's outer edge, and the arc length it needs to fit.
const MARK_INSET = 10;
const MARK_ROOM = 18;
/** A small target: a ring with a dot, the circle's marker for groups holding targets. */
function TargetMark({ x, y }: { x: number; y: number }) {
  return (
    <g className="pointer-events-none">
      <circle cx={x} cy={y} r={6} className="fill-surface stroke-ink" strokeWidth={1.5} />
      <circle cx={x} cy={y} r={2} className="fill-ink" />
    </g>
  );
}
const inside = (a: Arc, b: Arc) => a.start >= b.start - 1e-9 && a.end <= b.end + 1e-9;

export default function TreeCircle({
  index,
  center,
  genus,
  selected,
  label,
  onPick,
  onMore,
  top,
  onZoomOut,
  onMenu,
  rarity,
}: {
  index: TreeIndex;
  center: string | null;
  genus: boolean;
  selected: string | null;
  label: (node: TreeNode) => string;
  /** An arc was clicked or chosen: select it, and zoom into it when it is a group. */
  onPick: (id: string) => void;
  /** An "N more groups" arc was clicked or chosen. */
  onMore: (arc: Arc) => void;
  /** Set when the circle shows just the groups a "more" arc merged, instead of `center`'s children. */
  top: string[] | null;
  onZoomOut: (() => void) | null;
  /** Right-click on a group or species: its marks menu at the pointer. */
  onMenu: (id: string, point: { x: number; y: number }) => void;
  /** Add the rarity band to each arc. */
  rarity: boolean;
}) {
  const { t } = useTranslation();
  const arcs = useMemo(
    () => circleArcs(index, center, { rings: RINGS, genus, top: top ?? undefined }),
    [index, center, genus, top],
  );
  const [hover, setHover] = useState<Arc | null>(null);
  const [activeAt, setActive] = useState(0);
  // A zoom or a View change gives new arcs; the roving focus then starts again at the first.
  const active = activeAt < arcs.length ? activeAt : 0;
  const [focused, setFocused] = useState(false);
  const refs = useRef<(SVGPathElement | null)[]>([]);
  const svgRef = useRef<SVGSVGElement>(null);
  // A new view (zoom, Back, a swipe) drops the arc focus ring, so it can't pass for a selection.
  const viewKey = `${center ?? ""}|${top?.length ?? ""}`;
  const [lastView, setLastView] = useState(viewKey);
  if (viewKey !== lastView) {
    setLastView(viewKey);
    setFocused(false);
  }
  useEffect(() => {
    if (svgRef.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }, [viewKey]);

  const centerNode = center ? index.byId.get(center)?.node : null;
  const roots = (top ?? index.roots).map((id) => index.byId.get(id)!.node);
  // A hovered arc from before a region change can name a group the new tree lacks.
  const hovered = hover && (!hover.id || index.byId.has(hover.id)) ? hover : null;
  const shown = hovered ?? (focused ? arcs[active] : null);
  const shownNode = shown?.id ? index.byId.get(shown.id)!.node : null;
  const readout = shown && !shown.id ? null : (shownNode ?? (top ? null : centerNode));
  const totals = readout ?? {
    collected: roots.reduce((n, r) => n + r.collected, 0),
    total: roots.reduce((n, r) => n + r.total, 0),
  };

  const move = (to: number) => {
    if (to < 0 || to >= arcs.length) return;
    setActive(to);
    refs.current[to]?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const arc = arcs[active];
    if (!arc) return;
    const ring = arcs.map((a, i) => [a, i] as const).filter(([a]) => a.ring === arc.ring);
    const at = ring.findIndex(([, i]) => i === active);
    if (matches(e, "listNext")) move(ring[(at + 1) % ring.length][1]);
    else if (matches(e, "listPrevious")) move(ring[(at - 1 + ring.length) % ring.length][1]);
    else if (matches(e, "stepUp")) move(arcs.findIndex((a) => a.ring === arc.ring + 1 && inside(a, arc)));
    else if (matches(e, "stepDown")) {
      if (arc.ring === 1) onZoomOut?.();
      else move(arcs.findIndex((a) => a.ring === arc.ring - 1 && inside(arc, a)));
    } else if (matches(e, "choose") || matches(e, "toggle")) {
      if (arc.id) onPick(arc.id);
      else if (arc.total > 0) onMore(arc);
    } else return;
    e.preventDefault();
  };

  return (
    // As big as the column allows while the legend and the whole circle fit the window's height.
    <div className="mx-auto w-full max-w-[max(20rem,calc(100dvh-21rem))]">
      <div className="mb-2 space-y-1">
        <ul
          aria-label={t("explorer.shareLegend")}
          className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-footnote text-muted"
        >
          <li className="inline-flex items-center gap-1">
            <Swatch className="bg-accent" />
            {t("explorer.legendPhotographed")}
          </li>
          <li className="inline-flex items-center gap-1">
            <Swatch className="bg-line ring-1 ring-control-line dark:bg-surface-muted" />
            {t("explorer.legendNotYet")}
          </li>
        </ul>
        {rarity && <RarityLegend />}
        {arcs.some((a) => a.targetCount > 0) && (
          <p className="flex items-center justify-center gap-1.5 text-footnote text-muted">
            <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
              <TargetMark x={8} y={8} />
            </svg>
            {t("explorer.marks.legend")}
          </p>
        )}
      </div>
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="block h-auto w-full"
          role="group"
          aria-label={t("explorer.circleLabel")}
          onKeyDown={onKeyDown}
          onMouseLeave={() => setHover(null)}
        >
          {arcs.map((arc, i) => {
            const node = arc.id ? index.byId.get(arc.id)!.node : null;
            const share = arc.total > 0 ? arc.collected / arc.total : 0;
            const counts = node && {
              name: label(node),
              collected: formatNumber(node.collected),
              total: formatNumber(node.total),
              count: node.targetCount,
              formatted: formatNumber(node.targetCount),
            };
            const rare = rarity ? rarityOf(arc) : null;
            const more = !node && arc.total > 0;
            const base = counts
              ? t(counts.count > 0 ? "explorer.arcLabelTargets" : "explorer.arcLabel", counts)
              : t(more ? "explorer.moreGroupsAction" : "explorer.moreGroups", { count: arc.more ?? 0 });
            const name = rare && node ? `${base}. ${rarityText(t, node)}` : base;
            const strong = (arc.id && arc.id === selected) || (focused && i === active);
            const r0 = INNER + (arc.ring - 1) * RING;
            // With rarity on, every arc keeps the band's room, so the rings stay aligned.
            const top = r0 + RING - (rarity ? BAND + GAP : 0);
            const markR = top - MARK_INSET;
            const mid = (arc.start + arc.end) / 2;
            const marked = arc.targetCount > 0 && (arc.end - arc.start) * markR >= MARK_ROOM;
            return (
              <g key={arc.id ?? `more-${arc.ring}-${arc.start}`}>
                <path d={arcPath(r0, top, arc.start, arc.end)} className={`pointer-events-none ${EMPTY}`} />
                {/* Your share fills the arc outward from its inner edge, like a bar. */}
                {share > 0 && (
                  <path
                    d={arcPath(r0, r0 + (top - r0) * share, arc.start, arc.end)}
                    className={`pointer-events-none fill-accent ${node ? "" : "opacity-60"}`}
                  />
                )}
                {rare && (
                  <path
                    d={arcPath(r0 + RING - BAND, r0 + RING, arc.start, arc.end)}
                    className={`pointer-events-none ${RARITY_FILL[rare.step]}`}
                  />
                )}
                <path
                  ref={(el) => {
                    refs.current[i] = el;
                  }}
                  d={arcPath(r0, r0 + RING, arc.start, arc.end)}
                  role={node || more ? "button" : "img"}
                  aria-label={name}
                  tabIndex={node || more ? (i === active ? 0 : -1) : undefined}
                  onFocus={() => (setActive(i), setFocused(true))}
                  onBlur={() => setFocused(false)}
                  onMouseEnter={() => setHover(arc)}
                  onClick={() => (arc.id ? onPick(arc.id) : more && onMore(arc))}
                  onContextMenu={(e) => {
                    if (!arc.id) return;
                    e.preventDefault();
                    onMenu(arc.id, { x: e.clientX, y: e.clientY });
                  }}
                  className={`fill-transparent outline-none focus-visible:stroke-ink ${node || more ? "cursor-pointer hover:fill-ink/10" : ""} ${
                    strong ? "stroke-ink" : "stroke-canvas"
                  }`}
                  strokeWidth={strong ? 3 : 1}
                >
                  <title>{name}</title>
                </path>
                {marked && <TargetMark x={C + markR * Math.sin(mid)} y={C - markR * Math.cos(mid)} />}
              </g>
            );
          })}
          {onZoomOut ? (
            <circle
              cx={C}
              cy={C}
              r={INNER - 2}
              role="button"
              tabIndex={0}
              aria-label={t("explorer.zoomOut")}
              onClick={onZoomOut}
              onKeyDown={(e) => {
                if (!matches(e, "choose") && !matches(e, "toggle")) return;
                e.preventDefault();
                e.stopPropagation();
                onZoomOut();
              }}
              className="cursor-pointer fill-surface outline-none hover:fill-surface-muted focus-visible:stroke-accent"
              strokeWidth={3}
            />
          ) : (
            <circle cx={C} cy={C} r={INNER - 2} className="fill-surface" />
          )}
        </svg>
        {/* The middle names what the pointer or focus is on; it never takes clicks from the circle. */}
        <div
          className="pointer-events-none absolute top-1/2 left-1/2 flex w-[30%] -translate-x-1/2 -translate-y-1/2 flex-col items-center text-center"
          aria-live="polite"
        >
          <p className="line-clamp-3 text-footnote font-semibold text-ink wrap-anywhere sm:text-callout">
            {readout
              ? label(readout)
              : shown
                ? t("explorer.moreGroups", { count: shown.more ?? 0 })
                : top
                  ? t("explorer.moreGroups", { count: top.length })
                  : t("explorer.allGroups")}
          </p>
          {(readout || !shown) && (
            <p className="text-caption text-muted tabular-nums sm:text-footnote">
              {t("explorer.speciesOf", {
                collected: formatNumber(totals.collected),
                total: formatNumber(totals.total),
              })}
            </p>
          )}
          {rarity && readout && rarityText(t, readout) && (
            <p className="line-clamp-2 text-caption text-muted sm:text-footnote">{rarityText(t, readout)}</p>
          )}
        </div>
      </div>
    </div>
  );
}
