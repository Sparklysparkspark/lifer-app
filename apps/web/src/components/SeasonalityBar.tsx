import { formatMonthName } from "../lib/format";

const MONTHS = Array.from({ length: 12 }, (_, i) => i);

// Monthly observation bars (GBIF only facets by month). Region-scoped, so null without a region.
export default function SeasonalityBar({ seasonality }: { seasonality: number[] | null }) {
  if (!seasonality || seasonality.every((v) => v === 0)) return null;

  const max = Math.max(...seasonality);

  return (
    <div role="img" aria-label="Observations by month">
      <div className="flex h-10 items-end gap-1">
        {seasonality.map((value, i) => (
          <div
            key={i}
            className="flex-1 rounded-sm bg-muted"
            style={{ height: `${max ? Math.max((value / max) * 100, value > 0 ? 4 : 0) : 0}%` }}
            title={`${value} records`}
          />
        ))}
      </div>
      <div className="mt-0.5 flex gap-1">
        {MONTHS.map((i) => (
          <span key={i} className="flex-1 text-center text-[9px] text-muted">
            {formatMonthName(i, "narrow")}
          </span>
        ))}
      </div>
    </div>
  );
}
