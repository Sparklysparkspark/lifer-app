import { taxaColour, taxaGroup, taxaIllustration, type TaxaGroup } from "../../lib/taxaColour";
import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { taxonDisplayLabel } from "@lifer/shared";
import { Spinner } from "../../components/LoadingScreen";
import InfoTip from "../../components/InfoTip";
import { ChartCard, NoValue, OptionSelect } from "./StatsUi";
import { SCATTER_AXES, type portfolioHighlights } from "./statsHelpers";
import type { StatsData } from "./useStatsData";
import { useSpeciesName } from "../../lib/speciesName";
import { backStateFor } from "../../lib/backLabel";
import { SHOT_ACTION_LABELS, SHOT_FRAMING_LABELS, UNCATEGORIZED_REGION_ID } from "../gallery/galleryHelpers";
import EmptyState from "../../components/EmptyState";

// Always over the whole library, unaffected by the photo filter.
export default function CollectionIntelligence({
  highlights,
  archiveHealth,
  photographyDna,
  years,
  namingStyles,
}: {
  highlights: ReturnType<typeof portfolioHighlights>;
  archiveHealth: StatsData["archiveHealth"];
  photographyDna: StatsData["photographyDna"];
  years: StatsData["years"];
  namingStyles: Parameters<typeof taxonDisplayLabel>[1];
}) {
  const speciesName = useSpeciesName();
  const { t } = useTranslation();
  const { mostPhotographed, oneAndDone, needsBetterPhoto } = highlights;
  const yearOptions = years.available.map((y) => ({ value: String(y), label: String(y) }));
  const comparison = years.comparison;

  return (
    <div>
      <h2 className="mb-3 text-title-3 font-semibold text-ink">{t("stats.collection.title")}</h2>
      <div className="grid grid-cols-1 gap-item lg:grid-cols-2">
        <ChartCard title={t("stats.collection.mostPhotographed")}>
          {mostPhotographed.length === 0 ? (
            <EmptyState compact title={t("stats.collection.noPhotos")} />
          ) : (
            <ol className="space-y-1 text-callout">
              {mostPhotographed.map((s, i) => (
                <li key={s.speciesId} className="flex items-center justify-between gap-2">
                  <span className="truncate text-ink">
                    <span className="text-muted">{i + 1}.</span>{" "}
                    <SpeciesLink id={s.speciesId}>{speciesName(s)}</SpeciesLink>
                  </span>
                  <span className="shrink-0 text-footnote text-muted">
                    {t("stats.collection.photoCount", { count: s.totalPhotos })}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </ChartCard>

        <ChartCard
          title={t("stats.collection.oneAndDone")}
          controls={<InfoTip align="right" paragraphs={[t("stats.collection.oneAndDoneInfo")]} />}
        >
          {oneAndDone.length === 0 ? (
            <EmptyState compact title={t("stats.collection.noOneAndDone")} />
          ) : (
            <>
              <p className="mb-2 text-callout text-ink">
                <Trans
                  i18nKey="stats.collection.oneAndDoneCount"
                  values={{ count: oneAndDone.length }}
                  components={{ b: <span className="font-semibold" /> }}
                />
              </p>
              <ul className="grid grid-cols-2 gap-1 text-footnote text-muted sm:grid-cols-3">
                {oneAndDone.slice(0, 30).map((s) => (
                  <li key={s.speciesId} className="truncate">
                    <SpeciesLink id={s.speciesId}>{speciesName(s)}</SpeciesLink>
                  </li>
                ))}
              </ul>
            </>
          )}
        </ChartCard>

        <ChartCard title={t("stats.collection.needsBetter")}>
          {needsBetterPhoto.length === 0 ? (
            <EmptyState compact title={t("stats.collection.noNeedsBetter")} />
          ) : (
            <ul className="space-y-1 text-callout">
              {needsBetterPhoto.slice(0, 10).map((s) => (
                <li key={s.speciesId} className="flex items-center justify-between gap-2 text-ink">
                  <SpeciesLink id={s.speciesId} className="truncate">
                    {speciesName(s)}
                  </SpeciesLink>
                  <span className="shrink-0 text-footnote text-muted">{t("stats.collection.ratedOneStar")}</span>
                </li>
              ))}
            </ul>
          )}
        </ChartCard>

        <ChartCard title={t("stats.collection.archiveHealth")}>
          {!archiveHealth ? (
            <Spinner />
          ) : (
            <ul className="space-y-1.5 text-callout text-ink">
              <HealthRow
                missing={archiveHealth.missingDate}
                total={archiveHealth.total}
                to="/gallery?missingDate=1"
                missingText={t("stats.collection.missingDate", { count: archiveHealth.missingDate })}
                okText={
                  archiveHealth.total === 1
                    ? t("stats.collection.oneHasDate")
                    : t("stats.collection.allHaveDate", { count: archiveHealth.total })
                }
              />
              <HealthRow
                missing={archiveHealth.missingRegion}
                total={archiveHealth.total}
                to={`/gallery?regionId=${UNCATEGORIZED_REGION_ID}&fix=region`}
                missingText={t("stats.collection.missingRegion", { count: archiveHealth.missingRegion })}
                okText={
                  archiveHealth.total === 1
                    ? t("stats.collection.oneHasRegion")
                    : t("stats.collection.allHaveRegion", { count: archiveHealth.total })
                }
              />
            </ul>
          )}
        </ChartCard>

        <ChartCard title={t("stats.collection.whatYouShoot")}>
          {!photographyDna ? (
            <Spinner />
          ) : (
            <div className="space-y-3 text-callout">
              <div>
                <p className="mb-1 text-footnote font-medium text-muted">{t("stats.collection.byGroup")}</p>
                {photographyDna.taxonBreakdown.slice(0, 5).map((t) => (
                  <DnaRow
                    key={t.taxonClass}
                    to={`/gallery?taxon=${encodeURIComponent(t.taxonClass)}`}
                    label={taxonDisplayLabel(t.taxonClass, namingStyles)}
                    percent={t.percent}
                    group={taxaGroup(t.taxonClass)}
                  />
                ))}
              </div>
              <div>
                <p className="mb-1 text-footnote font-medium text-muted">{t("stats.collection.byShotAction")}</p>
                {photographyDna.actionBreakdown.map((c) => (
                  <DnaRow
                    key={c.key}
                    to={`/gallery?action=${encodeURIComponent(c.key)}`}
                    label={t(SHOT_ACTION_LABELS[c.key as keyof typeof SHOT_ACTION_LABELS] ?? c.key)}
                    percent={c.percent}
                  />
                ))}
              </div>
              <div>
                <p className="mb-1 text-footnote font-medium text-muted">{t("stats.collection.byShotFraming")}</p>
                {photographyDna.framingBreakdown.map((c) => (
                  <DnaRow
                    key={c.key}
                    to={`/gallery?framing=${encodeURIComponent(c.key)}`}
                    label={t(SHOT_FRAMING_LABELS[c.key as keyof typeof SHOT_FRAMING_LABELS] ?? c.key)}
                    percent={c.percent}
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-footnote text-muted">
                {photographyDna.medianFocalLengthMm != null && (
                  <span>
                    {t("stats.collection.medianFocal", { mm: Math.round(photographyDna.medianFocalLengthMm) })}
                  </span>
                )}
                {photographyDna.medianShutterSeconds != null && (
                  <span>
                    {t("stats.collection.medianShutter", {
                      shutter: SCATTER_AXES.shutterSeconds.format(photographyDna.medianShutterSeconds),
                    })}
                  </span>
                )}
                {photographyDna.medianIso != null && (
                  <span>{t("stats.collection.medianIso", { iso: Math.round(photographyDna.medianIso) })}</span>
                )}
              </div>
            </div>
          )}
        </ChartCard>

        <ChartCard
          title={t("stats.collection.yearOverYear")}
          controls={
            years.available.length > 1 && (
              <div className="flex items-center gap-1.5 text-footnote">
                <OptionSelect
                  ariaLabel={t("stats.collection.firstYear")}
                  value={String(years.a ?? "")}
                  onChange={(v) => years.setA(Number(v))}
                  options={yearOptions}
                />
                <span className="text-muted">{t("stats.collection.vs")}</span>
                <OptionSelect
                  ariaLabel={t("stats.collection.secondYear")}
                  value={String(years.b ?? "")}
                  onChange={(v) => years.setB(Number(v))}
                  options={yearOptions}
                />
              </div>
            )
          }
        >
          {years.available.length < 2 ? (
            <EmptyState compact title={t("stats.collection.needTwoYears")} />
          ) : !comparison ? (
            <Spinner />
          ) : (
            <table className="w-full text-callout">
              <thead>
                <tr className="text-left text-footnote text-muted">
                  <th className="pb-1 font-medium"></th>
                  <th className="pb-1 font-medium">{comparison.a.year}</th>
                  <th className="pb-1 font-medium">{comparison.b.year}</th>
                </tr>
              </thead>
              <tbody className="text-ink">
                <tr>
                  <td className="text-muted">{t("stats.collection.rowSpecies")}</td>
                  <td>{comparison.a.speciesCount}</td>
                  <td>{comparison.b.speciesCount}</td>
                </tr>
                <tr>
                  <td className="text-muted">{t("stats.collection.rowPhotos")}</td>
                  <td>{comparison.a.photoCount}</td>
                  <td>{comparison.b.photoCount}</td>
                </tr>
                <tr>
                  <td className="text-muted">{t("stats.collection.rowFocal")}</td>
                  <td>{comparison.a.avgFocalLength != null ? `${comparison.a.avgFocalLength}mm` : <NoValue />}</td>
                  <td>{comparison.b.avgFocalLength != null ? `${comparison.b.avgFocalLength}mm` : <NoValue />}</td>
                </tr>
                <tr>
                  <td className="text-muted">{t("stats.collection.rowIso")}</td>
                  <td>{comparison.a.avgIso ?? <NoValue />}</td>
                  <td>{comparison.b.avgIso ?? <NoValue />}</td>
                </tr>
              </tbody>
            </table>
          )}
        </ChartCard>
      </div>
    </div>
  );
}

// One "What you shoot" row, opening the Gallery filtered to those photos.
function DnaRow({ to, label, percent, group }: { to: string; label: string; percent: number; group?: TaxaGroup }) {
  const location = useLocation();
  const { t } = useTranslation();
  return (
    <Link
      to={to}
      state={backStateFor(location, t)}
      className="-mx-1 flex items-center justify-between rounded-control px-1 text-ink hover:bg-surface-muted"
    >
      <span className="flex min-w-0 items-center gap-2">
        {group && (
          <span
            aria-hidden
            className="size-4 shrink-0"
            style={{
              backgroundColor: taxaColour(group),
              mask: `url(${taxaIllustration(group)}) center / contain no-repeat`,
            }}
          />
        )}
        <span className="truncate">{label}</span>
      </span>
      <span className="ml-2 shrink-0 text-muted">{percent}%</span>
    </Link>
  );
}

// A species name that opens its page.
export function SpeciesLink({ id, className = "", children }: { id: string; className?: string; children: ReactNode }) {
  const location = useLocation();
  const { t } = useTranslation();
  return (
    <Link to={`/species/${id}`} state={backStateFor(location, t)} className={`hover:underline ${className}`}>
      {children}
    </Link>
  );
}

/** One Library health check: a link to the photos missing it, or good news when none are. A clean
 *  result reads "All 53 photos have a date", not "0 / 53". */
function HealthRow({
  missing,
  total,
  to,
  missingText,
  okText,
}: {
  missing: number;
  total: number;
  to: string;
  missingText: string;
  okText: string;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  return (
    <li className="flex items-center justify-between gap-2">
      {missing > 0 ? (
        <>
          <Link to={to} state={backStateFor(location, t)} className="text-accent hover:underline">
            {missingText}
          </Link>
          <span className="text-footnote text-muted">{t("stats.collection.ofTotal", { total })}</span>
        </>
      ) : (
        <span>
          <span className="text-accent">✓</span> {okText}
        </span>
      )}
    </li>
  );
}
