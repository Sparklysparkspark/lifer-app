import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import InlineSpinner from "../../components/InlineSpinner";
import JobProgress from "../../components/JobProgress";
import PasswordInput from "../../components/PasswordInput";
import Switch from "../../components/Switch";
import { useConfirm } from "../../hooks/useConfirm";
import { useMigrationStatus } from "../../hooks/useMigrationStatus";
import { errorMessage } from "../../lib/errorMessage";
import { isInsecurePublicUrl } from "../../lib/privateHost";
import { chooseConnection, openLocalLibrary } from "../../lib/desktopConnection";
import type { DesktopBridgeConfig } from "../../types/liferSetup";
import { SettingRow, SettingsGroup, inputClass } from "./shared";
import OfflineCacheSetting from "./OfflineCacheSetting";
import { formatList } from "../../lib/format";

export default function ServerSettings() {
  return <ServerSection />;
}

function InsecureUrlWarning({ urls }: { urls: string[] }) {
  const insecure = urls.filter(isInsecurePublicUrl);
  if (insecure.length === 0) return null;
  return (
    <p role="status" className="text-xs text-amber-700 dark:text-amber-300">
      {formatList(insecure, "unit")} uses plain http on a public network, so your password and photos travel
      unencrypted. Use https:// if your server supports it.
    </p>
  );
}

// Desktop shell only. The steps are sequential on purpose: migrate photos up, confirm nothing
// failed, then switch this window over or free local disk space, each an explicit action.
function ServerSection() {
  const confirm = useConfirm();
  const [config, setConfig] = useState<DesktopBridgeConfig | null>(null);
  const [signInUrl, setSignInUrl] = useState("");
  // Reachable but not yet signed in. Resets when the address changes.
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [serverUrl, setServerUrl] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [offlineMode, setOfflineMode] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  // The same polled status the header indicator uses, so both always agree.
  const migrationJob = useMigrationStatus();
  const status = migrationJob.status;

  useEffect(() => {
    window.liferSetup
      ?.getConfig()
      .then(setConfig)
      .catch((err) => setError(errorMessage(err, "Couldn't read this app's connection settings")));
  }, []);

  async function connectToServer(url: string) {
    setError(null);
    setBusy(true);
    const failure = await chooseConnection({ mode: "remote", serverUrl: url, offlineMode });
    if (failure) setError(failure);
    setBusy(false);
  }

  async function checkConnection(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setConnecting(true);
    try {
      if (await window.liferSetup!.testEndpoint(signInUrl)) {
        setConnected(true);
        setServerUrl(signInUrl);
      } else {
        setError("Couldn't reach that address. Check the URL and that the server is running.");
      }
    } catch (err) {
      setError(errorMessage(err, "Couldn't reach that address"));
    } finally {
      setConnecting(false);
    }
  }

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSigningIn(true);
    try {
      await window.liferSetup!.testLogin(signInUrl, email, password);
      await connectToServer(signInUrl);
    } catch (err) {
      setError(errorMessage(err, "Couldn't sign in"));
    } finally {
      setSigningIn(false);
    }
  }

  async function switchToLocal() {
    setError(null);
    setBusy(true);
    const failure = await openLocalLibrary();
    if (failure) setError(failure);
    setBusy(false);
  }

  async function migrate(e: React.FormEvent) {
    e.preventDefault();
    const ok = await confirm({
      title: "Migrate your library?",
      message: `Upload your entire local library to ${serverUrl}? This can take a while for a large library.`,
      confirmLabel: "Migrate",
    });
    if (!ok) return;
    setError(null);
    setStarting(true);
    try {
      await api.post("/settings/migrate-to-server", { serverUrl, email, password });
      void migrationJob.refresh();
    } catch (err) {
      setError(errorMessage(err, "Couldn't start the migration"));
    } finally {
      setStarting(false);
    }
  }

  async function deleteLocalFiles() {
    const ok = await confirm({
      title: "Delete local files?",
      message:
        "Permanently delete every local photo and capture on this computer? Only do this once you've confirmed they're all safely on the server. This can't be undone.",
      confirmLabel: "Delete local files",
      danger: true,
    });
    if (!ok) return;
    setDeleteError(null);
    setDeleting(true);
    try {
      await api.post("/settings/delete-local-library", { confirm: true });
      setDeleted(true);
    } catch (err) {
      setDeleteError(errorMessage(err, "Couldn't delete your local files"));
    } finally {
      setDeleting(false);
    }
  }

  if (!window.liferSetup) return null;
  if (!config) return error ? <FormMessage error={error} /> : null;

  // Mirrors the API's delete gate (settings/deleteLibraryGate.ts): finished, no failures or skips.
  const cleanMigration =
    status &&
    !status.running &&
    status.finishedAt != null &&
    status.error == null &&
    !status.cancelled &&
    status.failed === 0 &&
    status.skipped === 0;

  if (config.mode === "remote") {
    const connectionDescription =
      config.localUrl && config.externalUrls?.length
        ? `Showing the library on ${config.localUrl} (or ${config.externalUrls[0]} away from home).`
        : `Showing the library on ${config.serverUrl}.`;
    return (
      <SettingsGroup title="Connection">
        <SettingRow
          label="Server"
          description={connectionDescription}
          control={
            <Button variant="secondary" size="sm" onClick={switchToLocal} loading={busy}>
              Use local library
            </Button>
          }
        >
          {error && <FormMessage error={error} />}
        </SettingRow>
        <OfflineCacheSetting />
        <AutomaticUrlSwitchingRows />
      </SettingsGroup>
    );
  }

  const offlineCacheToggle = (
    <div className="flex items-center justify-between gap-item">
      <div>
        <p className="text-sm text-ink">Keep an offline cache</p>
        <p className="text-xs text-muted">Covers and collected status stay browsable if the server is unreachable.</p>
      </div>
      <Switch label="Keep an offline cache" checked={offlineMode} onChange={setOfflineMode} />
    </div>
  );

  return (
    <>
      <SettingsGroup title="Server">
        <SettingRow label="Sign in to a server" description="View and manage a library on a Lifer server you run.">
          {!connected ? (
            <form onSubmit={checkConnection} className="max-w-md space-y-2">
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="text"
                  aria-label="Server address"
                  placeholder="https://lifer.example.com"
                  value={signInUrl}
                  onChange={(e) => setSignInUrl(e.target.value)}
                  required
                  className={inputClass}
                />
                <Button type="submit" variant="secondary" size="sm" loading={connecting} className="whitespace-nowrap">
                  {connecting ? "Connecting…" : "Connect"}
                </Button>
              </div>
              <InsecureUrlWarning urls={[signInUrl]} />
            </form>
          ) : (
            <form onSubmit={signIn} className="max-w-md space-y-2">
              <p className="text-xs text-green-700 dark:text-green-400">Connected to {signInUrl}.</p>
              <InsecureUrlWarning urls={[signInUrl]} />
              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className={inputClass}
              />
              <PasswordInput
                placeholder="Password"
                value={password}
                onChange={setPassword}
                required
                autoComplete="current-password"
                className={inputClass}
              />
              {offlineCacheToggle}
              <div className="flex items-center gap-2">
                <Button type="submit" variant="secondary" size="sm" loading={signingIn || busy}>
                  {signingIn || busy ? "Signing in…" : "Sign in"}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setConnected(false);
                    setError(null);
                  }}
                >
                  Use a different address
                </Button>
              </div>
            </form>
          )}
          {error && <FormMessage error={error} />}
        </SettingRow>
      </SettingsGroup>

      {connected && (
        <SettingsGroup title="Migrate">
          <SettingRow
            label="Migrate this library"
            description="Uploads your local photos to the server. Local copies stay until you delete them."
          >
            {status?.running ? (
              <JobProgress
                status={status}
                phases={{ uploading: { label: `Migrating to ${status.serverUrl ?? "the server"}`, progress: "count" } }}
                fallbackLabel={`Migrating to ${status.serverUrl ?? "the server"}`}
                detail={`${status.migrated} migrated, ${status.skipped} skipped, ${status.failed} failed so far.${status.currentItem ? ` Now: ${status.currentItem}` : ""}`}
                onCancel={() => void migrationJob.cancel("/settings/migrate-to-server/cancel")}
                cancelling={migrationJob.cancelling}
              />
            ) : (
              <form onSubmit={migrate} className="max-w-md space-y-2">
                <input
                  type="text"
                  aria-label="Server address"
                  placeholder="https://lifer.example.com"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  required
                  className={inputClass}
                />
                <InsecureUrlWarning urls={[serverUrl]} />
                <input
                  type="email"
                  placeholder="Email on that server"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className={inputClass}
                />
                <PasswordInput
                  placeholder="Password"
                  value={password}
                  onChange={setPassword}
                  required
                  autoComplete="current-password"
                  className={inputClass}
                />
                {offlineCacheToggle}
                <FormMessage error={error ?? status?.error ?? null} />
                <Button type="submit" variant="secondary" size="sm" loading={starting}>
                  {starting ? "Starting…" : "Migrate"}
                </Button>
              </form>
            )}
          </SettingRow>

          {status && !status.running && status.finishedAt != null && (
            <>
              <SettingRow
                label="Switch to the server"
                description={
                  <span
                    className={
                      cleanMigration ? "text-green-700 dark:text-green-400" : "text-rose-700 dark:text-rose-400"
                    }
                  >
                    {status.cancelled ? "Last run was cancelled: " : "Last run: "}migrated {status.migrated} of{" "}
                    {status.total ?? "?"} ({status.skipped} skipped, {status.failed} failed).
                  </span>
                }
                control={
                  <Button variant="secondary" size="sm" onClick={() => connectToServer(serverUrl)} loading={busy}>
                    Switch
                  </Button>
                }
              />
              {(cleanMigration && !deleted) || deleteError || deleted ? (
                <SettingRow
                  label="Delete local files"
                  description="Frees this computer's space now that everything is on the server. Can't be undone."
                  control={
                    cleanMigration &&
                    !deleted && (
                      <Button variant="danger" size="sm" onClick={deleteLocalFiles} loading={deleting}>
                        {deleting ? "Deleting…" : "Delete"}
                      </Button>
                    )
                  }
                >
                  {(deleteError || deleted) && (
                    <FormMessage error={deleteError} success={deleted ? "Local files deleted." : null} />
                  )}
                </SettingRow>
              ) : null}
            </>
          )}
        </SettingsGroup>
      )}
    </>
  );
}

interface ExternalEndpoint {
  url: string;
  status: "idle" | "testing" | "ok" | "error";
}

// Only once connected to a remote server: prefer a local address while on a named Wi-Fi network,
// otherwise try an ordered list of external ones (see store.rs/lib.rs apply_config).
function AutomaticUrlSwitchingRows() {
  const [config, setConfig] = useState<DesktopBridgeConfig | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [localUrl, setLocalUrl] = useState("");
  const [localNetworkName, setLocalNetworkName] = useState("");
  const [externalUrls, setExternalUrls] = useState<ExternalEndpoint[]>([]);
  const [newExternalUrl, setNewExternalUrl] = useState("");
  const [usingCurrent, setUsingCurrent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dragIndex = useRef<number | null>(null);

  useEffect(() => {
    window.liferSetup
      ?.getConfig()
      .then((cfg) => {
        setConfig(cfg);
        if (cfg?.localUrl && cfg.externalUrls?.length) {
          setEnabled(true);
          setLocalUrl(cfg.localUrl);
          setLocalNetworkName(cfg.localNetworkName ?? "");
          setExternalUrls(cfg.externalUrls.map((url) => ({ url, status: "ok" })));
        }
      })
      .catch(() => setConfig(null));
  }, []);

  if (!window.liferSetup || !config || config.mode !== "remote") return null;

  async function useCurrentConnection() {
    setUsingCurrent(true);
    try {
      const info = await window.liferSetup!.currentNetworkInfo();
      if (info.localIp) setLocalUrl((prev) => prev || `http://${info.localIp}:4310`);
      if (info.wifiName) setLocalNetworkName(info.wifiName);
    } catch (err) {
      setError(errorMessage(err, "Couldn't read the current connection"));
    } finally {
      setUsingCurrent(false);
    }
  }

  async function addExternalUrl() {
    const url = newExternalUrl.trim();
    // URLs double as list keys and remove targets, so a repeat would act on both rows.
    if (!url || externalUrls.some((e) => e.url === url)) return;
    setNewExternalUrl("");
    setExternalUrls((prev) => [...prev, { url, status: "testing" }]);
    const ok = await window.liferSetup!.testEndpoint(url).catch(() => false);
    setExternalUrls((prev) => prev.map((e) => (e.url === url ? { ...e, status: ok ? "ok" : "error" } : e)));
  }

  function removeExternalUrl(url: string) {
    setExternalUrls((prev) => prev.filter((e) => e.url !== url));
  }

  function reorder(from: number, to: number) {
    setExternalUrls((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  async function save() {
    setError(null);
    setSaved(false);
    setSaving(true);
    const failure = await chooseConnection({
      mode: "remote",
      localUrl,
      localNetworkName: localNetworkName || undefined,
      externalUrls: externalUrls.map((e) => e.url),
      offlineMode: config?.offlineMode,
    });
    if (failure) setError(failure);
    else setSaved(true);
    setSaving(false);
  }

  const label = "Automatic address switching";
  const description = "Use a local address on your home Wi-Fi and other addresses elsewhere.";

  if (!enabled) {
    return (
      <SettingRow
        label={label}
        description={description}
        control={
          <Button variant="secondary" size="sm" onClick={() => setEnabled(true)}>
            Set up
          </Button>
        }
      />
    );
  }

  return (
    <>
      <SettingRow label={label} description={description} />
      <SettingRow
        label="Home network"
        description="Used while on this Wi-Fi network."
        control={
          <Button variant="secondary" size="sm" onClick={useCurrentConnection} loading={usingCurrent}>
            Use current connection
          </Button>
        }
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            aria-label="Local address"
            placeholder="http://192.168.1.10:4310"
            value={localUrl}
            onChange={(e) => setLocalUrl(e.target.value)}
            className={inputClass}
          />
          <input
            type="text"
            aria-label="Wi-Fi network name"
            placeholder="Wi-Fi network name"
            value={localNetworkName}
            onChange={(e) => setLocalNetworkName(e.target.value)}
            className={inputClass}
          />
        </div>
      </SettingRow>
      <SettingRow label="Other addresses" description="Elsewhere, the first one that answers is used. Drag to reorder.">
        {externalUrls.length > 0 && (
          <ul className="divide-y divide-line">
            {externalUrls.map((entry, index) => (
              <li
                key={entry.url}
                draggable
                onDragStart={() => {
                  dragIndex.current = index;
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragIndex.current !== null && dragIndex.current !== index) reorder(dragIndex.current, index);
                  dragIndex.current = null;
                }}
                className="flex items-center gap-2 py-1.5 text-sm"
              >
                <span className="cursor-grab text-muted" aria-hidden="true">
                  ⠿
                </span>
                <span className="flex-1 truncate text-ink">{entry.url}</span>
                {entry.status === "testing" && <InlineSpinner size="sm" label="Testing" />}
                {entry.status === "ok" && (
                  <span role="img" aria-label="Reachable" title="Reachable" className="text-green-600">
                    ✓
                  </span>
                )}
                {entry.status === "error" && (
                  <span role="img" aria-label="Couldn't reach" title="Couldn't reach" className="text-rose-600">
                    ✕
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => removeExternalUrl(entry.url)}
                  className="text-muted hover:text-ink"
                  aria-label={`Remove ${entry.url}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            aria-label="New address"
            placeholder="https://lifer.example.com"
            value={newExternalUrl}
            onChange={(e) => setNewExternalUrl(e.target.value)}
            className={inputClass}
          />
          <Button variant="secondary" size="sm" onClick={addExternalUrl} className="whitespace-nowrap">
            Add
          </Button>
        </div>
        <InsecureUrlWarning urls={[localUrl, newExternalUrl, ...externalUrls.map((e) => e.url)]} />
      </SettingRow>
      <SettingRow
        label="Save addresses"
        description="Needs a home address and at least one other."
        control={
          <Button
            variant="secondary"
            size="sm"
            onClick={save}
            loading={saving}
            disabled={!localUrl || externalUrls.length === 0}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        }
      >
        {(error || saved) && <FormMessage error={error} success={saved ? "Saved." : null} />}
      </SettingRow>
    </>
  );
}
