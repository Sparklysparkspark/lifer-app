import { pluralize } from "../../lib/pluralize";
import { StatCard } from "./StatsUi";
import { percentOfKeepers, type headlineStats } from "./statsHelpers";
import type { SpeciesRef, StatsResponse } from "./types";

// The top of the page: the "how do I shoot" cards, the server's insight sentences, and the rare
// finds (only shown once you've made one; most photographers never will).
export default function StatsHighlights({
  stats,
  headlines,
}: {
  stats: StatsResponse;
  headlines: ReturnType<typeof headlineStats>;
}) {
  const { topCamera, topFocalLength, busiestHour, bestMonth } = headlines;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {topCamera && (
          <StatCard
            label="Top camera"
            value={topCamera.model}
            sub={`${percentOfKeepers(topCamera.photoCount, stats.totalKeepers)}% of keepers`}
          />
        )}
        {topFocalLength && topFocalLength.count > 0 && (
          <StatCard label="Favorite focal length" value={topFocalLength.label} sub="most common range" />
        )}
        {busiestHour && busiestHour.count > 0 && (
          <StatCard
            label="Peak shooting time"
            value={busiestHour.label}
            sub={`${percentOfKeepers(busiestHour.count, stats.totalKeepers)}% of keepers`}
          />
        )}
        {bestMonth && bestMonth.newLifers > 0 && (
          <StatCard label="Best month" value={bestMonth.label} sub={pluralize(bestMonth.newLifers, "lifer")} />
        )}
      </div>

      {stats.insights.length > 0 && (
        <div className="rounded-xl border border-line bg-surface p-4">
          <ul className="space-y-1.5 text-sm text-ink">
            {stats.insights.map((fact, i) => (
              <li key={i}>{fact}</li>
            ))}
          </ul>
        </div>
      )}

      {(stats.ghostSpecies.length > 0 || stats.lostSpecies.length > 0 || stats.rediscoveredSpecies.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {stats.rediscoveredSpecies.length > 0 && (
            <SpeciesCallout
              species={stats.rediscoveredSpecies}
              title="Rediscovered"
              description="Was Ghost or Lost when you found it, but not anymore, you helped."
              boxClass="border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30 sm:col-span-2"
              titleClass="text-emerald-700 dark:text-emerald-400"
            />
          )}
          {stats.ghostSpecies.length > 0 && (
            <SpeciesCallout
              species={stats.ghostSpecies}
              title="Ghost species"
              description="Rarely documented anywhere, but you found them."
              boxClass="border-violet-200 bg-violet-50 dark:border-violet-900 dark:bg-violet-950/30"
              titleClass="text-violet-700 dark:text-violet-400"
            />
          )}
          {stats.lostSpecies.length > 0 && (
            <SpeciesCallout
              species={stats.lostSpecies}
              title="Lost species"
              description="Not recorded anywhere else in over 25 years."
              boxClass="border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/30"
              titleClass="text-rose-700 dark:text-rose-400"
            />
          )}
        </div>
      )}
    </>
  );
}

function SpeciesCallout({
  species,
  title,
  description,
  boxClass,
  titleClass,
}: {
  species: SpeciesRef[];
  title: string;
  description: string;
  boxClass: string;
  titleClass: string;
}) {
  return (
    <div className={`rounded-xl border p-4 ${boxClass}`}>
      <p className={`text-xs font-medium uppercase tracking-wide ${titleClass}`}>
        {title} ({species.length})
      </p>
      <p className="mt-0.5 text-xs text-muted">{description}</p>
      <ul className="mt-2 space-y-0.5 text-sm text-ink">
        {species.map((s) => (
          <li key={s.speciesId}>{s.commonName ?? s.scientificName}</li>
        ))}
      </ul>
    </div>
  );
}
