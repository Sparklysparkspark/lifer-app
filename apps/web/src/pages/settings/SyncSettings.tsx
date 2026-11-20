// The desktop app's sync with its linked server (apps/api/src/sync): what's been sent up, the
// mirror of the server's collection kept here, and the one option, which copy of each photo to
// keep. From the local library's own page the status comes straight from the local API; from the
// server's page it comes through the shell, since that page can't reach the local API.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import Switch from "../../components/Switch";
import { errorMessage } from "../../lib/errorMessage";
import { tauriInvoke } from "../../lib/tauri";
import { SettingRow, SettingsGroup } from "./shared";
import {
  describeLibraryPush,
  describeMirror,
  describePush,
  describeReason,
  describeWaiting,
  type SyncStatus,
} from "./syncStatusText";

const POLL_MS = 3000;

/** Rows for Settings > Server in the desktop app, on either side of the link. */
export default function SyncSettings({ onServer }: { onServer: boolean }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const invoke = tauriInvoke();

  const refresh = useCallback(async () => {
    try {
      const next = onServer
        ? ((await invoke?.("sync_status")) as SyncStatus | null)
        : ((await api.get("/sync/status")) as unknown as SyncStatus);
      setStatus(next ?? null);
    } catch {
      setStatus(null);
    }
  }, [onServer, invoke]);

  useEffect(() => {
    if (!invoke) return;
    const tick = () => void refresh();
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [invoke, refresh]);

  if (!invoke || !status?.linked) return null;

  async function syncNow() {
    setError(null);
    setBusy(true);
    try {
      if (onServer) await invoke!("sync_now");
      else {
        await api.post("/sync/push/start");
        await api.post("/sync/pull");
      }
      await refresh();
    } catch (err) {
      setError(errorMessage(err, t("settings.sync.startFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function setMedium(on: boolean) {
    const derivative = on ? "medium" : "thumb";
    setError(null);
    try {
      if (onServer) await invoke!("sync_set_derivative", { derivative });
      else {
        await api.post("/sync/settings", { derivative });
        await api.post("/sync/pull");
      }
      await refresh();
    } catch (err) {
      setError(errorMessage(err, t("settings.sync.derivativeFailed")));
    }
  }

  async function startOver() {
    setError(null);
    setBusy(true);
    try {
      if (onServer) await invoke!("sync_adopt");
      else {
        await api.post("/sync/adopt");
        await api.post("/sync/push/start");
      }
      await refresh();
    } catch (err) {
      setError(errorMessage(err, t("settings.sync.serverChanged.failed")));
    } finally {
      setBusy(false);
    }
  }

  const running = status.push.running || status.mirror.running || status.packs.running;
  return (
    <SettingsGroup title={t("settings.sync.title")}>
      <SettingRow
        label={t("settings.sync.linkedServer")}
        description={t("settings.sync.linkedDescription", {
          server: status.serverUrl ?? t("settings.sync.yourServer"),
        })}
        control={
          <Button variant="secondary" size="sm" onClick={syncNow} loading={busy || running}>
            {running ? t("settings.sync.syncing") : t("settings.sync.syncNow")}
          </Button>
        }
      >
        {describeReason(status) && <p className="text-footnote text-muted">{describeReason(status)}</p>}
        <p className="text-footnote text-muted">{describeMirror(status)}</p>
        {error && <FormMessage error={error} />}
      </SettingRow>
      <SettingRow label={t("settings.sync.photosLabel")} description={describeWaiting(status.waiting.photos)}>
        <p className="text-footnote text-muted">{describePush(status)}</p>
      </SettingRow>
      <SettingRow
        label={t("settings.sync.libraryLabel")}
        description={describeWaiting(status.waiting.albums + status.waiting.trips)}
      >
        <p className="text-footnote text-muted">{describeLibraryPush(status)}</p>
      </SettingRow>
      {status.serverChanged && (
        <SettingRow
          label={t("settings.sync.serverChanged.label")}
          description={t("settings.sync.serverChanged.description")}
          control={
            <Button variant="primary" size="sm" onClick={startOver} loading={busy}>
              {t("settings.sync.serverChanged.confirm")}
            </Button>
          }
        />
      )}
      <SettingRow
        label={t("settings.sync.medium.label")}
        description={t("settings.sync.medium.description")}
        control={
          <Switch
            label={t("settings.sync.medium.label")}
            checked={status.derivative === "medium"}
            onChange={setMedium}
          />
        }
      />
    </SettingsGroup>
  );
}
