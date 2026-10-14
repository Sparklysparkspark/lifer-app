import { SpeciesLink } from "./CollectionIntelligence";
import { pluralize } from "../../lib/pluralize";
import { StatCard } from "./StatsUi";
import { percentOfKeepers, type headlineStats } from "./statsHelpers";
import type { SpeciesRef, StatsResponse } from "./types";
import { useSpeciesName } from "../../lib/speciesName";
import { PANEL } from "../../lib/layout";

// The top of the page: the "how do I shoot" cards and the rare finds (only shown once you've made one; most photographers never will).
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
      <div className="grid grid-cols-2 gap-item sm:grid-cols-4">
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

      {(stats.ghostSpecies.length > 0 || stats.lostSpecies.length > 0 || stats.rediscoveredSpecies.length > 0) && (
        <div className="grid gap-item sm:grid-cols-2">
          {stats.rediscoveredSpecies.length > 0 && (
            <SpeciesCallout
              species={stats.rediscoveredSpecies}
              title="Rediscovered"
              description="Was Ghost or Lost when you photographed it. Your record helped change that."
              titleClass="text-emerald-700 dark:text-emerald-400"
              wide
            />
          )}
          {stats.ghostSpecies.length > 0 && (
            <SpeciesCallout
              species={stats.ghostSpecies}
              title="Ghost species"
              description="Rarely documented anywhere, but you found them."
              titleClass="text-violet-700 dark:text-violet-400"
            />
          )}
          {stats.lostSpecies.length > 0 && (
            <SpeciesCallout
              species={stats.lostSpecies}
              title="Lost species"
              description="Not recorded anywhere else in over 25 years."
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
  titleClass,
  wide = false,
}: {
  species: SpeciesRef[];
  title: string;
  description: string;
  titleClass: string;
  wide?: boolean;
}) {
  const speciesName = useSpeciesName();
  return (
    <div className={`${PANEL} ${wide ? "sm:col-span-2" : ""}`}>
      <p className={`text-sm font-semibold ${titleClass}`}>
        {title} ({species.length})
      </p>
      <p className="mt-0.5 text-xs text-muted">{description}</p>
      <ul className="mt-2 space-y-0.5 text-sm text-ink">
        {species.map((s) => (
          <li key={s.speciesId}>
            <SpeciesLink id={s.speciesId}>{speciesName(s)}</SpeciesLink>
          </li>
        ))}
      </ul>
    </div>
  );
}
