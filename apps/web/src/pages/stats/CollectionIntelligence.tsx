import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { taxonDisplayLabel } from "@lifer/shared";
import { Spinner } from "../../components/LoadingScreen";
import InfoTip from "../../components/InfoTip";
import { pluralize } from "../../lib/pluralize";
import { formatNumber } from "../../lib/format";
import { ChartCard, NoValue, OptionSelect } from "./StatsUi";
import { SCATTER_AXES, type portfolioHighlights } from "./statsHelpers";
import type { StatsData } from "./useStatsData";
import { useSpeciesName } from "../../lib/speciesName";
import { backStateFor } from "../../lib/backLabel";

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
  const location = useLocation();
  const { mostPhotographed, oneAndDone, needsBetterPhoto } = highlights;
  const yearOptions = years.available.map((y) => ({ value: String(y), label: String(y) }));
  const comparison = years.comparison;

  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold text-ink">Your collection</h2>
      <div className="grid grid-cols-1 gap-item lg:grid-cols-2">
        <ChartCard title="Most photographed">
          {mostPhotographed.length === 0 ? (
            <p className="text-sm text-muted">No photos yet.</p>
          ) : (
            <ol className="space-y-1 text-sm">
              {mostPhotographed.map((s, i) => (
                <li key={s.speciesId} className="flex items-center justify-between gap-2">
                  <span className="truncate text-ink">
                    <span className="text-muted">{i + 1}.</span>{" "}
                    <SpeciesLink id={s.speciesId}>{speciesName(s)}</SpeciesLink>
                  </span>
                  <span className="shrink-0 text-xs text-muted">{pluralize(s.totalPhotos, "photo")}</span>
                </li>
              ))}
            </ol>
          )}
        </ChartCard>

        <ChartCard
          title="One-and-done species"
          controls={
            <InfoTip
              align="right"
              paragraphs={["Species you've photographed exactly once. Candidates for going back for a better shot."]}
            />
          }
        >
          {oneAndDone.length === 0 ? (
            <p className="text-sm text-muted">Every species you've photographed has 2+ photos.</p>
          ) : (
            <>
              <p className="mb-2 text-sm text-ink">
                <span className="font-semibold">{oneAndDone.length}</span> species represented by only one photograph.
              </p>
              <ul className="grid grid-cols-2 gap-1 text-xs text-muted sm:grid-cols-3">
                {oneAndDone.slice(0, 30).map((s) => (
                  <li key={s.speciesId} className="truncate">
                    <SpeciesLink id={s.speciesId}>{speciesName(s)}</SpeciesLink>
                  </li>
                ))}
              </ul>
            </>
          )}
        </ChartCard>

        <ChartCard title="Could use a better photo">
          {needsBetterPhoto.length === 0 ? (
            <p className="text-sm text-muted">Nothing stands out. No single-photo species is rated 1 star.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {needsBetterPhoto.slice(0, 10).map((s) => (
                <li key={s.speciesId} className="flex items-center justify-between gap-2 text-ink">
                  <SpeciesLink id={s.speciesId} className="truncate">
                    {speciesName(s)}
                  </SpeciesLink>
                  <span className="shrink-0 text-xs text-muted">1 photo, rated ★</span>
                </li>
              ))}
            </ul>
          )}
        </ChartCard>

        <ChartCard title="Archive health">
          {!archiveHealth ? (
            <Spinner />
          ) : (
            <ul className="space-y-1.5 text-sm text-ink">
              {/* A clean result reads as good news ("All 53 photos have a date"), not as "0 / 53". */}
              <li className="flex items-center justify-between gap-2">
                {archiveHealth.missingDate > 0 ? (
                  <>
                    <Link
                      to="/gallery?missingDate=1"
                      state={backStateFor(location, t)}
                      className="text-accent hover:underline"
                    >
                      {pluralize(archiveHealth.missingDate, "photo")} missing a date
                    </Link>
                    <span className="text-xs text-muted">of {formatNumber(archiveHealth.total)}</span>
                  </>
                ) : (
                  <span>
                    <span className="text-accent">✓</span>{" "}
                    {archiveHealth.total === 1
                      ? "Your photo has a date"
                      : `All ${pluralize(archiveHealth.total, "photo")} have a date`}
                  </span>
                )}
              </li>
            </ul>
          )}
        </ChartCard>

        <ChartCard title="What you shoot">
          {!photographyDna ? (
            <Spinner />
          ) : (
            <div className="space-y-3 text-sm">
              <div>
                <p className="mb-1 text-xs font-medium text-muted">By taxon</p>
                {photographyDna.taxonBreakdown.slice(0, 5).map((t) => (
                  <DnaRow
                    key={t.taxonClass}
                    to={`/gallery?taxon=${encodeURIComponent(t.taxonClass)}`}
                    label={taxonDisplayLabel(t.taxonClass, namingStyles)}
                    percent={t.percent}
                  />
                ))}
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-muted">By kind of shot</p>
                {photographyDna.categoryBreakdown.map((c) => (
                  <DnaRow
                    key={c.key}
                    to={`/gallery?shotKind=${encodeURIComponent(c.key)}`}
                    label={c.key.charAt(0).toUpperCase() + c.key.slice(1)}
                    percent={c.percent}
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                {photographyDna.medianFocalLengthMm != null && (
                  <span>Median focal length: {Math.round(photographyDna.medianFocalLengthMm)}mm</span>
                )}
                {photographyDna.medianShutterSeconds != null && (
                  <span>Median shutter: {SCATTER_AXES.shutterSeconds.format(photographyDna.medianShutterSeconds)}</span>
                )}
                {photographyDna.medianIso != null && <span>Median ISO: {Math.round(photographyDna.medianIso)}</span>}
              </div>
            </div>
          )}
        </ChartCard>

        <ChartCard
          title="Year over year"
          controls={
            years.available.length > 1 && (
              <div className="flex items-center gap-1.5 text-xs">
                <OptionSelect
                  ariaLabel="First year"
                  value={String(years.a ?? "")}
                  onChange={(v) => years.setA(Number(v))}
                  options={yearOptions}
                />
                <span className="text-muted">vs</span>
                <OptionSelect
                  ariaLabel="Second year"
                  value={String(years.b ?? "")}
                  onChange={(v) => years.setB(Number(v))}
                  options={yearOptions}
                />
              </div>
            )
          }
        >
          {years.available.length < 2 ? (
            <p className="text-sm text-muted">Need photos from at least two different years to compare.</p>
          ) : !comparison ? (
            <Spinner />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="pb-1 font-medium"></th>
                  <th className="pb-1 font-medium">{comparison.a.year}</th>
                  <th className="pb-1 font-medium">{comparison.b.year}</th>
                </tr>
              </thead>
              <tbody className="text-ink">
                <tr>
                  <td className="text-muted">Species</td>
                  <td>{comparison.a.speciesCount}</td>
                  <td>{comparison.b.speciesCount}</td>
                </tr>
                <tr>
                  <td className="text-muted">Photos</td>
                  <td>{comparison.a.photoCount}</td>
                  <td>{comparison.b.photoCount}</td>
                </tr>
                <tr>
                  <td className="text-muted">Avg focal length</td>
                  <td>{comparison.a.avgFocalLength != null ? `${comparison.a.avgFocalLength}mm` : <NoValue />}</td>
                  <td>{comparison.b.avgFocalLength != null ? `${comparison.b.avgFocalLength}mm` : <NoValue />}</td>
                </tr>
                <tr>
                  <td className="text-muted">Avg ISO</td>
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
function DnaRow({ to, label, percent }: { to: string; label: string; percent: number }) {
  const location = useLocation();
  const { t } = useTranslation();
  return (
    <Link
      to={to}
      state={backStateFor(location, t)}
      className="-mx-1 flex items-center justify-between rounded-control px-1 text-ink hover:bg-surface-muted"
    >
      <span>{label}</span>
      <span className="text-muted">{percent}%</span>
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
