// Settings > Integrations > Immich, on a server only: link an Immich server, pick the albums to
// bring in, choose whether species tags go back, and sync in the background.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type ApiResponse } from "../../api/client";
import Button from "../../components/Button";
import Checkbox from "../../components/Checkbox";
import FormMessage from "../../components/FormMessage";
import JobProgress from "../../components/JobProgress";
import PasswordInput from "../../components/PasswordInput";
import Switch from "../../components/Switch";
import TextField from "../../components/TextField";
import { useDeploymentMode } from "../../hooks/useDeploymentMode";
import { useJobPoll } from "../../hooks/useJobPoll";
import { errorMessage } from "../../lib/errorMessage";
import { formatRelativeTime } from "../../lib/format";
import { SettingRow, SettingsGroup } from "./shared";

const IMMICH = "Immich";

type Status = ApiResponse<"/immich/status">;
type Album = ApiResponse<"/immich/albums">[number];
type SyncStatus = ApiResponse<"/immich/sync/status">;

export default function ImmichSettings() {
  const mode = useDeploymentMode();
  const [status, setStatus] = useState<Status | null>(null);

  const load = useCallback(() => {
    api
      .get("/immich/status")
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  useEffect(() => {
    if (mode === "server") load();
  }, [mode, load]);

  if (mode !== "server" || !status) return null;
  return (
    <SettingsGroup title={IMMICH}>
      {status.linked ? <Linked status={status} onChanged={load} /> : <LinkForm onLinked={load} />}
    </SettingsGroup>
  );
}

function LinkForm({ onLinked }: { onLinked: () => void }) {
  const { t } = useTranslation();
  const [serverUrl, setServerUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function link() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/immich/link", { serverUrl, apiKey });
      onLinked();
    } catch (err) {
      setError(errorMessage(err, t("settings.immich.linkFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingRow
      label={t("settings.immich.server")}
      description={t("settings.immich.linkDescription")}
      control={
        <Button size="sm" onClick={() => void link()} loading={busy} disabled={!serverUrl.trim() || !apiKey.trim()}>
          {t("settings.immich.link")}
        </Button>
      }
    >
      <TextField
        aria-label={t("settings.immich.addressLabel")}
        placeholder={t("settings.immich.addressPlaceholder")}
        value={serverUrl}
        onChange={(e) => setServerUrl(e.target.value)}
        type="url"
        autoComplete="url"
        className="w-full"
      />
      <PasswordInput
        ariaLabel={t("settings.immich.keyLabel")}
        placeholder={t("settings.immich.keyLabel")}
        value={apiKey}
        onChange={setApiKey}
        autoComplete="off"
        className="w-full"
      />
      <p className="text-footnote text-muted">{t("settings.immich.keyHelp")}</p>
      <FormMessage error={error} />
    </SettingRow>
  );
}

function Linked({ status, onChanged }: { status: Status; onChanged: () => void }) {
  const { t } = useTranslation();
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [albumsError, setAlbumsError] = useState<string | null>(null);
  const [chosen, setChosen] = useState(status.albumIds);
  const [writeTags, setWriteTags] = useState(status.writeTags);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  const job = useJobPoll<SyncStatus>("/immich/sync/status", { onFinish: onChanged });

  useEffect(() => {
    api
      .get("/immich/albums")
      .then(setAlbums)
      .catch((err) => setAlbumsError(errorMessage(err, t("settings.immich.albumsFailed"))));
  }, [t]);

  async function save(body: { albumIds?: string[]; writeTags?: boolean }, undo: () => void) {
    setSaveError(null);
    try {
      await api.put("/immich/settings", body);
    } catch (err) {
      undo();
      setSaveError(errorMessage(err, t("settings.immich.saveFailed")));
    }
  }

  function toggleAlbum(id: string, on: boolean) {
    const before = chosen;
    const next = on ? [...chosen, id] : chosen.filter((a) => a !== id);
    setChosen(next);
    void save({ albumIds: next }, () => setChosen(before));
  }

  function toggleTags(on: boolean) {
    setWriteTags(on);
    void save({ writeTags: on }, () => setWriteTags(!on));
  }

  async function unlink() {
    setUnlinking(true);
    try {
      await api.delete("/immich/link");
      onChanged();
    } catch (err) {
      setSaveError(errorMessage(err, t("settings.immich.unlinkFailed")));
      setUnlinking(false);
    }
  }

  const { counts } = status;
  const running = !!job.status?.running;
  const summary = [
    status.lastSyncAt
      ? t("settings.immich.lastSynced", { when: formatRelativeTime(status.lastSyncAt) })
      : t("settings.immich.neverSynced"),
    counts.imported > 0 && t("settings.immich.imported", { count: counts.imported }),
    counts.unrecognized > 0 && t("settings.immich.unrecognized", { count: counts.unrecognized }),
    counts.skipped > 0 && t("settings.immich.skipped", { count: counts.skipped }),
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <SettingRow
        label={t("settings.immich.server")}
        description={<span className="break-all">{t("settings.immich.linkedTo", { url: status.serverUrl })}</span>}
        control={
          <Button variant="secondary" size="sm" onClick={() => void unlink()} loading={unlinking} disabled={running}>
            {t("settings.immich.unlink")}
          </Button>
        }
      />
      <SettingRow
        label={t("settings.immich.albums")}
        description={t("settings.immich.albumsChosen", { count: chosen.length })}
      >
        {albumsError ? (
          <FormMessage error={albumsError} />
        ) : albums?.length === 0 ? (
          <p className="text-subheadline text-muted">{t("settings.immich.noAlbums")}</p>
        ) : (
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {albums?.map((album) => (
              <Checkbox
                key={album.id}
                checked={chosen.includes(album.id)}
                onChange={(on) => toggleAlbum(album.id, on)}
                description={t("settings.immich.albumCount", { count: album.assetCount })}
                labelClassName="break-words"
              >
                {album.name}
              </Checkbox>
            ))}
          </div>
        )}
      </SettingRow>
      <SettingRow
        label={t("settings.immich.writeTags")}
        description={t("settings.immich.writeTagsDescription")}
        control={<Switch label={t("settings.immich.writeTags")} checked={writeTags} onChange={toggleTags} />}
      />
      <SettingRow
        label={t("settings.immich.sync")}
        description={summary}
        control={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void job.start("/immich/sync")}
            loading={job.starting}
            disabled={running || chosen.length === 0}
          >
            {t("settings.immich.syncNow")}
          </Button>
        }
      >
        {(running || job.status?.error || job.status?.cancelled || job.actionError || status.lastError) && (
          <JobProgress
            status={job.status}
            phases={{
              listing: t("settings.immich.listing"),
              importing: { label: t("settings.immich.importing"), progress: "count" },
              tagging: t("settings.immich.tagging"),
            }}
            onCancel={() => void job.cancel("/immich/sync/cancel")}
            cancelling={job.cancelling}
            error={job.actionError ?? status.lastError}
          />
        )}
        {saveError && <FormMessage error={saveError} />}
      </SettingRow>
    </>
  );
}
