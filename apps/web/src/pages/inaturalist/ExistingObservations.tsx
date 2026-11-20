// Photos the user already added to iNaturalist themselves: the check that finds them (on To send,
// with progress and Cancel), its quiet result, and the review cards for possible matches.
import { useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../../api/client";
import Button from "../../components/Button";
import JobProgress from "../../components/JobProgress";
import MediaCard, { Thumb } from "../../components/MediaCard";
import { useToast } from "../../hooks/useToast";
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
      toast.error(err instanceof ApiError ? err.message : t("inaturalist.existing.failed"));
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
      toast.error(err instanceof ApiError ? err.message : t("inaturalist.existing.failed"));
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
      toast.error(err instanceof ApiError ? err.message : t("inaturalist.existing.failed"));
      return;
    }
    setGone((prev) => new Set([...prev].filter((k) => k !== key(m))));
    await onChanged();
  }

  if (list.length === 0) return <p className="py-8 text-body text-muted">{t("inaturalist.matches.empty")}</p>;
  return (
    <div className="space-y-item">
      <p className="text-subheadline text-muted">{t("inaturalist.matches.summary")}</p>
      <ul
        aria-label={t("inaturalist.matches.view")}
        className="grid items-start gap-3"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}
      >
        {list.slice(0, shown).map((m) => (
          <MediaCard
            key={key(m)}
            as="li"
            mediaClassName="aspect-[2/1]"
            media={
              <div className="grid h-full w-full grid-cols-2 gap-0.5">
                <figure className="relative">
                  {m.inatPhotoId ? (
                    <img
                      src={`/api/inaturalist/observations/${m.observationId}/photos/${m.inatPhotoId}`}
                      alt={t("inaturalist.matches.onInat")}
                      loading="lazy"
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  ) : (
                    <Thumb photoId={null} className="absolute inset-0" />
                  )}
                  <figcaption className="absolute inset-x-0 bottom-0 bg-surface/90 py-0.5 text-center text-caption font-medium text-ink">
                    {t("inaturalist.matches.onInat")}
                  </figcaption>
                </figure>
                <figure className="relative">
                  <Thumb photoId={m.photoId} className="absolute inset-0" />
                  <figcaption className="absolute inset-x-0 bottom-0 bg-surface/90 py-0.5 text-center text-caption font-medium text-ink">
                    {t("inaturalist.matches.yourPhoto")}
                  </figcaption>
                </figure>
              </div>
            }
            title={speciesName(m)}
            lines={[
              m.likeness ? t(LIKENESS_KEYS[m.likeness]) : t("inaturalist.matches.likeness.unknown"),
              [evidenceLine(t, m), m.takenAt ? formatDate(m.takenAt) : null].filter(Boolean).join(", "),
              <div key="actions" className="mt-2 flex flex-wrap items-center gap-2">
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
              </div>,
            ]}
            renderBody={({ className, children }) => <div className={className}>{children}</div>}
          />
        ))}
      </ul>
      {list.length > shown && (
        <Button variant="secondary" size="sm" onClick={() => setShown((n) => n + PAGE_SIZE)}>
          {t("manageList.showMore", { count: Math.min(PAGE_SIZE, list.length - shown) })}
        </Button>
      )}
    </div>
  );
}
