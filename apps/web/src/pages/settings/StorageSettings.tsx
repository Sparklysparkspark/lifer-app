import { useEffect, useState } from "react";
import type { StorageVolume } from "@lifer/shared";
import { api } from "../../api/client";
import Button from "../../components/Button";
import { FolderBrowser, pickFolderNative } from "../../components/FolderPicker";
import FormMessage from "../../components/FormMessage";
import { useConfirm } from "../../hooks/useConfirm";
import { useDeploymentMode } from "../../hooks/useDeploymentMode";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { formatDate } from "../../lib/formatDate";
import { pluralize } from "../../lib/pluralize";
import { Card, inputClass } from "./shared";

export default function StorageSettings() {
  return (
    <>
      <StorageLocationSection />
      <StorageVolumesSection />
    </>
  );
}

// Only a desktop API can move the library; a server's folder is whatever LIFER_STORAGE_DIR mounts at /data.
function StorageLocationSection() {
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
      .get<{ dataDir: string; changeable: boolean }>("/settings/storage")
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
      const res = await api.put<{ dataDir: string; filesMoved: boolean }>("/settings/storage", { dataDir: newPath });
      // The desktop shell starts the API from its own config, so it has to hear about the move
      // or the next launch opens the old, now-empty folder.
      try {
        await window.liferSetup?.setLocalDataDir?.(res.dataDir);
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
      setCurrentDataDir(res.dataDir);
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

  if (!changeable) {
    return (
      <Card title="Storage location" description="Where your photo library lives, so you can find all the files." learnMore="storage-location">
        <p className="text-sm text-ink">
          Library folder: <code className="text-xs">{currentDataDir}</code>
        </p>
        <p className="text-xs text-muted">
          This is the folder inside the container. On the host it's whatever LIFER_STORAGE_DIR points at in your docker-compose setup
          (it's bind-mounted here). To move your library, change LIFER_STORAGE_DIR and redeploy.
        </p>
      </Card>
    );
  }

  return (
    <Card title="Storage location" description="Where your photo library lives, so you can find all the files." learnMore="storage-location">
      <p className="text-sm text-ink">
        Currently: <code className="text-xs">{currentDataDir}</code>
      </p>
      {!browsing ? (
        <Button variant="secondary" size="sm" onClick={chooseFolder} loading={saving}>
          Choose a different folder…
        </Button>
      ) : (
        <FolderBrowser onChoose={moveTo} onCancel={() => setBrowsing(false)} />
      )}
      <FormMessage error={error} success={result} />
    </Card>
  );
}

// Desktop: register external drives with their live connected state. Server: a read-only list of
// LIFER_LIBRARY_ROOTS, which are configured in docker-compose.
function StorageVolumesSection() {
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
      .get<{ volumes: StorageVolume[] }>("/storage-volumes")
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
      const res = await api.post<{ readopted?: number }>("/storage-volumes", { path: pendingPath, label: label.trim() });
      setPendingPath(null);
      setLabel("");
      if (res.readopted) setResult(`Recognized ${pluralize(res.readopted, "photo")} already on this drive from before.`);
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
      message: "Photos already imported from it stay in your library. This just stops Lifer from checking whether it's connected.",
      confirmLabel: "Stop tracking",
      danger: true,
    });
    if (ok) await mutate(() => api.delete(`/storage-volumes/${id}`), "Couldn't remove that drive");
  }

  function setDefault(id: string) {
    void mutate(() => api.put(`/storage-volumes/${id}/default`, {}), "Couldn't set the default drive");
  }

  async function rename(id: string) {
    if (!renameValue.trim()) return;
    if (await mutate(() => api.put(`/storage-volumes/${id}`, { label: renameValue.trim() }), "Couldn't rename that drive")) {
      setRenamingId(null);
    }
  }

  if (!available) return null;

  if (!isDesktopApi) {
    return (
      <Card
        title="Library folders"
        learnMore="library-folders"
        description="Extra folders on this server that Lifer can import from, build trips from, and save photos to, alongside the main library folder."
      >
        {volumes && volumes.length > 0 ? (
          <ul className="space-y-2">
            {volumes.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="text-ink">{v.label}</p>
                  <p className="truncate text-xs text-muted">{v.rootPath ?? v.mountPath}</p>
                </div>
                <ConnectedLabel connected={v.connected} offline="Not found" />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted">No extra folders are set up. To add one:</p>
        )}
        {volumes && volumes.length > 0 ? (
          <p className="text-xs text-muted">Configured by LIFER_LIBRARY_ROOTS in your docker-compose setup.</p>
        ) : (
          <ol className="list-decimal space-y-1 pl-5 text-xs text-muted">
            <li>
              Bind-mount the host folder into the container, e.g. <code>/srv/photos:/library/nas</code>.
            </li>
            <li>
              Set <code>LIFER_LIBRARY_ROOTS=NAS=/library/nas</code> (comma-separate several, as Label=/container/path).
            </li>
            <li>Redeploy the container.</li>
          </ol>
        )}
      </Card>
    );
  }

  return (
    <Card
      title="External drives"
      learnMore="external-drives"
      description="Register a drive that holds part of your photo library. Lifer will show its photos with a thumbnail even when the drive isn't plugged in, so you can tell which drive to go grab."
    >
      {volumes && volumes.length > 0 && (
        <ul className="space-y-2">
          {volumes.map((v) => (
            <li key={v.id} className="rounded-md border border-line px-3 py-2 text-sm">
              {renamingId === v.id ? (
                // Its own two-row layout: an input and plain text links don't line up in one row.
                <div className="space-y-2">
                  <input
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && rename(v.id)}
                    aria-label="Drive name"
                    autoFocus
                    className={`${inputClass} w-full`}
                  />
                  <div className="flex items-center justify-between">
                    <div className="flex gap-3">
                      <button type="button" onClick={() => rename(v.id)} className="text-xs text-accent hover:underline">
                        Save
                      </button>
                      <button type="button" onClick={() => setRenamingId(null)} className="text-xs text-muted hover:underline">
                        Cancel
                      </button>
                    </div>
                    <ConnectedLabel connected={v.connected} />
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="text-ink">
                      {v.label}
                      {v.isDefault && (
                        <span className="ml-2 inline-block rounded-full bg-surface-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                          Default
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-muted">
                      {v.connected ? v.mountPath : `Last seen: ${formatDate(v.lastSeenAt, "dateTime") || "unknown"}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <ConnectedLabel connected={v.connected} />
                    {v.managedByEnv ? (
                      <span className="text-xs text-muted">Configured by LIFER_LIBRARY_ROOTS</span>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setRenamingId(v.id);
                            setRenameValue(v.label);
                          }}
                          className="text-xs text-muted hover:underline"
                        >
                          Rename
                        </button>
                        {!v.isDefault && (
                          <button type="button" onClick={() => setDefault(v.id)} className="text-xs text-muted hover:underline">
                            Set as default
                          </button>
                        )}
                        <button type="button" onClick={() => remove(v.id)} className="text-xs text-muted hover:underline">
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {!browsing && !pendingPath ? (
        <Button variant="secondary" size="sm" onClick={chooseFolder}>
          Add a drive…
        </Button>
      ) : browsing && !pendingPath ? (
        <FolderBrowser
          onChoose={(path) => {
            setBrowsing(false);
            setPendingPath(path);
          }}
          onCancel={() => setBrowsing(false)}
        />
      ) : (
        <div className="space-y-2 rounded-md border border-line p-3">
          <p className="truncate text-xs text-muted">{pendingPath}</p>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Name this drive (e.g. Red 2TB drive)"
            className={inputClass}
          />
          <div className="flex gap-2 pt-1">
            <Button onClick={registerThisFolder} loading={saving}>
              Register this folder
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
        </div>
      )}
      <FormMessage error={error} success={result} />
    </Card>
  );
}

function ConnectedLabel({ connected, offline = "Not connected" }: { connected: boolean; offline?: string }) {
  return <span className={`text-xs ${connected ? "text-green-700 dark:text-green-400" : "text-muted"}`}>{connected ? "Connected" : offline}</span>;
}
