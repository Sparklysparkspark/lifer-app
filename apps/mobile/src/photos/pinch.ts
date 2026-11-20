// Pinch steps for the Gallery grid, as Apple Photos does them: a clear change in scale commits one step,
// a long pinch commits several, and each commit restarts the baseline so the grid cannot flicker between steps.
export const COLUMN_STEPS = [1, 3, 5, 7, 9, 12, 16] as const;
export type Columns = (typeof COLUMN_STEPS)[number];

/** Past this many columns tiles are too small for badges or a touch target of their own. */
export const DENSE_FROM = 12;

/** Scale change that commits a step: pinching out (bigger tiles) at 1.3, pinching in (more columns) at 0.7. */
export const PINCH_OUT = 1.3;
export const PINCH_IN = 0.7;
/** A pause after each step within one gesture, so a quick pinch cannot race through the ladder. */
export const PINCH_SETTLE_MS = 150;

/** Steps committed by a gesture at `scale` since `baseline` (positive: pinch out, bigger tiles), and the new baseline. */
export function pinchSteps(scale: number, baseline: number): { steps: number; baseline: number } {
  const r = scale / baseline;
  const turns = r >= 1 ? Math.trunc(Math.log(r) / Math.log(PINCH_OUT)) : -Math.trunc(Math.log(r) / Math.log(PINCH_IN));
  if (!turns) return { steps: 0, baseline };
  return { steps: turns, baseline: baseline * (turns > 0 ? PINCH_OUT ** turns : PINCH_IN ** -turns) };
}

/** One gesture's stepping: `pinchSteps` with a settle pause after each commit (updates in the pause wait, nothing is lost). */
export function pinchGate(now: () => number = Date.now): { begin(): void; update(scale: number): number } {
  let baseline = 1;
  let lastAt = -Infinity;
  return {
    begin() {
      baseline = 1;
      lastAt = -Infinity;
    },
    update(scale) {
      if (now() - lastAt < PINCH_SETTLE_MS) return 0;
      const out = pinchSteps(scale, baseline);
      if (!out.steps) return 0;
      baseline = out.baseline;
      lastAt = now();
      return out.steps;
    },
  };
}

/** The column count `steps` steps away (positive: fewer columns), kept inside the ladder. A count off the ladder snaps to the nearest. */
export function stepColumns(columns: number, steps: number): Columns {
  const nearest = COLUMN_STEPS.reduce(
    (best, c, i) => (Math.abs(c - columns) < Math.abs(COLUMN_STEPS[best] - columns) ? i : best),
    0,
  );
  return COLUMN_STEPS[Math.max(0, Math.min(COLUMN_STEPS.length - 1, nearest - steps))];
}
