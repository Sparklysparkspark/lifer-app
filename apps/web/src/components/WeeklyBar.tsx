import { useState } from "react";
import { pluralize } from "../lib/pluralize";

// One label per month across 52 weeks: an approximate axis, not exact week-to-month mapping.
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Weekly observation bars (52 ISO weeks). Only some regions have weekly data yet.
export default function WeeklyBar({ weeklyFrequency, regionName }: { weeklyFrequency: number[] | null; regionName?: string | null }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (!weeklyFrequency || weeklyFrequency.every((v) => v === 0)) return null;

  const max = Math.max(...weeklyFrequency);

  return (
    <div>
      {/* Names the region so the data doesn't read as a global pattern. */}
      <p className="mb-1 text-[10px] uppercase tracking-wide text-muted">
        Observations by week{regionName ? ` in ${regionName}` : ""}
      </p>
      <div className="relative">
        {hoverIdx != null && (
          <div
            className="pointer-events-none absolute bottom-full mb-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-1.5 py-0.5 text-[10px] font-medium text-canvas"
            style={{ left: `${((hoverIdx + 0.5) / 52) * 100}%` }}
          >
            Week {hoverIdx + 1}: {pluralize(weeklyFrequency[hoverIdx], "record")}
          </div>
        )}
        <div className="flex h-10 items-end gap-px" onMouseLeave={() => setHoverIdx(null)}>
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
          {MONTH_LABELS.map((label) => (
            <span key={label} className="flex-1 text-center">
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
