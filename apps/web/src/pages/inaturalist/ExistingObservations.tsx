// Photos the user already added to iNaturalist themselves: the check that finds them (on To send,
// with progress and Cancel), its quiet result, and the review cards for possible matches.
import { useState, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import Button from "../../components/Button";
import EmptyState from "../../components/EmptyState";
import { useLightbox } from "../../components/Lightbox";
import JobProgress from "../../components/JobProgress";
import MediaCard, { Thumb } from "../../components/MediaCard";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { formatDate } from "../../lib/format";
import { openExternal } from "../../lib/openExternal";
import { useSpeciesName } from "../../lib/speciesName";
import { PAGE_SIZE } from "./CardGrid";
import type { useExistingCheck } from "../../hooks/useExistingCheck";

export type PossibleMatch = {
  captureId: string;
  photoId: string | null;
  speciesId: string;
  commonName: string | null;
  scientificName: string;
  takenAt: string | null;
  observationId: string;
  observationUrl: string;
  inatPhotoId: string | null;
  observedOn: string | null;
  likeness: "same" | "probably" | null;
  evidence: {
    taxon: "same" | "finer" | "related";
    time: "close" | "sameDay";
    size: "same" | "different" | null;
    place: "near" | null;
  };
};

/** On To send: a check someone started from elsewhere while it runs, or a problem with the last one. */
export function ExistingCheckBar({ check }: { check: ReturnType<typeof useExistingCheck> }) {
  const { t } = useTranslation();
  const { status } = check;
  // A check Lifer started by itself stays out of sight.
  if (status?.running && !status.auto)
    return (
      <JobProgress
        status={status}
        phases={{
          reading: { label: t("inaturalist.existing.reading"), progress: "count" },
          comparing: { label: t("inaturalist.existing.comparing"), progress: "count" },
        }}
        onCancel={check.cancel}
        cancelling={check.cancelling}
        showCancelled={false}
        compact
      />
    );
  // The check runs by itself; only a problem worth knowing about shows.
  if (!status?.error && !(status?.result && !status.result.compared)) return null;
  return (
    <p role="status" className="text-footnote text-muted">
      {status?.error ? t("inaturalist.existing.failed") : t("inaturalist.existing.noModel")}
    </p>
  );
}

const TAXON_KEYS = {
  same: "inaturalist.matches.taxon.same",
  finer: "inaturalist.matches.taxon.finer",
  related: "inaturalist.matches.taxon.related",
} as const;
const TIME_KEYS = { close: "inaturalist.matches.time.close", sameDay: "inaturalist.matches.time.sameDay" } as const;
const SIZE_KEYS = { same: "inaturalist.matches.size.same", different: "inaturalist.matches.size.different" } as const;
const LIKENESS_KEYS = {
  same: "inaturalist.matches.likeness.same",
  probably: "inaturalist.matches.likeness.probably",
} as const;

function evidenceLine(t: TFunction, m: PossibleMatch): string {
  const parts = [
    t(TAXON_KEYS[m.evidence.taxon]),
    t(TIME_KEYS[m.evidence.time]),
    m.evidence.size ? t(SIZE_KEYS[m.evidence.size]) : null,
    m.evidence.place ? t("inaturalist.matches.place") : null,
  ];
  return parts.filter(Boolean).join(", ");
}

/** Possible matches as cards: the iNaturalist photo beside the local one, what matched, and
 *  Link or Not a match. Candidates for the same observation sit together. */
export function MatchReview({ matches, onChanged }: { matches: PossibleMatch[]; onChanged: () => Promise<void> }) {
  const { t } = useTranslation();
  const toast = useToast();
  const speciesName = useSpeciesName();
  const [busy, setBusy] = useState<string | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(PAGE_SIZE);
  const viewer = useLightbox();
  const key = (m: PossibleMatch) => `${m.captureId}:${m.observationId}`;
  const list = matches
    .filter((m) => !gone.has(key(m)))
    .sort((a, b) => a.observationId.localeCompare(b.observationId) || (a.takenAt ?? "").localeCompare(b.takenAt ?? ""));

  async function act(m: PossibleMatch, link: boolean) {
    setBusy(key(m));
    try {
      await api.post(link ? "/inaturalist/matches/link" : "/inaturalist/matches/dismiss", {
        captureId: m.captureId,
        observationId: m.observationId,
      });
    } catch (err) {
      toast.error(errorMessage(err, t("inaturalist.existing.failed")));
      setBusy(null);
      return;
    }
    // Linking one photo settles its other suggestions too.
    setGone(
      (prev) => new Set([...prev, ...matches.filter((x) => x.captureId === m.captureId && (link || x === m)).map(key)]),
    );
    setBusy(null);
    if (link)
      toast.show(t("inaturalist.matches.linked"), {
        tone: "success",
        actions: [{ label: t("inaturalist.matches.undo"), onClick: () => void undoLink(m) }],
      });
    // Not a match applies at once and can be undone (the card comes back where it was).
    else
      toast.show(t("inaturalist.matches.dismissed"), {
        actions: [{ label: t("inaturalist.matches.undo"), onClick: () => void undoDismiss(m) }],
      });
    await onChanged();
  }

  async function undoLink(m: PossibleMatch) {
    try {
      await api.post("/inaturalist/matches/unlink", { captureIds: [m.captureId] });
    } catch (err) {
      toast.error(errorMessage(err, t("inaturalist.existing.failed")));
      return;
    }
    // The card and its other suggestions come back.
    setGone((prev) => new Set([...prev].filter((k) => !k.startsWith(`${m.captureId}:`))));
    await onChanged();
  }

  async function undoDismiss(m: PossibleMatch) {
    try {
      await api.post("/inaturalist/matches/dismiss", {
        captureId: m.captureId,
        observationId: m.observationId,
        undo: true,
      });
    } catch (err) {
      toast.error(errorMessage(err, t("inaturalist.existing.failed")));
      return;
    }
    setGone((prev) => new Set([...prev].filter((k) => k !== key(m))));
    await onChanged();
  }

  if (list.length === 0) return <EmptyState title={t("inaturalist.matches.empty")} />;
  const inatSrc = (m: PossibleMatch) =>
    m.inatPhotoId ? `/api/inaturalist/observations/${m.observationId}/photos/${m.inatPhotoId}` : null;
  // Both halves open one viewer, the iNaturalist photo then yours, to tell whether they're the same.
  const compare = (m: PossibleMatch, index: number) => {
    const src = inatSrc(m);
    viewer.open(
      [
        src ? { url: src, caption: t("inaturalist.matches.onInat") } : null,
        m.photoId ? { url: `/api/photos/${m.photoId}/display`, caption: t("inaturalist.matches.yourPhoto") } : null,
      ].filter((x) => x !== null),
      src ? index : 0,
    );
  };
  const half = (m: PossibleMatch, index: number, label: string, thumb: ReactNode, enabled: boolean) => (
    <figure className="relative">
      {enabled ? (
        // raw-control: the whole half is the button that opens it full size.
        <button
          type="button"
          aria-label={label}
          onClick={() => compare(m, index)}
          className="absolute inset-0 cursor-pointer transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          {thumb}
        </button>
      ) : (
        thumb
      )}
      <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 bg-surface/90 py-0.5 text-center text-caption font-medium text-ink">
        {label}
      </figcaption>
    </figure>
  );
  return (
    <div className="space-y-item">
      <p className="text-subheadline text-muted">{t("inaturalist.matches.summary")}</p>
      <ul
        aria-label={t("inaturalist.matches.view")}
        className="grid gap-3"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}
      >
        {list.slice(0, shown).map((m) => (
          <MediaCard
            key={key(m)}
            as="li"
            mediaClassName="aspect-[2/1]"
            media={
              <div className="grid h-full w-full grid-cols-2 gap-0.5">
                {half(
                  m,
                  0,
                  t("inaturalist.matches.onInat"),
                  inatSrc(m) ? (
                    <img
                      src={inatSrc(m)!}
                      alt=""
                      loading="lazy"
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  ) : (
                    <Thumb photoId={null} className="absolute inset-0" />
                  ),
                  !!inatSrc(m),
                )}
                {half(
                  m,
                  1,
                  t("inaturalist.matches.yourPhoto"),
                  <Thumb photoId={m.photoId} className="absolute inset-0" />,
                  !!m.photoId,
                )}
              </div>
            }
            title={speciesName(m)}
            titleLines={2}
            lines={[
              m.likeness ? t(LIKENESS_KEYS[m.likeness]) : t("inaturalist.matches.likeness.unknown"),
              [evidenceLine(t, m), m.takenAt ? formatDate(m.takenAt) : null].filter(Boolean).join(", "),
            ]}
            // Pinned to the bottom, so Link and Not a match line up across a row.
            footer={
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void act(m, true)}
                  loading={busy === key(m)}
                  disabled={busy !== null}
                >
                  {t("inaturalist.matches.link")}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => void act(m, false)} disabled={busy !== null}>
                  {t("inaturalist.matches.notMatch")}
                </Button>
                <Button variant="link" size="sm" onClick={() => openExternal(m.observationUrl)}>
                  {t("inaturalist.send.view")}
                </Button>
              </div>
            }
            renderBody={({ className, children }) => <div className={className}>{children}</div>}
          />
        ))}
      </ul>
      {list.length > shown && (
        <Button variant="secondary" size="sm" onClick={() => setShown((n) => n + PAGE_SIZE)}>
          {t("manageList.showMore", { count: Math.min(PAGE_SIZE, list.length - shown) })}
        </Button>
      )}
      {viewer.node}
    </div>
  );
}
