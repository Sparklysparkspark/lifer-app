import { useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (!weeklyFrequency || weeklyFrequency.every((v) => v === 0)) return null;

  const max = Math.max(...weeklyFrequency);

  return (
    // No caption, to keep the page quiet; the label and the hover name the region, so the data
    // doesn't read as a global pattern.
    <div
      role="img"
      aria-label={
        regionName ? t("species.seasonality.byWeekIn", { region: regionName }) : t("species.seasonality.byWeek")
      }
    >
      <div className="relative">
        {hoverIdx != null && (
          <div
            className="pointer-events-none absolute bottom-full mb-1 -translate-x-1/2 whitespace-nowrap rounded-badge bg-ink px-1.5 py-0.5 text-footnote font-medium text-canvas"
            style={{ left: `${((hoverIdx + 0.5) / 52) * 100}%` }}
          >
            {regionName
              ? t("species.seasonality.weekRecordsIn", {
                  week: String(hoverIdx + 1),
                  count: weeklyFrequency[hoverIdx],
                  region: regionName,
                })
              : t("species.seasonality.weekRecords", { week: String(hoverIdx + 1), count: weeklyFrequency[hoverIdx] })}
          </div>
        )}
        <div className="flex h-8 items-end gap-px" onMouseLeave={() => setHoverIdx(null)}>
          {weeklyFrequency.map((value, i) => (
            <div
              key={i}
              className={`flex-1 rounded-badge transition-colors ${hoverIdx === i ? "bg-accent" : "bg-muted"}`}
              style={{ height: `${max ? Math.max((value / max) * 100, value > 0 ? 4 : 0) : 0}%` }}
              onMouseEnter={() => setHoverIdx(i)}
            />
          ))}
        </div>
        <div className="mt-0.5 flex text-micro text-muted">
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
