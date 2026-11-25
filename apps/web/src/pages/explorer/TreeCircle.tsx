// The Tree of life as a circle (sunburst): the focused group in the middle, three rings of the
// groups inside it, each arc sized by its catalogue species and filled outward by your share.
// Clicking a group zooms into it; the middle steps back out. Arrow keys move between arcs. A small
// target marks the arcs holding species on your targets; right-click opens the marks menu. With
// rarity on, each arc is shaded by its species' average tier instead of your share.
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../../lib/format";
import { matches } from "../../lib/keymap";
import { RarityLegend } from "./RarityChip";
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
  onZoomOut: (() => void) | null;
  /** Right-click on a group or species: its marks menu at the pointer. */
  onMenu: (id: string, point: { x: number; y: number }) => void;
  /** Shade arcs by rarity rather than by your share. */
  rarity: boolean;
}) {
  const { t } = useTranslation();
  const arcs = useMemo(() => circleArcs(index, center, { rings: RINGS, genus }), [index, center, genus]);
  const [hover, setHover] = useState<Arc | null>(null);
  const [activeAt, setActive] = useState(0);
  // A zoom or a View change gives new arcs; the roving focus then starts again at the first.
  const active = activeAt < arcs.length ? activeAt : 0;
  const [focused, setFocused] = useState(false);
  const refs = useRef<(SVGPathElement | null)[]>([]);

  const centerNode = center ? index.byId.get(center)?.node : null;
  const roots = index.roots.map((id) => index.byId.get(id)!.node);
  const shown = hover ?? (focused ? arcs[active] : null);
  const shownNode = shown?.id ? index.byId.get(shown.id)!.node : null;
  const readout = shown && !shown.id ? null : (shownNode ?? centerNode);
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
    } else return;
    e.preventDefault();
  };

  return (
    // As big as the column allows while the whole circle fits the window's height.
    <div className="mx-auto w-full max-w-[max(20rem,calc(100dvh-17rem))]">
      <div className="relative">
        <svg
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
            const rare = rarity && node ? rarityOf(node) : null;
            const base = counts
              ? t(counts.count > 0 ? "explorer.arcLabelTargets" : "explorer.arcLabel", counts)
              : t("explorer.moreGroups", { count: arc.more ?? 0 });
            const name = rare ? `${base}. ${rarityText(t, node!)}` : base;
            const strong = (arc.id && arc.id === selected) || (focused && i === active);
            const r0 = INNER + (arc.ring - 1) * RING;
            const markR = r0 + RING - MARK_INSET;
            const mid = (arc.start + arc.end) / 2;
            const marked = arc.targetCount > 0 && (arc.end - arc.start) * markR >= MARK_ROOM;
            return (
              <g key={arc.id ?? `more-${arc.ring}-${arc.start}`}>
                <path
                  d={arcPath(r0, r0 + RING, arc.start, arc.end)}
                  className={`pointer-events-none ${rare ? RARITY_FILL[rare.step] : "fill-line"}`}
                />
                {/* Your share fills the arc outward from its inner edge, like a bar. */}
                {!rarity && share > 0 && (
                  <path
                    d={arcPath(r0, r0 + RING * share, arc.start, arc.end)}
                    className={`pointer-events-none fill-accent ${node ? "" : "opacity-60"}`}
                  />
                )}
                <path
                  ref={(el) => {
                    refs.current[i] = el;
                  }}
                  d={arcPath(r0, r0 + RING, arc.start, arc.end)}
                  role={node ? "button" : "img"}
                  aria-label={name}
                  tabIndex={node ? (i === active ? 0 : -1) : undefined}
                  onFocus={() => (setActive(i), setFocused(true))}
                  onBlur={() => setFocused(false)}
                  onMouseEnter={() => setHover(arc)}
                  onClick={() => arc.id && onPick(arc.id)}
                  onContextMenu={(e) => {
                    if (!arc.id) return;
                    e.preventDefault();
                    onMenu(arc.id, { x: e.clientX, y: e.clientY });
                  }}
                  className={`fill-transparent outline-none focus-visible:stroke-ink ${node ? "cursor-pointer hover:fill-ink/10" : ""} ${
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
      <div className="mt-2 space-y-1">
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
    </div>
  );
}
