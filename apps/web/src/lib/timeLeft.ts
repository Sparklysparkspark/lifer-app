import type { TFunction } from "i18next";

// Time left, the Finder way: nothing promised until the rate is measured, then an estimate from
// that rate that counts down smoothly, never up, and goes back to measuring when the rate breaks.

/** How much recent progress the rate is measured over. */
export const WINDOW_MS = 10_000;
/** Measured for at least this long, and at least this far in, before any estimate shows. */
export const MIN_MEASURE_MS = 2_000;
export const MIN_FRACTION = 0.02;
/** How far an estimate may rise above its own countdown in one update. */
export const MAX_RISE_S = 3;
/** Under this, no time is shown: it would be gone before it was read. */
export const HIDE_UNDER_S = 5;

export interface TimeLeftState {
  samples: Array<{ at: number; done: number }>;
  total: number;
  /** The last estimate in seconds, and when it was made; null while measuring. */
  estimate: number | null;
  estimateAt: number;
  /** The last label's seconds (0 once under HIDE_UNDER_S), so the label never goes up. */
  label: number | null;
}

/** "measuring": show "Loading…". "almost": show no time. */
export type TimeLeft = { kind: "measuring" } | { kind: "almost" } | { kind: "left"; seconds: number };

export const initialTimeLeft = (): TimeLeftState => ({
  samples: [],
  total: 0,
  estimate: null,
  estimateAt: 0,
  label: null,
});

/** Seconds rounded the way people say them: 5 s steps under a minute, then minutes, then hours. */
export function friendlySeconds(s: number): number {
  if (s < HIDE_UNDER_S) return 0;
  if (s < 55) return Math.max(5, Math.round(s / 5) * 5);
  if (s < 90) return 60;
  if (s < 3600) return Math.round(s / 60) * 60;
  return Math.round(s / 3600) * 3600;
}

/** One progress reading in, the next state and what to show out. Pure: `now` is passed in. */
export function nextTimeLeft(
  prev: TimeLeftState,
  now: number,
  done: number,
  total: number,
): { state: TimeLeftState; value: TimeLeft } {
  const measuring = (state: TimeLeftState) => ({ state, value: { kind: "measuring" } as TimeLeft });
  if (!(total > 0) || !Number.isFinite(done)) return measuring(initialTimeLeft());
  const last = prev.samples.at(-1);
  // Gone backwards or a different whole: a new run, measured afresh.
  const fresh = total !== prev.total || (last != null && done < last.done);
  const samples = [...(fresh ? [] : prev.samples), { at: now, done }].filter((s) => now - s.at <= WINDOW_MS);
  const base: TimeLeftState = fresh ? { ...initialTimeLeft(), total, samples } : { ...prev, samples };

  const first = samples[0];
  const span = now - first.at;
  if (span < MIN_MEASURE_MS || done / total < MIN_FRACTION) return measuring({ ...base, estimate: null, label: null });
  const rate = (done - first.done) / span; // units per ms
  if (!(rate > 0)) return measuring({ ...base, estimate: null, label: null });
  const raw = (total - done) / rate / 1000;

  let estimate = raw;
  if (base.estimate != null) {
    const countdown = Math.max(0, base.estimate - (now - base.estimateAt) / 1000);
    // Far behind its own countdown: the rate changed, so measure again rather than promise.
    if (raw > countdown + Math.max(10, countdown * 0.5))
      return measuring({ ...base, samples: samples.slice(-1), estimate: null, label: null });
    // Eased toward the new reading, and never more than a few seconds up.
    estimate = Math.min(countdown + 0.3 * (raw - countdown), countdown + MAX_RISE_S);
  }
  const friendly = friendlySeconds(estimate);
  const label = base.label == null ? friendly : Math.min(friendly, base.label);
  const state = { ...base, estimate, estimateAt: now, label };
  return { state, value: label === 0 ? { kind: "almost" } : { kind: "left", seconds: label } };
}

/** The words for a TimeLeft, or null when nothing should show. */
export function timeLeftLabel(value: TimeLeft, t: TFunction, measuringText = true): string | null {
  if (value.kind === "almost") return null;
  if (value.kind === "measuring") return measuringText ? t("timeLeft.measuring") : null;
  const s = value.seconds;
  if (s < 60) return t("timeLeft.seconds", { count: s });
  if (s < 3600) return t("timeLeft.minutes", { count: Math.round(s / 60) });
  return t("timeLeft.hours", { count: Math.round(s / 3600) });
}
