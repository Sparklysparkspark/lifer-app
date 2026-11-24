// The Tree of life as a circle (sunburst): the focused group in the middle, three rings of the
// groups inside it, each arc sized by its catalogue species and filled outward by your share.
// Clicking a group zooms into it; the middle steps back out. Arrow keys move between arcs.
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../../lib/format";
import { matches } from "../../lib/keymap";
import { circleArcs, type Arc, type TreeIndex, type TreeNode } from "./treeModel";

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
const inside = (a: Arc, b: Arc) => a.start >= b.start - 1e-9 && a.end <= b.end + 1e-9;

export default function TreeCircle({
  index,
  center,
  genus,
  selected,
  label,
  onPick,
  onZoomOut,
}: {
  index: TreeIndex;
  center: string | null;
  genus: boolean;
  selected: string | null;
  label: (node: TreeNode) => string;
  /** An arc was clicked or chosen: select it, and zoom into it when it is a group. */
  onPick: (id: string) => void;
  onZoomOut: (() => void) | null;
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
    <div className="relative mx-auto w-full max-w-2xl">
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
          const name = node
            ? t("explorer.arcLabel", {
                name: label(node),
                collected: formatNumber(node.collected),
                total: formatNumber(node.total),
              })
            : t("explorer.moreGroups", { count: arc.more ?? 0 });
          const strong = (arc.id && arc.id === selected) || (focused && i === active);
          const r0 = INNER + (arc.ring - 1) * RING;
          return (
            <g key={arc.id ?? `more-${arc.ring}-${arc.start}`}>
              <path d={arcPath(r0, r0 + RING, arc.start, arc.end)} className="pointer-events-none fill-line" />
              {/* Your share fills the arc outward from its inner edge, like a bar. */}
              {share > 0 && (
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
                className={`fill-transparent outline-none focus-visible:stroke-ink ${node ? "cursor-pointer hover:fill-ink/10" : ""} ${
                  strong ? "stroke-ink" : "stroke-canvas"
                }`}
                strokeWidth={strong ? 3 : 1}
              >
                <title>{name}</title>
              </path>
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
            {t("explorer.speciesOf", { collected: formatNumber(totals.collected), total: formatNumber(totals.total) })}
          </p>
        )}
      </div>
    </div>
  );
}
