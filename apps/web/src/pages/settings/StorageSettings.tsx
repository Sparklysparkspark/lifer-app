import { useEffect, useState } from "react";
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
import { pluralize } from "../../lib/pluralize";
import { tauriInvoke } from "../../lib/tauri";
import { SettingRow, SettingsGroup, inputClass } from "./shared";

export default function StorageSettings() {
  return (
    <>
      <SettingsGroup title="Where photos live">
        <StorageLocationRow />
        <StorageVolumesRows />
      </SettingsGroup>
      <RemoveAllDataSection />
    </>
  );
}

// Only a desktop API can move the library; a server's folder is whatever LIFER_STORAGE_DIR mounts at /data.
function StorageLocationRow() {
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
      title: "Move your photo library?",
      message: `Move your photo library from ${currentDataDir} to ${newPath}? This moves every file and updates Lifer's records to match.`,
      confirmLabel: "Move library",
    });
    if (!ok) return;
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.put("/settings/storage", { dataDir: newPath });
      // The desktop shell starts the API from its own config, so it has to hear about the move
      // or the next launch opens the old, now-empty folder.
      try {
        await window.liferSetup?.setLocalDataDir?.(res.dataDir ?? newPath);
      } catch (err) {
        setError(
          `Your library was moved, but Lifer couldn't save the new location for next launch (${String(err)}). After restarting, pick ${res.dataDir} again with the "Change Server / Library" menu item.`,
        );
      }
      setResult(
        res.filesMoved
          ? "Your library has been moved. Restart Lifer for the new location to take effect."
          : "Saved. Restart Lifer for the new location to take effect.",
      );
      setCurrentDataDir(res.dataDir ?? newPath);
      setBrowsing(false);
    } catch (err) {
      setError(errorMessage(err, "Couldn't move this library"));
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

  const path = (
    <span className="block truncate font-mono" title={currentDataDir ?? undefined}>
      {currentDataDir}
    </span>
  );

  if (!changeable) {
    return (
      <SettingRow
        label="Library folder"
        description={
          <>
            {path}
            <span className="mt-0.5 block">
              The folder inside the container. To move it, change LIFER_STORAGE_DIR in docker-compose and redeploy.
            </span>
          </>
        }
      />
    );
  }

  return (
    <SettingRow
      label="Library folder"
      description={path}
      control={
        !browsing && (
          <Button variant="secondary" size="sm" onClick={chooseFolder} loading={saving}>
            Move
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
      setError('Give this drive a name first (e.g. "Red 2TB drive")');
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
      if (res.readopted)
        setResult(`Recognized ${pluralize(res.readopted, "photo")} already on this drive from before.`);
      load();
    } catch (err) {
      setError(errorMessage(err, "Couldn't register that drive"));
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
      title: "Stop tracking this drive?",
      message:
        "Photos already imported from it stay in your library. This just stops Lifer from checking whether it's connected.",
      confirmLabel: "Stop tracking",
      danger: true,
    });
    if (ok) await mutate(() => api.delete(apiPath("/storage-volumes/{id}", { id })), "Couldn't remove that drive");
  }

  function setDefault(id: string) {
    void mutate(() => api.put(apiPath("/storage-volumes/{id}/default", { id }), {}), "Couldn't set the default drive");
  }

  async function rename(id: string) {
    if (!renameValue.trim()) return;
    if (
      await mutate(
        () => api.put(apiPath("/storage-volumes/{id}", { id }), { label: renameValue.trim() }),
        "Couldn't rename that drive",
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
          label="Extra library folders"
          description={
            volumes && volumes.length > 0
              ? "Set with LIFER_LIBRARY_ROOTS in your docker-compose setup."
              : "Folders on this server to import from and save to. None are set up yet."
          }
        >
          {!(volumes && volumes.length > 0) && (
            <ol className="list-decimal space-y-1 pl-5 text-xs text-muted">
              <li>
                Bind-mount the host folder into the container, e.g. <code>/srv/photos:/library/nas</code>.
              </li>
              <li>
                Set <code>LIFER_LIBRARY_ROOTS=NAS=/library/nas</code> (comma-separate several, as
                Label=/container/path).
              </li>
              <li>Redeploy the container.</li>
            </ol>
          )}
        </SettingRow>
        {volumes?.map((v) => (
          <SettingRow
            key={v.id}
            label={v.label}
            description={<span className="block truncate">{v.rootPath ?? v.mountPath}</span>}
            control={<ConnectedLabel connected={v.connected} offline="Not found" />}
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
              <input
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && rename(v.id)}
                aria-label="Drive name"
                autoFocus
                className={inputClass}
              />
            }
            control={
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={() => rename(v.id)}>
                  Save
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setRenamingId(null)}>
                  Cancel
                </Button>
              </div>
            }
          />
        ) : (
          <SettingRow
            key={v.id}
            label={v.isDefault ? `${v.label} (default)` : v.label}
            description={
              <>
                <ConnectedLabel connected={v.connected} />
                {" · "}
                {v.connected ? v.mountPath : `Last seen ${formatDate(v.lastSeenAt, "dateTime") || "unknown"}`}
                {v.managedByEnv && " · Set by LIFER_LIBRARY_ROOTS"}
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
                    Rename
                  </Button>
                  {!v.isDefault && (
                    <Button variant="secondary" size="sm" onClick={() => setDefault(v.id)}>
                      Make default
                    </Button>
                  )}
                  <Button variant="secondary" size="sm" onClick={() => remove(v.id)}>
                    Remove
                  </Button>
                </div>
              )
            }
          />
        ),
      )}

      <SettingRow
        label="External drives"
        description="Photos on a registered drive keep their thumbnails while it's unplugged, so you know which drive to grab."
        control={
          !browsing &&
          !pendingPath && (
            <Button variant="secondary" size="sm" onClick={chooseFolder}>
              Add a drive
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
            <p className="truncate font-mono text-xs text-muted">{pendingPath}</p>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Name this drive (e.g. Red 2TB drive)"
              aria-label="Drive name"
              className={`${inputClass} max-w-sm`}
            />
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={registerThisFolder} loading={saving}>
                Add drive
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setPendingPath(null);
                  setLabel("");
                }}
              >
                Cancel
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
      setError(errorMessage(err, "Lifer couldn't remove its data."));
      setRemoving(false);
    }
  };

  return (
    <SettingsGroup title="Uninstall">
      <SettingRow
        label="Remove all Lifer data"
        description="Deletes everything Lifer keeps on this computer, then quits. Your photos stay where they are."
        control={
          !open && (
            <Button variant="danger" size="sm" onClick={() => setOpen(true)}>
              Remove
            </Button>
          )
        }
      >
        {open && (
          <div className="space-y-3 text-sm text-ink">
            <p>This deletes, from this computer:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                Lifer's database: your collection, seen and target species, albums, trips, tags, ratings and notes
              </li>
              <li>Thumbnails, downloaded models, offline packs and the offline map</li>
              <li>Lifer's settings, logs and caches</li>
            </ul>
            <p>
              <strong>Your photos are not deleted.</strong>
              {libraryFolder ? (
                <>
                  {" "}
                  They stay in <code className="break-all">{libraryFolder}</code>.
                </>
              ) : null}{" "}
              Reimporting that folder on a fresh install brings back your species, albums, trips, tags and ratings. Only
              Lifer's settings are lost.
            </p>
            <label className="block">
              Type <strong>{REMOVE_CONFIRM_WORD}</strong> to confirm
              <input
                className={`${inputClass} mt-1 max-w-xs`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                aria-label={`Type ${REMOVE_CONFIRM_WORD} to confirm`}
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
                Remove everything and quit
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
                Cancel
              </Button>
            </div>
            <FormMessage error={error} />
          </div>
        )}
      </SettingRow>
    </SettingsGroup>
  );
}

function ConnectedLabel({ connected, offline = "Not connected" }: { connected: boolean; offline?: string }) {
  return (
    <span className={`text-xs ${connected ? "text-green-700 dark:text-green-400" : "text-muted"}`}>
      {connected ? "Connected" : offline}
    </span>
  );
}
