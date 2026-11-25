import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api, type ApiResponse } from "../../api/client";
import Modal from "../../components/Modal";
import Button from "../../components/Button";
import TextField from "../../components/TextField";
import Select from "../../components/Select";
import SegmentedControl from "../../components/SegmentedControl";
import ProgressBar from "../../components/ProgressBar";
import FormMessage from "../../components/FormMessage";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { formatDate, formatNumber } from "../../lib/format";

type Preview = ApiResponse<"/captures/taken-at/preview", "post">;
type ShiftResult = NonNullable<ApiResponse<"/captures/taken-at/shift/status">["result"]>;
type Mode = "shift" | "set";

/** Starts a shift of the photos' time and waits for the background job. Undo runs it reversed. */
async function runTakenAtShift(
  captureIds: string[],
  minutes: number,
  onProgress?: (done: number, total: number) => void,
): Promise<ShiftResult> {
  await api.post("/captures/taken-at/shift", { captureIds, minutes });
  for (;;) {
    const status = await api.get("/captures/taken-at/shift/status");
    if (status.total) onProgress?.(status.processed ?? 0, status.total);
    if (!status.running) {
      if (status.error || !status.result) throw new Error(status.error ?? "The date change stopped");
      return status.result;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
// The value a datetime-local field takes, in the viewer's own zone like every date Lifer shows.
const toLocalInput = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
// The server's limit is about a century, so Days stops at 100 years.
const MAX_DAYS = 36500;
const whole = (value: string, max: number) => Math.min(max, Math.max(0, Math.floor(Number(value) || 0)));

/** Moves every selected photo's date and time by the same amount: typed as a difference, or as
 *  the correct time of one photo. Applying closes nothing until the job ends; Undo is in the toast. */
export default function AdjustTimeDialog({
  captureIds: selected,
  onClose,
  onChanged,
  scope,
}: {
  captureIds: string[];
  /** The viewer's "Apply to all photos in this burst" checkbox. */
  scope?: ReactNode;
  onClose: () => void;
  /** After the dates moved (and again after Undo): leave select mode, reload the photos. */
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  // The photos for the preview, the shift and its Undo: held from Apply on, as the selection clears.
  const [captureIds, setCaptureIds] = useState(selected);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("shift");
  const [direction, setDirection] = useState<"later" | "earlier">("later");
  const [days, setDays] = useState("0");
  const [hours, setHours] = useState("0");
  const [mins, setMins] = useState("0");
  const [correct, setCorrect] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // Follows the viewer's "Apply to all photos in this burst" until Apply.
  if (progress == null && selected.length > 0 && selected.join() !== captureIds.join()) setCaptureIds(selected);

  useEffect(() => {
    let live = true;
    api
      .post("/captures/taken-at/preview", { captureIds })
      .then((p) => {
        if (!live) return;
        setPreview(p);
        if (p.first) setCorrect(toLocalInput(new Date(p.first.takenAt)));
      })
      .catch((err) => live && setError(errorMessage(err, t("gallery.adjustTime.previewFailed"))));
    return () => {
      live = false;
    };
  }, [captureIds, t]);

  const firstAt = preview?.first ? Date.parse(preview.first.takenAt) : null;
  const minutes =
    mode === "shift"
      ? (direction === "later" ? 1 : -1) * (whole(days, MAX_DAYS) * 1440 + whole(hours, 23) * 60 + whole(mins, 59))
      : firstAt != null && correct
        ? Math.round((new Date(correct).getTime() - firstAt) / 60_000) || 0
        : 0;
  const running = progress != null;
  const moved = (iso: string | null) =>
    iso ? formatDate(new Date(Date.parse(iso) + minutes * 60_000), "dateTime") : "";

  async function apply() {
    setError(null);
    setProgress({ done: 0, total: captureIds.length });
    try {
      const result = await runTakenAtShift(captureIds, minutes, (done, total) => setProgress({ done, total }));
      onClose();
      onChanged();
      const notes = [
        result.undated > 0 && t("gallery.adjustTime.skipped", { count: result.undated }),
        result.filesFailed > 0 && t("gallery.adjustTime.filesFailed", { count: result.filesFailed }),
      ].filter(Boolean);
      toast.show([t("gallery.adjustTime.done", { count: result.shifted }), ...notes].join(" "), {
        tone: result.filesFailed > 0 ? "info" : "success",
        actions: [
          {
            label: t("gallery.adjustTime.undo"),
            onClick: () =>
              void runTakenAtShift(captureIds, -minutes)
                .then(() => toast.success(t("gallery.adjustTime.undone", { count: result.shifted })))
                .catch((err) => toast.error(errorMessage(err, t("gallery.adjustTime.undoFailed"))))
                .finally(onChanged),
          },
        ],
      });
    } catch (err) {
      setProgress(null);
      setError(errorMessage(err, t("gallery.adjustTime.failed")));
    }
  }

  const field = "flex flex-col gap-1 text-footnote text-muted";
  return (
    <Modal
      open
      onClose={onClose}
      title={t("gallery.adjustTime.title")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button loading={running} disabled={!preview?.dated || minutes === 0} onClick={() => void apply()}>
            {running ? t("gallery.adjustTime.applying") : t("gallery.adjustTime.apply")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-callout">
        {scope}
        <SegmentedControl
          size="md"
          value={mode}
          onChange={setMode}
          options={[
            { value: "shift", label: t("gallery.adjustTime.modeShift") },
            { value: "set", label: t("gallery.adjustTime.modeSet") },
          ]}
        />
        {mode === "shift" ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <label className={field}>
              {t("gallery.adjustTime.direction")}
              <Select
                variant="form"
                value={direction}
                onChange={(e) => setDirection(e.target.value as "later" | "earlier")}
              >
                <option value="later">{t("gallery.adjustTime.later")}</option>
                <option value="earlier">{t("gallery.adjustTime.earlier")}</option>
              </Select>
            </label>
            {(
              [
                [t("gallery.adjustTime.days"), days, setDays, MAX_DAYS],
                [t("gallery.adjustTime.hours"), hours, setHours, 23],
                [t("gallery.adjustTime.minutes"), mins, setMins, 59],
              ] as const
            ).map(([label, value, set, max]) => (
              <label key={label} className={field}>
                {label}
                <TextField
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={max}
                  value={value}
                  onChange={(e) => set(e.target.value)}
                />
              </label>
            ))}
          </div>
        ) : preview?.first ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              {preview.first.photoId && (
                <img
                  src={`/api/photos/${preview.first.photoId}/thumb`}
                  alt=""
                  className="h-16 w-16 shrink-0 rounded-control object-cover"
                />
              )}
              <p className="text-muted">
                {t("gallery.adjustTime.takenAt", { date: formatDate(preview.first.takenAt, "dateTime") })}
              </p>
            </div>
            <label className={field}>
              {t("gallery.adjustTime.correctTime")}
              <TextField type="datetime-local" value={correct} onChange={(e) => setCorrect(e.target.value)} />
            </label>
          </div>
        ) : null}

        {preview &&
          (preview.dated === 0 ? (
            <p className="text-muted">{t("gallery.adjustTime.noDates")}</p>
          ) : (
            <div className="text-muted">
              <p>
                {t("gallery.adjustTime.earliest", {
                  from: formatDate(preview.earliest, "dateTime"),
                  to: moved(preview.earliest),
                })}
              </p>
              {preview.dated > 1 && (
                <p>
                  {t("gallery.adjustTime.latest", {
                    from: formatDate(preview.latest, "dateTime"),
                    to: moved(preview.latest),
                  })}
                </p>
              )}
              <p className="mt-2 text-ink">
                {t("gallery.adjustTime.willChange", { count: preview.dated })}
                {preview.undated > 0 && ` ${t("gallery.adjustTime.skipped", { count: preview.undated })}`}
              </p>
            </div>
          ))}

        {progress && (
          <div className="flex flex-col gap-1 text-footnote text-muted">
            {t("ui.job.ofTotal", { done: formatNumber(progress.done), total: formatNumber(progress.total) })}
            <ProgressBar
              value={progress.total ? progress.done / progress.total : null}
              label={t("gallery.adjustTime.applying")}
            />
          </div>
        )}
        <FormMessage error={error} />
      </div>
    </Modal>
  );
}
