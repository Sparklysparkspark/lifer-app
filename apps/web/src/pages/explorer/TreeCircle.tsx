// The Tree of life as a circle (sunburst): the focused group in the middle, three rings of the
// groups inside it, each arc sized by its catalogue species and filled outward by your share.
// Clicking a group zooms into it; the middle steps back out. An "N more groups" arc, standing in
// for groups too thin to draw, zooms into just those groups, laid out across the whole circle. Arrow keys move between arcs. A small
// target marks the arcs holding species on your targets; right-click opens the marks menu. With
// rarity on, a thin band along each arc's outer edge shows its species' average tier, apart from
// the green of your share. A change of view morphs the arcs (see arcMotion.ts).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../../lib/format";
import { matches } from "../../lib/keymap";
import {
  ease,
  type Geo,
  lerpGeo,
  MOTION_MS,
  moreKey,
  moves,
  ROOT,
  transition,
  type Tween,
  type View,
} from "./arcMotion";
import { previewAfterDwell, previewNow } from "./previewStore";
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

/** Whether focus came from the keyboard; engines without :focus-visible count every focus. */
function focusVisible(el: Element) {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}
type OutlineKind = "hover" | "selected" | "focus";
/** A clean two-tone ring around one arc: ink on a light halo reads on green, cream and the rarity
 *  band alike. Hover is a lighter ring; keyboard focus adds the house focus colour outside it. */
function Outline({ d, kind }: { d: string; kind: OutlineKind }) {
  return (
    <g
      data-outline={kind}
      strokeLinejoin="round"
      className={`pointer-events-none fill-none motion-safe:transition-opacity motion-safe:duration-[400ms] motion-safe:starting:opacity-0 ${
        kind === "hover" ? "" : "drop-shadow-sm"
      }`}
    >
      {kind === "focus" && <path d={d} className="stroke-accent" strokeWidth={8} />}
      <path d={d} className="stroke-surface" strokeWidth={4} />
      <path d={d} className={kind === "hover" ? "stroke-ink/50" : "stroke-ink"} strokeWidth={2} />
    </g>
  );
}

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const arcKey = (arc: Arc) => arc.id ?? moreKey(arc.parent ?? null, arc.more ?? 0);
const CENTRE = { start: 0, end: 2 * Math.PI, r0: 0, r1: INNER, opacity: 1 };
const geoOf = (arc: Arc): Geo => {
  const r0 = INNER + (arc.ring - 1) * RING;
  return {
    start: arc.start,
    end: arc.end,
    r0,
    r1: r0 + RING,
    opacity: 1,
    share: arc.total ? arc.collected / arc.total : 0,
  };
};
type Parts = { g: SVGGElement; empty: Element; share: Element | null; band: Element | null; mark: Element | null };
/** Draws one in-between frame of an arc, straight to the DOM: thousands of arcs, 60 times a second. */
function paint(el: Parts, g: Geo, rarity: boolean) {
  el.g.setAttribute("opacity", g.opacity.toFixed(3));
  const top = Math.max(g.r0, g.r1 - (rarity ? BAND + GAP : 0));
  el.empty.setAttribute("d", arcPath(g.r0, top, g.start, g.end));
  el.share?.setAttribute("d", arcPath(g.r0, g.r0 + (top - g.r0) * g.share, g.start, g.end));
  el.band?.setAttribute("d", arcPath(Math.max(g.r0, g.r1 - BAND), g.r1, g.start, g.end));
  if (el.mark) {
    const r = top - MARK_INSET;
    const mid = (g.start + g.end) / 2;
    el.mark.setAttribute("transform", `translate(${C + r * Math.sin(mid)} ${C - r * Math.cos(mid)})`);
    el.mark.setAttribute("display", (g.end - g.start) * r >= MARK_ROOM && top - g.r0 > MARK_INSET ? "inline" : "none");
  }
}

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
  const [keyboard, setKeyboard] = useState(false);
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

  // The morph: a throwaway layer of plain arcs tweens from what is drawn to the new view, while
  // the real arcs, already in their final place, stay hidden but take clicks and focus. A change
  // mid-morph starts again from the frame on screen.
  const target = useMemo<View>(
    () => ({
      centre: top ? moreKey(center, top.length) : (center ?? ROOT),
      geo: new Map(arcs.map((a) => [arcKey(a), geoOf(a)])),
    }),
    [arcs, center, top],
  );
  useEffect(() => () => previewNow(null), []);
  const drawn = useRef<View | null>(null);
  const known = useRef(new Map<string, Arc>());
  const parts = useRef(new Map<string, SVGGElement | null>());
  const [anim, setAnim] = useState<{ tweens: Tween[]; to: View; arcs: Map<string, Arc> } | null>(null);
  useLayoutEffect(() => {
    const from = drawn.current;
    const tweens = from && !reducedMotion() ? transition(from, target, CENTRE) : [];
    const keep = new Map(arcs.map((a) => [arcKey(a), a]));
    for (const { key } of tweens) if (!keep.has(key)) keep.set(key, known.current.get(key)!);
    known.current = keep;
    drawn.current = target;
    setAnim(moves(tweens) ? { tweens, to: target, arcs: keep } : null);
  }, [target, arcs]);
  useLayoutEffect(() => {
    if (!anim) return;
    const els = anim.tweens.map(({ key }) => {
      const g = parts.current.get(key)!;
      const q = (p: string) => g.querySelector(`[data-part="${p}"]`);
      return { g, empty: q("empty")!, share: q("share"), band: q("band"), mark: q("mark") };
    });
    const live = new Map<string, Geo>();
    const t0 = performance.now();
    let raf = 0;
    // performance.now, not the frame's timestamp, which can run on another clock in some engines.
    const frame = () => {
      const e = ease((performance.now() - t0) / MOTION_MS);
      anim.tweens.forEach((tw, i) => {
        const g = lerpGeo(tw.from, tw.to, e);
        live.set(tw.key, g);
        paint(els[i], g, rarity);
      });
      drawn.current = e < 1 ? { centre: anim.to.centre, geo: live } : anim.to;
      if (e < 1) raf = requestAnimationFrame(frame);
      else setAnim(null);
    };
    frame();
    return () => cancelAnimationFrame(raf);
    // `rarity` is read per frame; toggling it mid-morph needs no restart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anim]);

  const centerNode = center ? index.byId.get(center)?.node : null;
  const roots = (top ?? index.roots).map((id) => index.byId.get(id)!.node);
  // A hovered arc from before a region change can name a group the new tree lacks.
  const hovered = hover && (!hover.id || index.byId.has(hover.id)) ? hover : null;
  const shown = hovered ?? (focused ? arcs[active] : null);
  // One ring per arc, the strongest winning: focus over selected over hover.
  const ringed: [Arc | undefined, OutlineKind][] = [
    [
      hovered && (hovered.id || hovered.total > 0) ? arcs.find((a) => arcKey(a) === arcKey(hovered)) : undefined,
      "hover",
    ],
    [selected ? arcs.find((a) => a.id === selected) : undefined, "selected"],
    [focused && keyboard ? arcs[active] : undefined, "focus"],
  ];
  const outlines = ringed.filter(([a], i) => a && !ringed.slice(i + 1).some(([b]) => b === a)) as [Arc, OutlineKind][];
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

  // Memoised, so a hover, a ring or the morph starting does not rebuild thousands of arcs.
  const arcList = useMemo(
    () =>
      arcs.map((arc, i) => {
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
              onFocus={(e) => {
                setActive(i);
                setFocused(true);
                setKeyboard(focusVisible(e.currentTarget));
                previewNow(arc.id);
              }}
              onBlur={() => (setFocused(false), previewNow(null))}
              onMouseEnter={() => setHover(arc)}
              // The pane previews what the pointer rests on; off every arc, it goes back to the selection.
              onPointerEnter={(e) => previewAfterDwell(arc.id, e.pointerType)}
              onPointerLeave={(e) => previewAfterDwell(null, e.pointerType)}
              onClick={() => {
                previewNow(null);
                if (arc.id) onPick(arc.id);
                else if (more) onMore(arc);
              }}
              onContextMenu={(e) => {
                if (!arc.id) return;
                e.preventDefault();
                onMenu(arc.id, { x: e.clientX, y: e.clientY });
              }}
              // design-token: the focus ring is the Outline drawn over every arc, so no neighbour clips it.
              className={`fill-transparent stroke-canvas outline-none ${node || more ? "cursor-pointer hover:fill-ink/10" : ""}`}
              strokeWidth={1}
            >
              <title>{name}</title>
            </path>
            {marked && <TargetMark x={C + markR * Math.sin(mid)} y={C - markR * Math.cos(mid)} />}
          </g>
        );
      }),
    [arcs, index, label, rarity, t, active, onPick, onMore, onMenu],
  );

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
          onMouseLeave={() => (setHover(null), previewNow(null))}
        >
          <g data-arcs className={anim ? "opacity-0" : undefined}>
            {arcList}
          </g>
          {/* Drawn last, so no neighbour clips them; hidden while the arcs morph. */}
          {!anim &&
            outlines.map(([arc, kind]) => (
              <Outline
                key={`${kind}-${arcKey(arc)}`}
                d={arcPath(INNER + (arc.ring - 1) * RING, INNER + arc.ring * RING, arc.start, arc.end)}
                kind={kind}
              />
            ))}
          {anim && (
            <g data-arc-motion aria-hidden="true" className="pointer-events-none">
              {anim.tweens.map(({ key, from, to }) => {
                const arc = anim.arcs.get(key)!;
                const rare = rarity ? rarityOf(arc) : null;
                return (
                  <g key={key} ref={(el) => void parts.current.set(key, el)}>
                    <path data-part="empty" className={`${EMPTY} stroke-canvas`} strokeWidth={1} />
                    {(from.share > 0 || to.share > 0) && (
                      <path data-part="share" className={`fill-accent ${arc.id ? "" : "opacity-60"}`} />
                    )}
                    {rare && <path data-part="band" className={RARITY_FILL[rare.step]} />}
                    {arc.targetCount > 0 && (
                      <g data-part="mark">
                        <TargetMark x={0} y={0} />
                      </g>
                    )}
                  </g>
                );
              })}
            </g>
          )}
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
          {/* A new view fades its name in, keyed inside the live region so it is read once. */}
          <div
            key={viewKey}
            className="flex flex-col items-center motion-safe:transition-opacity motion-safe:duration-[400ms] motion-safe:starting:opacity-0"
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
    </div>
  );
}
