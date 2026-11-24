// Year in Review (N-01), from GET /api/stats/year-in-review. Built from
// docs/design/screens/year-in-review.html. Figures match Stats for the same concept (U1).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import { api, apiPath, type ApiResponse } from "../api/client";
import EmptyState from "../components/EmptyState";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import ProgressiveImg from "../components/ProgressiveImg";
import PageHeader from "../components/PageHeader";
import Select from "../components/Select";
import { formatDate, formatDateSpan, formatMonthName, formatNumber } from "../lib/format";
import { taxaColour, taxaGroup } from "../lib/taxaColour";
import { useSpeciesName } from "../lib/speciesName";

type Review = ApiResponse<"/stats/year-in-review">;
const card = "rounded-panel border border-line bg-surface p-4";
const photoButton =
  "block w-full overflow-hidden rounded-control transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const slideFor = (photoId: string, extra: Partial<LightboxSlide> = {}): LightboxSlide => ({
  url: `/api/photos/${photoId}/display`,
  thumbUrl: `/api/photos/${photoId}/thumb`,
  ...extra,
});

function Figure({ value, previous, label }: { value: number; previous: number; label: string }) {
  const { t } = useTranslation();
  const change = value - previous;
  return (
    <div className={card}>
      <p className="text-large-title font-semibold text-ink tabular-nums">{formatNumber(value)}</p>
      <p className="text-callout text-ink">{label}</p>
      {previous > 0 && (
        <p className="text-footnote text-muted">
          {t("yearInReview.change", { sign: change >= 0 ? "+" : "", change: formatNumber(change) })}
        </p>
      )}
    </div>
  );
}

export default function YearInReviewPage() {
  const { t } = useTranslation();
  const name = useSpeciesName();
  const [params, setParams] = useSearchParams();
  const year = params.get("year");
  const [data, setData] = useState<Review | null>(null);
  const [failed, setFailed] = useState(false);
  // Bumped by Retry to ask again.
  const [attempt, setAttempt] = useState(0);
  const [lightbox, setLightbox] = useState<{ slides: LightboxSlide[]; index: number } | null>(null);

  useEffect(() => {
    let live = true;
    api
      .get(apiPath("/stats/year-in-review", {}, { year: year ? Number(year) : undefined }))
      .then((d) => live && setData(d))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [year, attempt]);

  if (failed)
    return (
      <main className="space-y-section p-page">
        <EmptyState
          title={t("yearInReview.loadFailed")}
          action={{
            label: t("common.retry"),
            onClick: () => {
              setFailed(false);
              setAttempt((n) => n + 1);
            },
          }}
        />
      </main>
    );
  if (!data) return null;

  const picker = data.years.length > 1 && (
    <Select
      label={t("yearInReview.year")}
      value={data.year}
      onChange={(e) => setParams({ year: e.target.value }, { replace: true })}
    >
      {data.years.map((y) => (
        <option key={y} value={y}>
          {y}
        </option>
      ))}
    </Select>
  );
  const header = (
    <PageHeader
      title={t("yearInReview.title", { year: data.year })}
      backFallbackTo="/stats"
      backLabel={t("nav.stats")}
      actions={picker}
    />
  );

  if (data.counts.photos === 0)
    return (
      <main className="space-y-section p-page">
        {header}
        <EmptyState title={t("yearInReview.emptyTitle", { year: data.year })} />
      </main>
    );

  const firstsWithPhotos = data.firsts.items.filter((f) => f.photoId);
  const firstSlides = firstsWithPhotos.map((f) => slideFor(f.photoId!, { caption: name(f), speciesId: f.speciesId }));
  const bestSlides = data.bestPhotos.map((p) =>
    slideFor(p.photoId, { captureId: p.captureId, speciesId: p.speciesId, width: p.width, height: p.height }),
  );

  const months = Array.from({ length: 12 }, (_, i) => data.monthsByGroup.filter((r) => r.month === i + 1));
  const max = Math.max(1, ...months.map((m) => m.reduce((a, r) => a + r.count, 0)));

  return (
    <main className="space-y-section p-page">
      {header}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Figure
          value={data.counts.newSpecies}
          previous={data.previous.newSpecies}
          label={t("yearInReview.newSpecies", { count: data.counts.newSpecies })}
        />
        <Figure
          value={data.counts.photos}
          previous={data.previous.photos}
          label={t("yearInReview.photosLabel", { count: data.counts.photos })}
        />
        <Figure
          value={data.counts.trips}
          previous={data.previous.trips}
          label={t("yearInReview.trips", { count: data.counts.trips })}
        />
        <Figure
          value={data.counts.places}
          previous={data.previous.places}
          label={t("yearInReview.places", { count: data.counts.places })}
        />
      </div>

      {data.firsts.items.length > 0 && (
        <section>
          <h2 className="mb-3 text-title-3 font-semibold text-ink">
            {t("yearInReview.firsts", { count: data.firsts.total, formatted: formatNumber(data.firsts.total) })}
          </h2>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
            {data.firsts.items.map((f) => (
              <li key={f.speciesId} className="flex flex-col gap-1">
                {f.photoId && (
                  // raw-control: the whole photo is the button that opens it full size.
                  <button
                    type="button"
                    aria-label={t("yearInReview.openPhoto", { name: name(f) })}
                    onClick={() => setLightbox({ slides: firstSlides, index: firstsWithPhotos.indexOf(f) })}
                    className={photoButton}
                  >
                    <ProgressiveImg
                      thumbSrc={`/api/photos/${f.photoId}/thumb`}
                      alt=""
                      className="aspect-square w-full object-cover"
                    />
                  </button>
                )}
                <Link
                  to={`/species/${f.speciesId}`}
                  className="text-callout text-ink hover:underline [overflow-wrap:anywhere]"
                >
                  {name(f)}
                </Link>
                <span className="text-footnote text-muted">{formatDate(f.firstTakenAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.bestPhotos.length > 0 && (
        <section>
          <h2 className="mb-3 text-title-3 font-semibold text-ink">{t("yearInReview.best")}</h2>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-2">
            {data.bestPhotos.map((p, i) => (
              <li key={p.photoId}>
                {/* raw-control: the whole photo is the button that opens it full size. */}
                <button
                  type="button"
                  aria-label={t("yearInReview.openBestPhoto")}
                  onClick={() => setLightbox({ slides: bestSlides, index: i })}
                  className={photoButton}
                >
                  <ProgressiveImg
                    thumbSrc={`/api/photos/${p.photoId}/thumb`}
                    fullSrc={`/api/photos/${p.photoId}/display`}
                    alt=""
                    className="aspect-[4/3] w-full object-cover"
                  />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <section className={card}>
          <h2 className="mb-3 text-headline font-semibold text-ink">{t("yearInReview.months")}</h2>
          <div className="flex h-32 items-end gap-1" role="img" aria-label={t("yearInReview.months")}>
            {months.map((rows, i) => {
              const total = rows.reduce((a, r) => a + r.count, 0);
              const label = formatMonthName(i, "short");
              return (
                <div
                  key={label}
                  title={t("yearInReview.monthTotal", { month: label, count: total })}
                  className="flex flex-1 flex-col-reverse overflow-hidden rounded-control"
                  style={{ height: `${(total / max) * 100}%` }}
                >
                  {rows.map((r) => (
                    <div
                      key={r.taxonClass}
                      style={{ flexGrow: r.count, backgroundColor: taxaColour(taxaGroup(r.taxonClass)) }}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        </section>
        {(data.gear.cameras.length > 0 || data.gear.lenses.length > 0) && (
          <section className={card}>
            <h2 className="mb-3 text-headline font-semibold text-ink">{t("yearInReview.gear")}</h2>
            <ul className="space-y-1.5">
              {[...data.gear.cameras, ...data.gear.lenses].map((g) => (
                <li key={g.model} className="flex justify-between gap-3 text-callout">
                  <span className="min-w-0 text-ink [overflow-wrap:anywhere]">{g.model}</span>
                  <span className="text-muted tabular-nums">{formatNumber(g.photoCount)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {data.trips.length > 0 && (
        <section>
          <h2 className="mb-3 text-title-3 font-semibold text-ink">{t("yearInReview.tripsTitle")}</h2>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
            {data.trips.map((trip) => (
              <li key={trip.id}>
                <Link to={`/trips/${trip.id}`} className={`${card} flex flex-col gap-1 hover:bg-surface-muted`}>
                  <span className="text-headline text-ink [overflow-wrap:anywhere]">{trip.name}</span>
                  <span className="text-footnote text-muted">{formatDateSpan(trip.start, trip.end)}</span>
                  <span className="text-footnote text-muted">
                    {t("yearInReview.photos", { count: trip.photoCount })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {lightbox && (
        <Lightbox
          slides={lightbox.slides}
          index={lightbox.index}
          onIndexChange={(index) => setLightbox({ ...lightbox, index })}
          onClose={() => setLightbox(null)}
        />
      )}
    </main>
  );
}
