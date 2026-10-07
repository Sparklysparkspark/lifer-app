export interface ProgressDisplay {
  indeterminate: boolean;
  // Fill width in percent, unrounded, with a 2% floor so a just-started bar is visible.
  widthPct: number;
  // Whole percent for text, from the real value (not the 2% floor).
  percent: number;
}

const MIN_VISIBLE_PCT = 2;

// null, NaN or <= 0 means "no measurable progress yet", which shows as indeterminate rather
// than an empty track that reads as a thin broken line.
export function progressDisplay(value: number | null | undefined): ProgressDisplay {
  if (value == null || !Number.isFinite(value) || value <= 0) return { indeterminate: true, widthPct: 0, percent: 0 };
  const clamped = Math.min(1, value);
  return {
    indeterminate: false,
    widthPct: Math.max(MIN_VISIBLE_PCT, clamped * 100),
    percent: Math.floor(clamped * 100),
  };
}
