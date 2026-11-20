import { useEffect, useState } from "react";
import { matches } from "../../lib/keymap";
import { Trans, useTranslation } from "react-i18next";
import type { StorageVolume } from "@lifer/shared";
import { api, apiPath } from "../../api/client";
import Button from "../../components/Button";
import { FolderBrowser } from "../../components/FolderPicker";
import { pickFolderNative } from "../../lib/pickFolderNative";
import FormMessage from "../../components/FormMessage";
import { useConfirm } from "../../hooks/useConfirm";
import { useDeploymentMode, useIsTauri } from "../../hooks/useDeploymentMode";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { formatDate } from "../../lib/format";
import { ignore } from "../../lib/ignore";
import { tauriInvoke } from "../../lib/tauri";
import { changeLibraryFolder } from "../../lib/libraryFolderChange";
import TextField from "../../components/TextField";
import { SettingRow, SettingsGroup } from "./shared";
import FolderPath from "../../components/FolderPath";
import ArchiveHealthRows from "./ArchiveHealthRows";
import MovedPhotosGroup from "./MovedPhotosGroup";

export default function StorageSettings() {
  const { t } = useTranslation();
  return (
    <>
      <SettingsGroup title={t("settings.storage.title")}>
        <StorageLocationRow />
        <StorageVolumesRows />
        <ArchiveHealthRows />
      </SettingsGroup>
      <MovedPhotosGroup />
      <RemoveAllDataSection />
    </>
  );
}

// Only a desktop API can move the library; a server's folder is whatever LIFER_STORAGE_DIR mounts at /data.
function StorageLocationRow() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [available, setAvailable] = useState(false);
  const [changeable, setChangeable] = useState(false);
  const [currentDataDir, setCurrentDataDir] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    api
      .get("/settings/storage")
      .then((res) => {
        setAvailable(true);
        setChangeable(res.changeable);
        setCurrentDataDir(res.dataDir);
      })
      .catch(() => setAvailable(false));
  }, []);

  async function moveTo(newPath: string) {
    const ok = await confirm({
      title: t("settings.storage.location.moveConfirm.title"),
      message: `${t("settings.storage.location.moveConfirm.message", { from: currentDataDir, to: newPath })} ${t("settings.storage.location.restartWarning")}`,
      confirmLabel: t("settings.storage.location.moveConfirm.confirm"),
    });
    if (!ok) return;
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const outcome = await changeLibraryFolder(newPath);
      if (outcome.kind === "restarting") return;
      setBrowsing(false);
      if (outcome.kind === "importsRunning") setError(t("settings.storage.location.importsRunning"));
      else if (outcome.kind === "launchConfigFailed") {
        setCurrentDataDir(outcome.dataDir);
        setError(t("settings.storage.location.saveForLaunchFailed", { error: outcome.error, folder: outcome.dataDir }));
      } else {
        setCurrentDataDir(newPath);
        setResult(t(outcome.filesMoved ? "settings.storage.location.moved" : "settings.storage.location.saved"));
      }
    } catch (err) {
      setError(errorMessage(err, t("settings.storage.location.moveFailed")));
    } finally {
      setSaving(false);
    }
  }

  async function chooseFolder() {
    const native = await pickFolderNative();
    if (native === undefined) {
      setBrowsing(true);
      return;
    }
    if (native === null) return;
    await moveTo(native);
  }

  if (!available) return null;

  const path = currentDataDir ? <FolderPath path={currentDataDir} /> : null;

  if (!changeable) {
    return (
      <SettingRow
        label={t("settings.storage.location.label")}
        description={
          <>
            {path}
            <span className="mt-0.5 block">{t("settings.storage.location.containerHint")}</span>
          </>
        }
      />
    );
  }

  return (
    <SettingRow
      label={t("settings.storage.location.label")}
      description={path}
      control={
        !browsing && (
          <Button variant="secondary" size="sm" onClick={chooseFolder} loading={saving}>
            {t("settings.storage.location.move")}
          </Button>
        )
      }
    >
      {browsing && <FolderBrowser onChoose={moveTo} onCancel={() => setBrowsing(false)} />}
      {(error || result) && <FormMessage error={error} success={result} />}
    </SettingRow>
  );
}

// Desktop: register external drives with their live connected state. Server: a read-only list of
// LIFER_LIBRARY_ROOTS, which are configured in docker-compose.
function StorageVolumesRows() {
  const { t } = useTranslation();
  const isDesktopApi = useDeploymentMode() === "desktop";
  const confirm = useConfirm();
  const toast = useToast();
  const [available, setAvailable] = useState(false);
  const [volumes, setVolumes] = useState<StorageVolume[] | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  function load() {
    api
      .get("/storage-volumes")
      .then((res) => {
        setAvailable(true);
        setVolumes(res.volumes);
      })
      .catch(() => setAvailable(false));
  }
  useEffect(load, []);

  async function chooseFolder() {
    setError(null);
    const native = await pickFolderNative();
    if (native === undefined) {
      setBrowsing(true);
      return;
    }
    if (native === null) return;
    setPendingPath(native);
  }

  async function registerThisFolder() {
    if (!pendingPath) return;
    if (!label.trim()) {
      setError(t("settings.storage.drives.nameRequired"));
      return;
    }
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.post("/storage-volumes", {
        path: pendingPath,
        label: label.trim(),
      });
      setPendingPath(null);
      setLabel("");
      if (res.readopted) setResult(t("settings.storage.drives.readopted", { count: res.readopted }));
      load();
    } catch (err) {
      setError(errorMessage(err, t("settings.storage.drives.registerFailed")));
    } finally {
      setSaving(false);
    }
  }

  async function mutate(action: () => Promise<unknown>, failure: string) {
    try {
      await action();
      load();
      return true;
    } catch (err) {
      toast.error(errorMessage(err, failure));
      return false;
    }
  }

  async function remove(id: string) {
    const ok = await confirm({
      title: t("settings.storage.drives.removeConfirm.title"),
      message: t("settings.storage.drives.removeConfirm.message"),
      confirmLabel: t("settings.storage.drives.removeConfirm.confirm"),
      danger: true,
    });
    if (ok)
      await mutate(
        () => api.delete(apiPath("/storage-volumes/{id}", { id })),
        t("settings.storage.drives.removeFailed"),
      );
  }

  function setDefault(id: string) {
    void mutate(
      () => api.put(apiPath("/storage-volumes/{id}/default", { id }), {}),
      t("settings.storage.drives.setDefaultFailed"),
    );
  }

  async function rename(id: string) {
    if (!renameValue.trim()) return;
    if (
      await mutate(
        () => api.put(apiPath("/storage-volumes/{id}", { id }), { label: renameValue.trim() }),
        t("settings.storage.drives.renameFailed"),
      )
    ) {
      setRenamingId(null);
    }
  }

  if (!available) return null;

  if (!isDesktopApi) {
    return (
      <>
        <SettingRow
          label={t("settings.storage.roots.label")}
          description={t(
            volumes && volumes.length > 0 ? "settings.storage.roots.configured" : "settings.storage.roots.none",
          )}
        >
          {!(volumes && volumes.length > 0) && (
            <ol className="list-decimal space-y-1 pl-5 text-footnote text-muted">
              <li>
                <Trans i18nKey="settings.storage.roots.stepMount" components={{ code: <code /> }} />
              </li>
              <li>
                <Trans i18nKey="settings.storage.roots.stepSet" components={{ code: <code /> }} />
              </li>
              <li>{t("settings.storage.roots.stepRedeploy")}</li>
            </ol>
          )}
        </SettingRow>
        {volumes?.map((v) => (
          <SettingRow
            key={v.id}
            label={v.label}
            description={<span className="block truncate">{v.rootPath ?? v.mountPath}</span>}
            control={<ConnectedLabel connected={v.connected} offline={t("settings.storage.drives.notFound")} />}
          />
        ))}
      </>
    );
  }

  return (
    <>
      {volumes?.map((v) =>
        renamingId === v.id ? (
          <SettingRow
            key={v.id}
            label={
              <TextField
                size="sm"
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => matches(e, "confirm") && rename(v.id)}
                aria-label={t("settings.storage.drives.nameLabel")}
                autoFocus
              />
            }
            control={
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => rename(v.id)}>
                  {t("common.save")}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setRenamingId(null)}>
                  {t("common.cancel")}
                </Button>
              </div>
            }
          />
        ) : (
          <SettingRow
            key={v.id}
            label={v.isDefault ? t("settings.storage.drives.defaultLabel", { name: v.label }) : v.label}
            description={
              <>
                <ConnectedLabel connected={v.connected} />
                {" · "}
                {v.connected
                  ? v.mountPath
                  : t("settings.storage.drives.lastSeen", {
                      date: formatDate(v.lastSeenAt, "dateTime") || t("settings.storage.drives.lastSeenUnknown"),
                    })}
                {v.managedByEnv && ` · ${t("settings.storage.drives.managedByEnv")}`}
              </>
            }
            control={
              !v.managedByEnv && (
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setRenamingId(v.id);
                      setRenameValue(v.label);
                    }}
                  >
                    {t("common.rename")}
                  </Button>
                  {!v.isDefault && (
                    <Button variant="secondary" size="sm" onClick={() => setDefault(v.id)}>
                      {t("settings.storage.drives.makeDefault")}
                    </Button>
                  )}
                  <Button variant="secondary" size="sm" onClick={() => remove(v.id)}>
                    {t("settings.storage.drives.remove")}
                  </Button>
                </div>
              )
            }
          />
        ),
      )}

      <SettingRow
        label={t("settings.storage.drives.label")}
        description={t("settings.storage.drives.description")}
        control={
          !browsing &&
          !pendingPath && (
            <Button variant="secondary" size="sm" onClick={chooseFolder}>
              {t("settings.storage.drives.add")}
            </Button>
          )
        }
      >
        {browsing && !pendingPath && (
          <FolderBrowser
            onChoose={(path) => {
              setBrowsing(false);
              setPendingPath(path);
            }}
            onCancel={() => setBrowsing(false)}
          />
        )}
        {pendingPath && (
          <>
            <FolderPath path={pendingPath} className="text-footnote" />
            <TextField
              size="sm"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("settings.storage.drives.namePlaceholder")}
              aria-label={t("settings.storage.drives.nameLabel")}
              className="max-w-sm"
            />
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={registerThisFolder} loading={saving}>
                {t("settings.storage.drives.addConfirm")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setPendingPath(null);
                  setLabel("");
                }}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </>
        )}
        {(error || result) && <FormMessage error={error} success={result} />}
      </SettingRow>
    </>
  );
}

const REMOVE_CONFIRM_WORD = "remove";

// The desktop app's local library only: the command refuses any other page (remove_data.rs), so a
// connected server's Settings never shows it. Everything Lifer keeps on this computer goes, then the
// app quits; photo library folders are never touched.
export function RemoveAllDataSection() {
  const { t } = useTranslation();
  const isDesktopLibrary = useDeploymentMode() === "desktop";
  const isTauri = useIsTauri();
  const [libraryFolder, setLibraryFolder] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isDesktopLibrary || !isTauri) return;
    api
      .get("/settings/storage")
      .then((res) => setLibraryFolder(res.dataDir))
      .catch(ignore("Couldn't read the library folder"));
  }, [isDesktopLibrary, isTauri]);

  if (!isDesktopLibrary || !isTauri) return null;

  const remove = async () => {
    const invoke = tauriInvoke();
    if (!invoke) return;
    setRemoving(true);
    setError(null);
    try {
      // The app quits once it's done, so success never comes back here.
      await invoke("remove_all_data");
    } catch (err) {
      setError(errorMessage(err, t("settings.storage.removeAll.failed")));
      setRemoving(false);
    }
  };

  return (
    <SettingsGroup title={t("settings.storage.removeAll.group")}>
      <SettingRow
        label={t("settings.storage.removeAll.label")}
        description={t("settings.storage.removeAll.description")}
        control={
          !open && (
            <Button variant="danger" size="sm" onClick={() => setOpen(true)}>
              {t("settings.storage.removeAll.open")}
            </Button>
          )
        }
      >
        {open && (
          <div className="space-y-3 text-callout text-ink">
            <p>{t("settings.storage.removeAll.listIntro")}</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>{t("settings.storage.removeAll.listDatabase")}</li>
              <li>{t("settings.storage.removeAll.listDownloads")}</li>
              <li>{t("settings.storage.removeAll.listSettings")}</li>
            </ul>
            <p>
              <strong>{t("settings.storage.removeAll.photosKept")}</strong>
              {libraryFolder ? (
                <>
                  {" "}
                  <Trans
                    i18nKey="settings.storage.removeAll.photosFolder"
                    values={{ folder: libraryFolder }}
                    components={{ code: <code className="break-all" /> }}
                  />
                </>
              ) : null}{" "}
              {t("settings.storage.removeAll.reimportHint")}
            </p>
            <label className="block">
              <Trans
                i18nKey="settings.storage.removeAll.typeToConfirm"
                values={{ word: REMOVE_CONFIRM_WORD }}
                components={{ b: <strong /> }}
              />
              <TextField
                className="mt-1 max-w-xs"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                aria-label={t("settings.storage.removeAll.typeToConfirmLabel", { word: REMOVE_CONFIRM_WORD })}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="danger"
                size="sm"
                disabled={typed.trim().toLowerCase() !== REMOVE_CONFIRM_WORD}
                loading={removing}
                onClick={() => void remove()}
              >
                {t("settings.storage.removeAll.confirm")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={removing}
                onClick={() => {
                  setOpen(false);
                  setTyped("");
                }}
              >
                {t("common.cancel")}
              </Button>
            </div>
            <FormMessage error={error} />
          </div>
        )}
      </SettingRow>
    </SettingsGroup>
  );
}

function ConnectedLabel({ connected, offline }: { connected: boolean; offline?: string }) {
  const { t } = useTranslation();
  return (
    <span className={`text-footnote ${connected ? "text-green-700 dark:text-green-400" : "text-muted"}`}>
      {connected ? t("settings.storage.drives.connected") : (offline ?? t("settings.storage.drives.notConnected"))}
    </span>
  );
}
