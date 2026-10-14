import { useState } from "react";
import { pluralize } from "../lib/pluralize";
import { formatMonthName } from "../lib/format";

// One label per month across 52 weeks: an approximate axis, not exact week-to-month mapping.
const MONTHS = Array.from({ length: 12 }, (_, i) => i);

// Weekly observation bars (52 ISO weeks). Only some regions have weekly data yet.
export default function WeeklyBar({
  weeklyFrequency,
  regionName,
}: {
  weeklyFrequency: number[] | null;
  regionName?: string | null;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (!weeklyFrequency || weeklyFrequency.every((v) => v === 0)) return null;

  const max = Math.max(...weeklyFrequency);

  return (
    // No caption, to keep the page quiet; the label and the hover name the region, so the data
    // doesn't read as a global pattern.
    <div role="img" aria-label={`Observations by week${regionName ? ` in ${regionName}` : ""}`}>
      <div className="relative">
        {hoverIdx != null && (
          <div
            className="pointer-events-none absolute bottom-full mb-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-1.5 py-0.5 text-xs font-medium text-canvas"
            style={{ left: `${((hoverIdx + 0.5) / 52) * 100}%` }}
          >
            Week {hoverIdx + 1}: {pluralize(weeklyFrequency[hoverIdx], "record")}
            {regionName ? ` in ${regionName}` : ""}
          </div>
        )}
        <div className="flex h-8 items-end gap-px" onMouseLeave={() => setHoverIdx(null)}>
          {weeklyFrequency.map((value, i) => (
            <div
              key={i}
              className={`flex-1 rounded-sm transition-colors ${hoverIdx === i ? "bg-accent" : "bg-muted"}`}
              style={{ height: `${max ? Math.max((value / max) * 100, value > 0 ? 4 : 0) : 0}%` }}
              onMouseEnter={() => setHoverIdx(i)}
            />
          ))}
        </div>
        <div className="mt-0.5 flex text-[9px] text-muted">
          {MONTHS.map((i) => (
            <span key={i} className="flex-1 text-center">
              {formatMonthName(i, "short")}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
