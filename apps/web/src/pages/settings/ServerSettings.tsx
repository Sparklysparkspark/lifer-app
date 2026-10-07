import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import InlineSpinner from "../../components/InlineSpinner";
import JobProgress from "../../components/JobProgress";
import PasswordInput from "../../components/PasswordInput";
import { useConfirm } from "../../hooks/useConfirm";
import { useMigrationStatus } from "../../hooks/useMigrationStatus";
import { errorMessage } from "../../lib/errorMessage";
import { isInsecurePublicUrl } from "../../lib/privateHost";
import { chooseConnection, openLocalLibrary } from "../../lib/desktopConnection";
import type { DesktopBridgeConfig } from "../../types/liferSetup";
import { Card, inputClass } from "./shared";
import OfflineCacheSetting from "./OfflineCacheSetting";

export default function ServerSettings() {
  return (
    <>
      <ServerSection />
      <AutomaticUrlSwitchingSection />
    </>
  );
}

function InsecureUrlWarning({ urls }: { urls: string[] }) {
  const insecure = urls.filter(isInsecurePublicUrl);
  if (insecure.length === 0) return null;
  return (
    <p
      role="status"
      className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300"
    >
      {insecure.join(", ")} uses plain http on a public network, so your password and photos travel unencrypted. Use
      https:// if your server supports it.
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
      <Card title="Connect a server" description={connectionDescription} learnMore="connect-a-server">
        <FormMessage error={error} />
        <Button variant="secondary" size="sm" onClick={switchToLocal} loading={busy}>
          Switch to local library
        </Button>
        <OfflineCacheSetting />
      </Card>
    );
  }

  const offlineCacheToggle = (
    <label className="flex items-start gap-2 text-sm text-ink">
      <input
        type="checkbox"
        checked={offlineMode}
        onChange={(e) => setOfflineMode(e.target.checked)}
        className="mt-0.5"
      />
      <span>
        Keep an offline cache after connecting. Low-res cover photos and your collected/seen status stay browsable here
        even if this computer loses its connection to the server.
      </span>
    </label>
  );

  return (
    <>
      <Card
        title="Sign in to a server"
        learnMore="sign-in-to-a-server"
        description="Already have a library on a Lifer server elsewhere? Point the app to view and manage it directly. Connecting a server also enables you to migrate files you have stored locally to the server, allowing you to use Lifer offline on the go in the app, and push your files once you're back online."
      >
        {!connected ? (
          <form onSubmit={checkConnection} className="space-y-2">
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                placeholder="https://lifer.example.com"
                value={signInUrl}
                onChange={(e) => setSignInUrl(e.target.value)}
                required
                className={inputClass}
              />
              <Button type="submit" loading={connecting} className="whitespace-nowrap">
                {connecting ? "Connecting…" : "Connect"}
              </Button>
            </div>
            <InsecureUrlWarning urls={[signInUrl]} />
          </form>
        ) : (
          <form onSubmit={signIn} className="space-y-3">
            <p className="text-sm text-green-700 dark:text-green-400">Connected to {signInUrl}.</p>
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
            <div className="flex items-center gap-3">
              <Button type="submit" loading={signingIn || busy}>
                {signingIn || busy ? "Signing in…" : "Sign in"}
              </Button>
              <button
                type="button"
                onClick={() => {
                  setConnected(false);
                  setError(null);
                }}
                className="text-sm text-muted underline"
              >
                Use a different address
              </button>
            </div>
          </form>
        )}
        <FormMessage error={error} />
      </Card>

      {connected && (
        <Card
          title="Migrate your library to a server"
          learnMore="migrate"
          description="Move your library to a Lifer server you run elsewhere. Migrate your photos up, confirm nothing failed, then switch this window over. Your local copies stay put until you separately choose to delete them."
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
            <form onSubmit={migrate} className="space-y-3">
              <input
                type="text"
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
              <Button type="submit" loading={starting}>
                {starting ? "Starting…" : "Migrate my library"}
              </Button>
            </form>
          )}

          {status && !status.running && status.finishedAt != null && (
            <div className="space-y-3 border-t border-line pt-3">
              <p
                className={
                  cleanMigration
                    ? "text-sm text-green-700 dark:text-green-400"
                    : "text-sm text-rose-700 dark:text-rose-400"
                }
              >
                {status.cancelled ? "Last run was cancelled: " : "Last run: "}migrated {status.migrated} of{" "}
                {status.total ?? "?"} ({status.skipped} skipped, {status.failed} failed).
              </p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => connectToServer(serverUrl)} loading={busy}>
                  Switch this window to the server
                </Button>
                {cleanMigration && !deleted && (
                  <Button variant="danger" size="sm" onClick={deleteLocalFiles} loading={deleting}>
                    {deleting ? "Deleting…" : "Delete local files now that they're on the server"}
                  </Button>
                )}
              </div>
              <FormMessage error={deleteError} success={deleted ? "Local files deleted." : null} />
            </div>
          )}
        </Card>
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
function AutomaticUrlSwitchingSection() {
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

  const title = "Automatic URL switching";
  const description = "Connect locally over designated Wi-Fi when available and use alternative connections elsewhere.";

  if (!enabled) {
    return (
      <Card title={title} description={description} learnMore="url-switching">
        <Button onClick={() => setEnabled(true)}>Set up</Button>
      </Card>
    );
  }

  return (
    <Card title={title} description={description} learnMore="url-switching">
      <div className="space-y-3">
        <div>
          <p className="text-sm font-medium text-ink">Local network</p>
          <p className="mt-0.5 text-sm text-muted">
            The app will connect to the server through this URL when using the specified Wi-Fi network.
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              placeholder="http://192.168.1.10:4310"
              value={localUrl}
              onChange={(e) => setLocalUrl(e.target.value)}
              className={inputClass}
            />
            <input
              type="text"
              placeholder="Wi-Fi network name"
              value={localNetworkName}
              onChange={(e) => setLocalNetworkName(e.target.value)}
              className={inputClass}
            />
          </div>
          <Button variant="secondary" size="sm" onClick={useCurrentConnection} disabled={usingCurrent} className="mt-2">
            {usingCurrent ? "Reading current connection…" : "Use current connection"}
          </Button>
        </div>

        <div>
          <p className="text-sm font-medium text-ink">External networks</p>
          <p className="mt-0.5 text-sm text-muted">
            When not on the preferred Wi-Fi network, the app will connect to the server through the first of the below
            URLs it can reach, starting from the top to bottom.
          </p>
          <ul className="mt-2 space-y-1.5">
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
                className="flex items-center gap-2 rounded-md border border-line bg-surface px-2 py-1.5 text-sm"
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
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              placeholder="https://lifer.example.com"
              value={newExternalUrl}
              onChange={(e) => setNewExternalUrl(e.target.value)}
              className={inputClass}
            />
            <Button variant="secondary" size="sm" onClick={addExternalUrl} className="whitespace-nowrap">
              Add
            </Button>
          </div>
          <div className="mt-2">
            <InsecureUrlWarning urls={[localUrl, newExternalUrl, ...externalUrls.map((e) => e.url)]} />
          </div>
        </div>

        <FormMessage error={error} success={saved ? "Saved." : null} />
        <Button onClick={save} loading={saving} disabled={!localUrl || externalUrls.length === 0}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </Card>
  );
}
