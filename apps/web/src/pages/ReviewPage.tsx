// The review queue: photos Lifer filed by itself (captures/identification.ts) wait here, grouped
// by encounter, until the user confirms them or picks another species. Confirmed photos never
// appear. Fully keyboard driven through the registry's "review" scope.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { api, apiPath, type ApiResponse } from "../api/client";
import Button from "../components/Button";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import ProbableGroupText from "../components/ProbableGroupText";
import ProgressBar from "../components/ProgressBar";
import SpeciesPicker from "../components/SpeciesPicker";
import { useLightbox } from "../components/Lightbox";
import { photoSlide } from "../lib/photoSlide";
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
// A confirm or "file as" waits this long for Undo before it's sent: as long as its toast stays.
const UNDO_MS = 8000;

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

  const settle = useCallback((e: Encounter, done: boolean) => {
    setDoneKeys((d) => {
      const next = new Set(d);
      if (done) next.add(encounterKey(e));
      else next.delete(encounterKey(e));
      return next;
    });
    setConfirmedExtra((n) => n + (done ? e.captureIds.length : -e.captureIds.length));
  }, []);

  // Each decision moves on at once and is sent once its Undo has passed (or the page is left).
  const pending = useRef(new Map<string, () => Promise<unknown>>());
  useEffect(() => {
    const all = pending.current;
    return () => all.forEach((send) => void send());
  }, []);
  const decide = useCallback(
    (e: Encounter, message: string, run: () => Promise<unknown>) => {
      settle(e, true);
      const key = encounterKey(e);
      const send = () => {
        clearTimeout(timer);
        pending.current.delete(key);
        return run().finally(refreshReviewCount);
      };
      const timer = setTimeout(() => void send(), UNDO_MS);
      pending.current.set(key, send);
      const undo = () => {
        if (!pending.current.has(key)) return;
        clearTimeout(timer);
        pending.current.delete(key);
        settle(e, false);
      };
      toast.show(message, { tone: "success", actions: [{ label: t("common.undo"), onClick: undo }] });
    },
    [settle, toast, t],
  );

  const confirm = useCallback(
    (e: Encounter) =>
      decide(
        e,
        t("review.confirmed", {
          count: e.captureIds.length,
          formatted: formatNumber(e.captureIds.length),
          name: name({ commonName: e.commonName, scientificName: e.scientificName }),
        }),
        () =>
          api.post("/identifications/confirm", { captureIds: e.captureIds }).catch(() => {
            toast.error(t("review.confirmFailed"));
            load();
          }),
      ),
    [decide, name, toast, t, load],
  );

  // Another species for the whole encounter: a suggestion, or any species picked by hand.
  const fileAs = useCallback(
    (e: Encounter, speciesId: string, label: string) =>
      decide(e, t("review.filedAs", { count: e.captureIds.length, name: label }), () =>
        mapWithConcurrency(e.captureIds, 4, (id) =>
          api.patch(apiPath("/captures/{id}/reassign", { id }), { speciesId }),
        ).catch(() => {
          toast.error(t("review.fileFailed", { name: label }));
          load();
        }),
      ),
    [decide, toast, t, load],
  );
  const fileAsSuggestion = useCallback(
    (e: Encounter, s: Suggestion) =>
      fileAs(e, s.id, name({ commonName: s.common_name, scientificName: s.scientific_name })),
    [fileAs, name],
  );

  // The loaded sightings are done but more wait on the server: send what's pending, then fetch them.
  const more = !!queue && queue.encounterCount > queue.encounters.length;
  useEffect(() => {
    if (!more || waiting.length > 0) return;
    void Promise.all([...pending.current.values()].map((send) => send())).then(load);
  }, [more, waiting.length, load]);
  const viewer = useLightbox();

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
        else if (alternatives[n - 1]) fileAsSuggestion(current, alternatives[n - 1]!);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [current, confirm, fileAsSuggestion, notSure, alternatives, waiting.length]);

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
          {/* Fixed frame, letterboxed, so the layout holds still between photos. Opens full size. */}
          {/* raw-control: the whole frame is the button that opens the viewer. */}
          <button
            type="button"
            aria-label={label}
            disabled={!shownPhoto}
            onClick={() => {
              const ids = photoIds.flatMap((id) => (id ? [id] : []));
              const all = ids.length > 0 ? ids : [shownPhoto!];
              viewer.open(
                all.map((photoId) => photoSlide({ photoId })),
                all.indexOf(shownPhoto!),
              );
            }}
            className="flex h-[55vh] min-h-64 cursor-zoom-in items-center justify-center overflow-hidden rounded-panel bg-surround focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {shownPhoto && (
              <img
                key={shownPhoto}
                src={`/api/photos/${shownPhoto}/display`}
                alt=""
                className="max-h-full max-w-full object-contain"
              />
            )}
          </button>
          {viewer.node}
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
                <Button key={s.id} variant="secondary" onClick={() => fileAsSuggestion(current, s)}>
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
            {/* None of the suggestions: any species, filed the same way. */}
            <div className="w-72 max-w-full">
              <SpeciesPicker
                key={currentKey}
                ariaLabel={t("review.otherSpecies")}
                placeholder={t("import.rows.typeSpecies")}
                regionId={current.regionId}
                onSelect={(r) => fileAs(current, r.id, name(r))}
              />
            </div>
            <p className="text-footnote text-muted">
              {t("review.keys", {
                confirm: shortcutLabel("reviewConfirm"),
                notSure: shortcutLabel("reviewNotSure"),
                position: currentIndex + 1,
                total: formatNumber(queue.encounterCount - doneKeys.size),
              })}
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
