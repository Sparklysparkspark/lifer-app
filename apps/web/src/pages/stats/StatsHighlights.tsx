import { useTranslation } from "react-i18next";
import { formatNumber } from "../../lib/format";
import { SpeciesLink } from "./CollectionIntelligence";
import { StatCard } from "./StatsUi";
import { percentOfKeepers, type headlineStats } from "./statsHelpers";
import type { SpeciesRef, StatsResponse } from "./types";
import { useSpeciesName } from "../../lib/speciesName";
import Panel from "../../components/Panel";

// The top of the page: the "how do I shoot" cards and the rare finds (only shown once you've made one; most photographers never will).
export default function StatsHighlights({
  stats,
  headlines,
}: {
  stats: StatsResponse;
  headlines: ReturnType<typeof headlineStats>;
}) {
  const { t } = useTranslation();
  const { topCamera, topFocalLength, busiestHour, bestMonth } = headlines;
  return (
    <>
      <div className="grid grid-cols-2 gap-item sm:grid-cols-4">
        {topCamera && (
          <StatCard
            label={t("stats.highlights.topCamera")}
            value={topCamera.model}
            sub={t("stats.highlights.ofKeepers", {
              percent: percentOfKeepers(topCamera.photoCount, stats.totalKeepers),
            })}
          />
        )}
        {topFocalLength && topFocalLength.count > 0 && (
          <StatCard
            label={t("stats.highlights.focalLength")}
            value={topFocalLength.label}
            sub={t("stats.highlights.focalLengthSub")}
          />
        )}
        {busiestHour && busiestHour.count > 0 && (
          <StatCard
            label={t("stats.highlights.peakTime")}
            value={busiestHour.label}
            sub={t("stats.highlights.ofKeepers", {
              percent: percentOfKeepers(busiestHour.count, stats.totalKeepers),
            })}
          />
        )}
        {bestMonth && bestMonth.newLifers > 0 && (
          <StatCard
            label={t("stats.highlights.bestMonth")}
            value={bestMonth.label}
            sub={t("stats.highlights.lifers", { count: bestMonth.newLifers, n: formatNumber(bestMonth.newLifers) })}
          />
        )}
      </div>

      {(stats.ghostSpecies.length > 0 || stats.lostSpecies.length > 0 || stats.rediscoveredSpecies.length > 0) && (
        <div className="grid gap-item sm:grid-cols-2">
          {stats.rediscoveredSpecies.length > 0 && (
            <SpeciesCallout
              species={stats.rediscoveredSpecies}
              title={t("stats.highlights.rediscovered")}
              description={t("stats.highlights.rediscoveredDescription")}
              titleClassName="text-emerald-700 dark:text-emerald-400"
              wide
            />
          )}
          {stats.ghostSpecies.length > 0 && (
            <SpeciesCallout
              species={stats.ghostSpecies}
              title={t("stats.highlights.ghost")}
              description={t("stats.highlights.ghostDescription")}
              titleClassName="text-violet-700 dark:text-violet-400"
            />
          )}
          {stats.lostSpecies.length > 0 && (
            <SpeciesCallout
              species={stats.lostSpecies}
              title={t("stats.highlights.lost")}
              description={t("stats.highlights.lostDescription")}
              titleClassName="text-rose-700 dark:text-rose-400"
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
  titleClassName,
  wide = false,
}: {
  species: SpeciesRef[];
  title: string;
  description: string;
  titleClassName: string;
  wide?: boolean;
}) {
  const speciesName = useSpeciesName();
  return (
    <Panel className={wide ? "sm:col-span-2" : ""}>
      <p className={`text-callout font-semibold ${titleClassName}`}>
        {title} ({formatNumber(species.length)})
      </p>
      <p className="mt-0.5 text-footnote text-muted">{description}</p>
      <ul className="mt-2 space-y-0.5 text-callout text-ink">
        {species.map((s) => (
          <li key={s.speciesId}>
            <SpeciesLink id={s.speciesId}>{speciesName(s)}</SpeciesLink>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
