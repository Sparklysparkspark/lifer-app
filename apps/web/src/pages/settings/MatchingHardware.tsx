import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import { errorMessage } from "../../lib/errorMessage";
import { formatBytes } from "../../lib/format";
import { SettingRow } from "./shared";

interface HardwareStatus {
  state: "idle" | "testing" | "downloading" | "done" | "failed";
  message: string | null;
  progress: { done: number; total: number | null } | null;
  models: Array<{ family: "detector" | "id" | "clip"; backend: string; ms: number; cpuMs: number }>;
  device: string | null;
  testedAt: string | null;
}

const POLL_MS = 2000;

/** Where species matching runs (the CPU or a GPU the self-test chose) and how fast. */
export default function MatchingHardware() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<HardwareStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const busy = status?.state === "testing" || status?.state === "downloading";

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A failed poll mid-test retries rather than leaving the panel stuck on "testing".
    let polling = false;
    const load = () =>
      api
        .get<HardwareStatus>("/species/matching-hardware")
        .then((s) => {
          if (!live) return;
          setStatus(s);
          polling = s.state === "testing" || s.state === "downloading";
          if (polling) timer = setTimeout(load, POLL_MS);
        })
        .catch(() => {
          if (live && polling) timer = setTimeout(load, POLL_MS);
        });
    load();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [starting]);

  async function retest() {
    setError(null);
    setStarting(true);
    try {
      setStatus(await api.post<HardwareStatus>("/species/matching-hardware/retest"));
    } catch (err) {
      setError(errorMessage(err, t("settings.matchingHardware.retestFailed")));
    } finally {
      setStarting(false);
    }
  }

  if (!status || status.state === "idle") return null;
  // The identification model is the slow one, so it stands for the whole.
  const main = status.models.find((m) => m.family === "id") ?? status.models[0];
  const onGpu = status.models.some((m) => m.backend !== "cpu");
  const step = status.message ?? t("settings.matchingHardware.checking");
  const progress = status.progress && status.progress.done > 0 ? status.progress : null;

  return (
    <SettingRow
      label={t("settings.matchingHardware.label")}
      description={
        busy
          ? t("settings.matchingHardware.busy", {
              step: !progress
                ? step
                : progress.total
                  ? t("settings.matchingHardware.progressOf", {
                      step,
                      done: formatBytes(progress.done),
                      total: formatBytes(progress.total),
                    })
                  : t("settings.matchingHardware.progress", { step, done: formatBytes(progress.done) }),
            })
          : status.state === "failed"
            ? t("settings.matchingHardware.failed", { message: status.message })
            : onGpu && main
              ? t(status.device ? "settings.matchingHardware.gpu" : "settings.matchingHardware.gpuUnnamed", {
                  device: status.device,
                  ms: Math.round(main.ms),
                  speedup: Math.max(1, main.cpuMs / main.ms).toFixed(1),
                })
              : t(status.models.length > 0 ? "settings.matchingHardware.cpuNoGpu" : "settings.matchingHardware.cpu")
      }
      control={
        <Button variant="secondary" size="sm" onClick={retest} loading={starting} disabled={busy}>
          {t("settings.matchingHardware.retest")}
        </Button>
      }
    >
      {error && <FormMessage error={error} />}
    </SettingRow>
  );
}
