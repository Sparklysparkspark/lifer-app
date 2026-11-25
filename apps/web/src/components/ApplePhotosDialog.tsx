import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { JobStatus } from "@lifer/shared";
import Button from "./Button";
import FormMessage from "./FormMessage";
import JobProgress from "./JobProgress";
import Modal from "./Modal";
import { useJobPoll } from "../hooks/useJobPoll";

type SendStatus = JobStatus<unknown> & {
  mode: "check" | "send" | null;
  photos: number;
  found: number;
  notFound: number;
  added: number;
  unchanged: number;
  failed: number;
  problem: "automation_denied" | "photos_unavailable" | null;
};

const START = "/apple-photos/send";

/** Send keywords to Apple Photos: first finds the photos in Photos and says how many it found,
 *  then adds keywords only when the user confirms. Closing leaves a running job going. */
export default function ApplePhotosDialog({
  captureIds,
  albumId,
  onClose,
}: {
  captureIds?: string[];
  albumId?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const job = useJobPoll<SendStatus>("/apple-photos/send/status");
  const started = useRef(false);
  const selection = albumId ? { albumId } : { captureIds };
  const check = () => void job.start(START, { mode: "check", ...selection });

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    check();
    // Runs once on open; the selection doesn't change while the dialog is up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const s = job.status;
  const ready = s && !s.running && !job.starting && s.finishedAt != null;
  const problem =
    s?.problem === "automation_denied"
      ? t("applePhotos.denied")
      : s?.problem === "photos_unavailable"
        ? t("applePhotos.unavailable")
        : s?.error
          ? t("applePhotos.error")
          : (job.actionError ?? null);
  const checked = ready && !problem && s.mode === "check";
  const sent = ready && !problem && s.mode === "send";

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t("applePhotos.title")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t(sent ? "common.done" : "common.cancel")}
          </Button>
          {problem && <Button onClick={check}>{t("applePhotos.tryAgain")}</Button>}
          {checked && (
            <Button disabled={s.found === 0} onClick={() => void job.start(START, { mode: "send", ...selection })}>
              {t("applePhotos.send")}
            </Button>
          )}
        </>
      }
    >
      {s?.running || job.starting || !s ? (
        <JobProgress
          compact
          status={s?.running ? s : null}
          phases={{ finding: t("applePhotos.checking"), sending: t("applePhotos.sending") }}
          fallbackLabel={t("applePhotos.checking")}
          onCancel={() => job.cancel("/apple-photos/send/cancel")}
          cancelling={job.cancelling}
        />
      ) : problem ? (
        <FormMessage error={problem} />
      ) : (
        <div className="space-y-2 text-callout">
          {checked && s.found === 0 ? (
            <p>{t("applePhotos.noneFound")}</p>
          ) : (
            <>
              <p className="text-ink">
                {sent ? t("applePhotos.done", { count: s.added }) : t("applePhotos.found", { count: s.found })}
              </p>
              {checked && <p className="text-muted">{t("applePhotos.explain")}</p>}
              {sent && s.unchanged > 0 && (
                <p className="text-muted">{t("applePhotos.unchanged", { count: s.unchanged })}</p>
              )}
              {s.notFound > 0 && <p className="text-muted">{t("applePhotos.notFound", { count: s.notFound })}</p>}
              {sent && s.failed > 0 && <FormMessage error={t("applePhotos.failed", { count: s.failed })} />}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
