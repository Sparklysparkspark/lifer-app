const MONTH_LABELS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

// eBird-style observation bar — 12 monthly bars, not 52 weekly ones. GBIF's occurrence API
// only facets by month (verified by hand), so this is honestly monthly resolution rather
// than fabricating finer-grained data. Region-scoped: the same species has different
// seasonality in different regions, hence the null fallback when no region context is set.
export default function SeasonalityBar({ seasonality }: { seasonality: number[] | null }) {
  if (!seasonality || seasonality.every((v) => v === 0)) return null;

  const max = Math.max(...seasonality);

  return (
    <div>
      <p className="mb-1 text-[10px] uppercase tracking-wide text-stone-400">Observations by month</p>
      <div className="flex h-10 items-end gap-1">
        {seasonality.map((value, i) => (
          <div
            key={i}
            className="flex-1 rounded-sm bg-stone-400"
            style={{ height: `${max ? Math.max((value / max) * 100, value > 0 ? 4 : 0) : 0}%` }}
            title={`${value} records`}
          />
        ))}
      </div>
      <div className="mt-0.5 flex gap-1">
        {MONTH_LABELS.map((label, i) => (
          <span key={i} className="flex-1 text-center text-[9px] text-stone-400">
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
