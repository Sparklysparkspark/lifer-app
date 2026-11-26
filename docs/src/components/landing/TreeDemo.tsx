// A small Tree of life circle for the landing page, drawn like the app's Circle view: three rings
// below the group in the middle, each segment's angle by its species, filled outward by the share
// photographed, thin groups merged into one "N more groups" segment that reaches the outer edge.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { SAMPLE_TREE, TIERS, type Tier, type TreeNode } from "./sampleTree";
import styles from "./landing.module.css";

const SIZE = 600;
const C = SIZE / 2;
const INNER = 96;
const OUTER = C - 4;
const RINGS = 3;
const RING = (OUTER - INNER) / RINGS;
// The thinnest segment drawn on its own, as a length along its ring's outer edge.
const MIN_ARC = 16;
const BAND = 8;
const GAP = 2;
const MS = 400;
const TAU = 2 * Math.PI;
const TIER_LABEL: Record<Tier, string> = {
  common: "Common",
  occasional: "Occasional",
  uncommon: "Uncommon",
  rare: "Rare",
  legendary: "Legendary",
};

/** What the circle shows: a group, or the groups an "N more groups" segment merged. */
interface Focus {
  key: string;
  label: string;
  node: TreeNode;
  /** Set for a "more" view: the merged groups, children of `node`. */
  ids?: TreeNode[];
}
interface Win {
  x0: number;
  x1: number;
  d: number;
}
interface Arc {
  key: string;
  x0: number;
  x1: number;
  depth: number;
  /** Rings the segment covers: 1, or out to the edge for a "more" segment. */
  span: number;
  node?: TreeNode;
  more?: TreeNode[];
  parent: TreeNode;
  total: number;
  collected: number;
  targets: number;
  tiers: Partial<Record<Tier, number>>;
}

const sumOf = (ns: TreeNode[], f: (n: TreeNode) => number) => ns.reduce((k, n) => k + f(n), 0);
const winOf = (f: Focus): Win =>
  f.ids
    ? { x0: f.ids[0].x0, x1: f.ids[f.ids.length - 1].x1, d: f.node.depth }
    : { x0: f.node.x0, x1: f.node.x1, d: f.node.depth };

function arcsFor(f: Focus): Arc[] {
  const w = winOf(f);
  const out: Arc[] = [];
  const place = (ids: TreeNode[], parent: TreeNode, ring: number) => {
    const r = INNER + ring * RING;
    const thin = (n: TreeNode) => ((n.x1 - n.x0) / (w.x1 - w.x0)) * TAU * r < MIN_ARC;
    // Largest first, so the thin ones are a tail; one thin group alone is drawn as it is.
    let keep = ids.findIndex(thin);
    if (keep < 0 || keep >= ids.length - 1) keep = ids.length;
    for (const n of ids.slice(0, keep)) {
      out.push({ key: n.id, x0: n.x0, x1: n.x1, depth: n.depth, span: 1, node: n, parent, ...counts([n]) });
      if (ring < RINGS && n.children.length) place(n.children, n, ring + 1);
    }
    const rest = ids.slice(keep);
    if (rest.length) {
      out.push({
        key: `${parent.id}|more`,
        x0: rest[0].x0,
        x1: rest[rest.length - 1].x1,
        depth: rest[0].depth,
        span: RINGS - ring + 1,
        more: rest,
        parent,
        ...counts(rest),
      });
    }
  };
  place(f.ids ?? f.node.children, f.node, 1);
  return out;
}

function counts(ns: TreeNode[]) {
  const tiers: Partial<Record<Tier, number>> = {};
  for (const n of ns) for (const [t, k] of Object.entries(n.tiers)) tiers[t as Tier] = (tiers[t as Tier] ?? 0) + k;
  return {
    total: sumOf(ns, (n) => n.total),
    collected: sumOf(ns, (n) => n.collected),
    targets: sumOf(ns, (n) => n.targets),
    tiers,
  };
}

/** The mean tier's index, and how many are rare or rarer; null when nothing is rated. */
function rarityOf(tiers: Partial<Record<Tier, number>>) {
  let rated = 0;
  let sum = 0;
  let rarePlus = 0;
  TIERS.forEach((t, i) => {
    const k = tiers[t] ?? 0;
    rated += k;
    sum += i * k;
    if (i >= 3) rarePlus += k;
  });
  return rated ? { step: Math.round(sum / rated), rarePlus, rated } : null;
}

export function rarityText(a: Pick<Arc, "tiers" | "node">): string | null {
  const r = rarityOf(a.tiers);
  if (!r) return null;
  const tier = TIER_LABEL[TIERS[r.step]];
  if (a.node?.rank === "species") return tier;
  return r.rarePlus ? `Mostly ${tier}, ${r.rarePlus} of ${r.rated} rare or rarer` : `Mostly ${tier}`;
}

const nameOf = (a: Arc) => (a.more ? `${a.more.length} more groups` : a.node!.name);
const photographed = (collected: number, total: number) => `${collected} of ${total} species photographed`;

const point = (r: number, a: number) => `${(C + r * Math.sin(a)).toFixed(2)} ${(C - r * Math.cos(a)).toFixed(2)}`;
function arcPath(r0: number, r1: number, start: number, end: number): string {
  const span = Math.min(end - start, TAU - 1e-4);
  if (span <= 0 || r1 <= r0) return "";
  const a1 = start + span;
  const large = span > Math.PI ? 1 : 0;
  return `M${point(r1, start)}A${r1} ${r1} 0 ${large} 1 ${point(r1, a1)}L${point(r0, a1)}A${r0} ${r0} 0 ${large} 0 ${point(r0, start)}Z`;
}

interface Geo {
  start: number;
  end: number;
  r0: number;
  r1: number;
}
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
function project(a: Arc, w: Win): Geo {
  const ang = (x: number) => clamp(((x - w.x0) / (w.x1 - w.x0)) * TAU, 0, TAU);
  const ring = a.depth - w.d;
  return {
    start: ang(a.x0),
    end: ang(a.x1),
    r0: clamp(INNER + (ring - 1) * RING, 0, OUTER),
    r1: clamp(INNER + (ring - 1 + a.span) * RING, 0, OUTER),
  };
}
// CSS ease-out, close enough to the app's 400 ms ease for a zoom.
const ease = (t: number) => 1 - (1 - t) ** 3;
const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

const ROOT: Focus = { key: SAMPLE_TREE.id, label: SAMPLE_TREE.name, node: SAMPLE_TREE };

export default function TreeDemo() {
  const [trail, setTrail] = useState<Focus[]>([ROOT]);
  const focus = trail[trail.length - 1];
  const arcs = useMemo(() => arcsFor(focus), [focus]);
  const [rarity, setRarity] = useState(true);
  const [hover, setHover] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [kbd, setKbd] = useState(false);
  const refs = useRef<(SVGPathElement | null)[]>([]);

  // The zoom: the view window glides from the old group to the new one; segments only on one side fade.
  const [anim, setAnim] = useState<{ from: Arc[]; w0: Win; w1: Win; t: number } | null>(null);
  const shown = useRef<{ arcs: Arc[]; w: Win }>({ arcs, w: winOf(focus) });
  useEffect(() => {
    const prev = shown.current;
    const w1 = winOf(focus);
    shown.current = { arcs, w: w1 };
    if (prev.arcs === arcs || reduced()) return setAnim(null);
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / MS);
      setAnim(t < 1 ? { from: prev.arcs, w0: prev.w, w1, t } : null);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [arcs, focus]);

  const zoomTo = (a: Arc) => {
    if (a.more)
      setTrail([...trail, { key: a.key, label: `${a.more.length} more groups`, node: a.parent, ids: a.more }]);
    else if (a.node && a.node.rank !== "species")
      setTrail([...trail, { key: a.key, label: a.node.name, node: a.node }]);
    else return;
    setActive(0);
    setHover(null);
  };
  const zoomOut = (to = trail.length - 2) => {
    if (to < 0) return;
    setTrail(trail.slice(0, to + 1));
    setActive(0);
    setHover(null);
  };

  const onKey = (e: KeyboardEvent) => {
    const n = arcs.length;
    const move = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    let next = active;
    if (move) next = (active + move + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else if ((e.key === "Enter" || e.key === " ") && (e.target as Element).tagName === "path") {
      e.preventDefault();
      setKbd(true);
      zoomTo(arcs[active]);
      return;
    } else if (e.key === "Escape" && trail.length > 1) {
      e.preventDefault();
      zoomOut();
      return;
    } else return;
    e.preventDefault();
    setKbd(true);
    setActive(next);
    refs.current[next]?.focus();
  };
  // After a zoom, keep keyboard focus in the circle.
  useEffect(() => {
    if (kbd && refs.current[0] && document.activeElement?.tagName !== "BUTTON") refs.current[0].focus();
  }, [trail]); // eslint-disable-line react-hooks/exhaustive-deps

  const t = anim ? ease(anim.t) : 1;
  const w: Win = anim
    ? {
        x0: anim.w0.x0 + (anim.w1.x0 - anim.w0.x0) * t,
        x1: anim.w0.x1 + (anim.w1.x1 - anim.w0.x1) * t,
        d: anim.w0.d + (anim.w1.d - anim.w0.d) * t,
      }
    : winOf(focus);
  const now = new Set(arcs.map((a) => a.key));
  const leaving = anim ? anim.from.filter((a) => !now.has(a.key)) : [];
  const before = new Set(anim?.from.map((a) => a.key));

  const readout = arcs.find((a) => a.key === hover) ?? (kbd ? arcs[active] : undefined);
  const summary = readout ?? { ...counts(focus.ids ?? [focus.node]), node: focus.ids ? undefined : focus.node };
  const title = readout ? nameOf(readout) : focus.label;

  const draw = (a: Arc, opacity: number, i: number | null) => {
    const g = project(a, w);
    const rare = rarity ? rarityOf(a.tiers) : null;
    const top = Math.max(g.r0, g.r1 - (rare ? BAND + GAP : 0));
    const share = a.total ? a.collected / a.total : 0;
    const mid = (g.start + g.end) / 2;
    const mr = top - 10;
    const label = `${nameOf(a)}, ${photographed(a.collected, a.total)}${rarity && rarityText(a) ? `, ${rarityText(a)}` : ""}${a.targets ? `, ${a.targets} ${a.targets === 1 ? "target" : "targets"}` : ""}`;
    const zoomable = !!a.more || a.node?.rank !== "species";
    return (
      <g key={a.key} opacity={opacity} data-key={a.key}>
        <path d={arcPath(g.r0, top, g.start, g.end)} className={styles.arcEmpty} />
        {share > 0 && (
          <path d={arcPath(g.r0, g.r0 + (top - g.r0) * share, g.start, g.end)} className={styles.arcShare} />
        )}
        {rare && (
          <path
            d={arcPath(g.r1 - BAND, g.r1, g.start, g.end)}
            style={{ fill: `var(--color-rarity-${TIERS[rare.step]})` }}
          />
        )}
        {a.targets > 0 && (g.end - g.start) * mr >= 18 && mr - g.r0 > 10 && (
          <g transform={`translate(${C + mr * Math.sin(mid)} ${C - mr * Math.cos(mid)})`} className={styles.target}>
            <circle r={6} />
            <circle r={2} />
          </g>
        )}
        {i != null && (
          <path
            ref={(el) => {
              refs.current[i] = el;
            }}
            d={arcPath(g.r0, g.r1, g.start, g.end)}
            className={styles.arcHit}
            role="button"
            aria-label={zoomable ? `${label}. Zoom in` : label}
            tabIndex={i === active ? 0 : -1}
            data-zoom={zoomable || undefined}
            onClick={() => zoomTo(a)}
            onMouseEnter={() => setHover(a.key)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => {
              setActive(i);
            }}
          />
        )}
      </g>
    );
  };

  const outlined = arcs.find((a) => a.key === hover) ?? (kbd ? arcs[active] : undefined);
  const og = outlined && project(outlined, w);

  return (
    <div className={styles.tree}>
      <div className={styles.treeBar}>
        <nav aria-label="Circle path" className={styles.crumbs}>
          {trail.map((f, i) =>
            i < trail.length - 1 ? (
              <span key={f.key}>
                <button type="button" className={styles.crumb} onClick={() => zoomOut(i)}>
                  {f.label}
                </button>
                <span aria-hidden="true"> / </span>
              </span>
            ) : (
              <span key={f.key} className={styles.crumbHere} aria-current="location">
                {f.label}
              </span>
            ),
          )}
        </nav>
        <button type="button" className={styles.toggle} aria-pressed={rarity} onClick={() => setRarity(!rarity)}>
          Show rarity
        </button>
      </div>
      <ul className={styles.legend} aria-label="Key">
        <li>
          <i className={styles.swShare} /> Photographed
        </li>
        <li>
          <i className={styles.swEmpty} /> Not yet
        </li>
        <li>
          <svg viewBox="-8 -8 16 16" className={styles.target} aria-hidden="true">
            <circle r={6} />
            <circle r={2} />
          </svg>
          Holds a target
        </li>
        {rarity && (
          <li className={styles.rarityKey}>
            {TIERS.map((tier) => (
              <i key={tier} style={{ background: `var(--color-rarity-${tier})` }} title={TIER_LABEL[tier]} />
            ))}
            Common to Legendary
          </li>
        )}
      </ul>
      <div className={styles.treeCircle}>
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          role="group"
          aria-label="Tree of life, sample data. Arrow keys move between segments, Enter zooms in, Escape zooms out."
          onKeyDown={onKey}
        >
          {leaving.map((a) => draw(a, 1 - t, null))}
          {arcs.map((a, i) => draw(a, anim && !before.has(a.key) ? t : 1, i))}
          {og && !anim && (
            <path
              d={arcPath(og.r0, og.r1, og.start, og.end)}
              className={kbd && outlined === arcs[active] ? styles.outlineFocus : styles.outlineHover}
            />
          )}
          <circle
            cx={C}
            cy={C}
            r={INNER - 2}
            className={trail.length > 1 ? styles.centreBack : styles.centre}
            role={trail.length > 1 ? "button" : undefined}
            aria-label={trail.length > 1 ? "Zoom out" : undefined}
            tabIndex={trail.length > 1 ? 0 : undefined}
            onClick={() => zoomOut()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                zoomOut();
              }
            }}
          />
          <text x={C} y={C - 6} className={styles.centreName}>
            {focus.label.length > 16 ? `${focus.label.slice(0, 15)}...` : focus.label}
          </text>
          <text x={C} y={C + 18} className={styles.centreSub}>
            {trail.length > 1 ? "Back" : `${SAMPLE_TREE.collected} of ${SAMPLE_TREE.total}`}
          </text>
        </svg>
      </div>
      <div className={styles.readout} aria-live="polite">
        <strong>{title}</strong>
        <span>{photographed(summary.collected, summary.total)}</span>
        {rarity && rarityText(summary) && <span>{rarityText(summary)}</span>}
      </div>
    </div>
  );
}
