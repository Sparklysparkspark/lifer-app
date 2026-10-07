import { Link } from "react-router-dom";
import { taxonDisplayLabel } from "@lifer/shared";
import { Spinner } from "../../components/LoadingScreen";
import InfoTip from "../../components/InfoTip";
import { pluralize } from "../../lib/pluralize";
import { ChartCard, NoValue, OptionSelect } from "./StatsUi";
import { SCATTER_AXES, type portfolioHighlights } from "./statsHelpers";
import type { StatsData } from "./useStatsData";

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
  const { mostPhotographed, oneAndDone, needsBetterPhoto } = highlights;
  const yearOptions = years.available.map((y) => ({ value: String(y), label: String(y) }));
  const comparison = years.comparison;

  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold text-ink">Collection intelligence</h2>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Most photographed">
          {mostPhotographed.length === 0 ? (
            <p className="text-sm text-muted">No photos yet.</p>
          ) : (
            <ol className="space-y-1 text-sm">
              {mostPhotographed.map((s, i) => (
                <li key={s.speciesId} className="flex items-center justify-between gap-2">
                  <span className="truncate text-ink">
                    <span className="text-muted">{i + 1}.</span> {s.commonName ?? s.scientificName}
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
                    {s.commonName ?? s.scientificName}
                  </li>
                ))}
              </ul>
            </>
          )}
        </ChartCard>

        <ChartCard
          title="Could use a better photo"
          controls={<InfoTip paragraphs={["Species with only one photo, and you've rated it 1 star yourself."]} />}
        >
          {needsBetterPhoto.length === 0 ? (
            <p className="text-sm text-muted">Nothing stands out. No single-photo species is rated 1 star.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {needsBetterPhoto.slice(0, 10).map((s) => (
                <li key={s.speciesId} className="flex items-center justify-between gap-2 text-ink">
                  <span className="truncate">{s.commonName ?? s.scientificName}</span>
                  <span className="shrink-0 text-xs text-muted">1 photo, rated ★</span>
                </li>
              ))}
            </ul>
          )}
        </ChartCard>

        <ChartCard
          title="Archive health"
          controls={
            <InfoTip
              align="right"
              paragraphs={["How much of your library is missing data a normal photo would have."]}
            />
          }
        >
          {!archiveHealth ? (
            <Spinner />
          ) : (
            <ul className="space-y-1.5 text-sm text-ink">
              <li className="flex items-center justify-between">
                {archiveHealth.missingDate > 0 ? (
                  <Link to="/gallery?missingDate=1" className="text-accent hover:underline">
                    Missing date
                  </Link>
                ) : (
                  <span>Missing date</span>
                )}
                <span className="text-muted">
                  {archiveHealth.missingDate} / {archiveHealth.total}
                </span>
              </li>
            </ul>
          )}
        </ChartCard>

        <ChartCard
          title="Photography DNA"
          controls={
            <InfoTip
              paragraphs={[
                "A statistical fingerprint of how you shoot wildlife: what you photograph and what kind of shot you tend to get.",
              ]}
            />
          }
        >
          {!photographyDna ? (
            <Spinner />
          ) : (
            <div className="space-y-3 text-sm">
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">By taxon</p>
                {photographyDna.taxonBreakdown.slice(0, 5).map((t) => (
                  <div key={t.taxonClass} className="flex items-center justify-between text-ink">
                    <span>{taxonDisplayLabel(t.taxonClass, namingStyles)}</span>
                    <span className="text-muted">{t.percent}%</span>
                  </div>
                ))}
              </div>
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">By kind of shot</p>
                {photographyDna.categoryBreakdown.map((c) => (
                  <div key={c.key} className="flex items-center justify-between text-ink">
                    <span className="capitalize">{c.key}</span>
                    <span className="text-muted">{c.percent}%</span>
                  </div>
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
