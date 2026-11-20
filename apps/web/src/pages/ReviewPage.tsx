// The review queue: photos Lifer filed by itself (captures/identification.ts) wait here, grouped
// by encounter, until the user confirms them or picks another species. Confirmed photos never
// appear. Fully keyboard driven through the registry's "review" scope.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { api, apiPath, type ApiResponse } from "../api/client";
import Button from "../components/Button";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import ProbableGroupText from "../components/ProbableGroupText";
import ProgressBar from "../components/ProgressBar";
import { isTypingTarget } from "../hooks/useKeyboardShortcuts";
import { useToast } from "../hooks/useToast";
import { refreshReviewCount } from "../hooks/useReviewCount";
import { mapWithConcurrency } from "../lib/concurrency";
import { formatNumber } from "../lib/format";
import { matchAction, matchesChord, KEYMAP, shortcutLabel } from "../lib/keymap";
import { useSpeciesName } from "../lib/speciesName";

type Queue = ApiResponse<"/identifications/suggested">;
type Encounter = Queue["encounters"][number];
type Suggestion = ApiResponse<"/captures/{id}/suggestions">["suggestions"][number];

const LEAST_SURE_BELOW = 95;
const MAX_ALTERNATIVES = 4;
const REVIEW_KEYS = ["reviewConfirm", "reviewPick", "reviewNotSure", "reviewNext", "reviewPrevious"] as const;

const encounterKey = (e: Encounter) => e.captureIds[0] ?? e.speciesId;

function section(e: Encounter): "lifers" | "leastSure" | "rest" {
  if (e.possibleLifer) return "lifers";
  return e.lowestPercent < LEAST_SURE_BELOW ? "leastSure" : "rest";
}

export default function ReviewPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const name = useSpeciesName();
  const [queue, setQueue] = useState<Queue | null>(null);
  const [failed, setFailed] = useState(false);
  const [doneKeys, setDoneKeys] = useState<Set<string>>(new Set());
  const [confirmedExtra, setConfirmedExtra] = useState(0);
  const [index, setIndex] = useState(0);
  // Both belong to one encounter; a stale key reads as the defaults.
  const [frameState, setFrameState] = useState<{ key: string | null; i: number }>({ key: null, i: 0 });
  const [altState, setAltState] = useState<{
    key: string | null;
    list: Suggestion[];
    probably?: Suggestion["probably"];
  }>({
    key: null,
    list: [],
  });

  const load = useCallback(() => {
    api
      .get("/identifications/suggested")
      .then((q) => {
        setQueue(q);
        setDoneKeys(new Set());
        setConfirmedExtra(0);
      })
      .catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);

  const waiting = useMemo(
    () => (queue?.encounters ?? []).filter((e) => !doneKeys.has(encounterKey(e))),
    [queue, doneKeys],
  );
  const current = waiting[Math.min(index, waiting.length - 1)] ?? null;
  const currentKey = current ? encounterKey(current) : null;
  const frame = frameState.key === currentKey ? frameState.i : 0;
  const alternatives = useMemo(() => (altState.key === currentKey ? altState.list : []), [altState, currentKey]);
  const probably = altState.key === currentKey ? altState.probably : undefined;
  const setFrame = (i: number) => setFrameState({ key: currentKey, i });

  // The other likely species, ranked from the encounter's first photo.
  useEffect(() => {
    const first = current?.captureIds[0];
    if (!first) return;
    let live = true;
    api
      .get(apiPath("/captures/{id}/suggestions", { id: first }))
      .then((r) => {
        if (live)
          setAltState({
            key: currentKey,
            list: r.suggestions.filter((s) => s.id !== current.speciesId).slice(0, MAX_ALTERNATIVES),
            probably: r.suggestions[0]?.probably,
          });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the encounter, not its object
  }, [currentKey]);

  const settle = useCallback((e: Encounter) => {
    setDoneKeys((d) => new Set(d).add(encounterKey(e)));
    setConfirmedExtra((n) => n + e.captureIds.length);
  }, []);

  const confirm = useCallback(
    (e: Encounter) => {
      settle(e);
      api
        .post("/identifications/confirm", { captureIds: e.captureIds })
        .catch(() => {
          toast.error(t("review.confirmFailed"));
          load();
        })
        .finally(refreshReviewCount);
    },
    [settle, toast, t, load],
  );

  // Another species for the whole encounter; files move, so it runs on without holding the queue.
  const fileAs = useCallback(
    (e: Encounter, s: Suggestion) => {
      settle(e);
      const label = name({ commonName: s.common_name, scientificName: s.scientific_name });
      mapWithConcurrency(e.captureIds, 4, (id) =>
        api.patch(apiPath("/captures/{id}/reassign", { id }), { speciesId: s.id }),
      )
        .then(() => toast.show(t("review.filedAs", { count: e.captureIds.length, name: label })))
        .catch(() => {
          toast.error(t("review.fileFailed", { name: label }));
          load();
        })
        .finally(refreshReviewCount);
    },
    [settle, name, toast, t, load],
  );

  const notSure = useCallback(() => {
    setIndex((i) => (waiting.length === 0 ? 0 : (i + 1) % waiting.length));
  }, [waiting.length]);

  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.defaultPrevented || ev.isComposing || isTypingTarget(ev.target) || !current) return;
      const action = matchAction(ev, REVIEW_KEYS);
      if (!action) return;
      ev.preventDefault();
      if (action === "reviewConfirm") confirm(current);
      else if (action === "reviewNotSure") notSure();
      else if (action === "reviewNext") setIndex((i) => Math.min(i + 1, waiting.length - 1));
      else if (action === "reviewPrevious") setIndex((i) => Math.max(i - 1, 0));
      else {
        const n = KEYMAP.reviewPick.chords.findIndex((c) => matchesChord(ev, c));
        if (n === 0) confirm(current);
        else if (alternatives[n - 1]) fileAs(current, alternatives[n - 1]!);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [current, confirm, fileAs, notSure, alternatives, waiting.length]);

  if (failed)
    return (
      <main className="space-y-section p-page">
        <EmptyState title={t("review.loadFailed")} action={{ label: t("common.retry"), onClick: load }} />
      </main>
    );
  if (!queue) return null;

  const total = queue.confirmedCount + queue.suggestedCount;
  const confirmed = queue.confirmedCount + confirmedExtra;
  const header = (
    <PageHeader topLevel title={t("review.title")}>
      {total > 0 && (
        <div className="flex max-w-md flex-col gap-1.5">
          <p className="text-callout text-muted">
            {t("review.progress", { confirmed: formatNumber(confirmed), total: formatNumber(total) })}
          </p>
          <ProgressBar value={confirmed / total} determinate label={t("review.title")} />
        </div>
      )}
    </PageHeader>
  );

  if (!current)
    return (
      <main className="space-y-section p-page">
        {header}
        <EmptyState
          title={t("review.emptyTitle")}
          description={t("review.emptyDescription")}
          action={{ label: t("review.toCollection"), onClick: () => navigate("/") }}
        />
      </main>
    );

  const currentIndex = waiting.indexOf(current);
  const photoIds = current.photoIds;
  const shownPhoto = photoIds[frame] ?? current.coverPhotoId;
  const sections = (["lifers", "leastSure", "rest"] as const)
    .map((s) => ({ s, items: waiting.filter((e) => section(e) === s) }))
    .filter((g) => g.items.length > 0);
  const label = name({ commonName: current.commonName, scientificName: current.scientificName });
  const sectionTitle = {
    lifers: t("review.section.lifers"),
    leastSure: t("review.section.leastSure"),
    rest: t("review.section.rest"),
  };

  return (
    <main className="flex min-h-0 flex-1 flex-col space-y-section p-page">
      {header}
      <div className="flex min-h-0 flex-1 flex-col gap-6 md:flex-row">
        <nav aria-label={t("review.listLabel")} className="max-h-64 shrink-0 overflow-y-auto md:max-h-none md:w-72">
          {sections.map(({ s, items }) => (
            <section key={s} className="mb-4">
              <h2 className="mb-1 px-2 text-footnote font-semibold uppercase tracking-wide text-muted">
                {sectionTitle[s]}
              </h2>
              <ul className="flex flex-col gap-0.5">
                {items.map((e) => {
                  const on = e === current;
                  return (
                    <li key={encounterKey(e)}>
                      {/* raw-control: a list row that selects an encounter, styled like the sidebar's rows. */}
                      <button
                        type="button"
                        aria-current={on || undefined}
                        onClick={() => setIndex(waiting.indexOf(e))}
                        className={`flex w-full flex-col items-start rounded-control px-2 py-1.5 text-left transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                          on ? "bg-accent/15" : "hover:bg-line"
                        }`}
                      >
                        <span className="text-callout text-ink [overflow-wrap:anywhere]">
                          {name({ commonName: e.commonName, scientificName: e.scientificName })}
                        </span>
                        <span className="text-footnote text-muted">
                          {t("review.rowMeta", {
                            count: e.count,
                            formatted: formatNumber(e.count),
                            percent: e.lowestPercent,
                          })}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {queue.encounterCount > queue.encounters.length && (
            <p className="px-2 text-footnote text-muted">
              {t("review.more", { count: queue.encounterCount - queue.encounters.length })}
            </p>
          )}
        </nav>

        <section aria-label={label} className="flex min-w-0 flex-1 flex-col gap-4">
          {/* Fixed frame, letterboxed, so the layout holds still between photos. */}
          <div className="flex h-[55vh] min-h-64 items-center justify-center overflow-hidden rounded-panel bg-surround">
            {shownPhoto && (
              <img
                key={shownPhoto}
                src={`/api/photos/${shownPhoto}/display`}
                alt={label}
                className="max-h-full max-w-full object-contain"
              />
            )}
          </div>
          {photoIds.length > 1 && (
            <div
              className="flex gap-1.5 overflow-x-auto pb-1"
              aria-label={t("review.frames", { count: current.count })}
            >
              {photoIds.map((id, i) =>
                id ? (
                  // raw-control: a filmstrip thumbnail that picks the frame shown above.
                  <button
                    type="button"
                    key={id}
                    onClick={() => setFrame(i)}
                    aria-label={t("review.frame", { n: i + 1 })}
                    className={`h-16 w-16 shrink-0 overflow-hidden rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                      i === frame ? "outline-2 outline-accent" : "opacity-80 hover:opacity-100"
                    }`}
                  >
                    <img src={`/api/photos/${id}/thumb`} alt="" loading="lazy" className="h-full w-full object-cover" />
                  </button>
                ) : null,
              )}
            </div>
          )}

          <div className="flex flex-col gap-3">
            <h2 className="text-title-2 font-semibold text-ink [overflow-wrap:anywhere]">{label}</h2>
            <p className="text-callout text-muted">
              {t("review.encounterMeta", {
                count: current.count,
                formatted: formatNumber(current.count),
                percent: current.lowestPercent,
              })}
            </p>
            {/* Display only: the buttons below still file a species, never the genus. */}
            {probably && (
              <p className="text-callout text-muted wrap-anywhere">
                <ProbableGroupText group={probably} />
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => confirm(current)}>
                {t("review.confirm", {
                  count: current.captureIds.length,
                  formatted: formatNumber(current.captureIds.length),
                })}
              </Button>
              {alternatives.map((s, i) => (
                <Button key={s.id} variant="secondary" onClick={() => fileAs(current, s)}>
                  {t("review.alternative", {
                    n: i + 2,
                    name: name({ commonName: s.common_name, scientificName: s.scientific_name }),
                    percent: s.matchPercent ?? 0,
                  })}
                </Button>
              ))}
              <Button variant="ghost" onClick={notSure}>
                {t("review.notSure")}
              </Button>
            </div>
            <p className="text-footnote text-muted">
              {t("review.keys", {
                confirm: shortcutLabel("reviewConfirm"),
                notSure: shortcutLabel("reviewNotSure"),
                position: currentIndex + 1,
                total: waiting.length,
              })}
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
