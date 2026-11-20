// The region view's soft lock: zooming out stops at the region's framing, and keeping on zooming
// out past it (a further pinch, a few more wheel notches, another "-") lets go, one level up.
// Pure: useRegionCamera feeds it the gestures and acts on what it says.

/** Zoom levels of extra zoom-out that let go, and the pause after which they start over. */
export const OVERSHOOT = { release: 0.6, resetMs: 500 } as const;

export type Overshoot = { amount: number; at: number };
export type OvershootInput =
  /** Zoom-out asked for while held at the floor, in zoom levels. */
  | { kind: "out"; levels: number; at: number }
  /** Zooming in, a pan or Reset view: start over. */
  | { kind: "reset"; at: number };

export type OvershootResult = { state: Overshoot; status: "held" | "building" | "released"; progress: number };

export const NO_OVERSHOOT: Overshoot = { amount: 0, at: 0 };

export function overshootStep(state: Overshoot, input: OvershootInput): OvershootResult {
  if (input.kind === "reset") return { state: { amount: 0, at: input.at }, status: "held", progress: 0 };
  const carried = input.at - state.at > OVERSHOOT.resetMs ? 0 : state.amount;
  const amount = carried + Math.max(0, input.levels);
  if (amount >= OVERSHOOT.release) return { state: NO_OVERSHOOT, status: "released", progress: 1 };
  return {
    state: { amount, at: input.at },
    status: amount > 0 ? "building" : "held",
    progress: amount / OVERSHOOT.release,
  };
}

/** A wheel event's zoom-out in levels, as MapLibre scales them: a trackpad pinch (ctrlKey) or
 *  smooth scroll is fine-grained, a mouse wheel notch about a fifth of a level. */
export function wheelLevels(deltaY: number, ctrlKey: boolean): number {
  return deltaY / (ctrlKey ? 100 : 450);
}

/** A touch pinch's zoom-out in levels, from the distance between the fingers before and after. */
export function pinchLevels(before: number, after: number): number {
  return before > 0 && after > 0 ? Math.log2(before / after) : 0;
}

/** A "-" key press: half a level, so it takes two to let go. */
export const KEY_LEVELS = 0.5;
