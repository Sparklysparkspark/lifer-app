import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import Button, { IconButton } from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import InlineSpinner from "../../components/InlineSpinner";
import PasswordInput from "../../components/PasswordInput";
import { useConfirm } from "../../hooks/useConfirm";
import { errorMessage } from "../../lib/errorMessage";
import { isInsecurePublicUrl } from "../../lib/privateHost";
import { chooseConnection, openLocalLibrary } from "../../lib/desktopConnection";
import type { DesktopBridgeConfig } from "../../types/liferSetup";
import TextField from "../../components/TextField";
import { SettingRow, SettingsGroup } from "./shared";
import LinkedDevices from "./LinkedDevices";
import SyncSettings from "./SyncSettings";
import { formatList } from "../../lib/format";

// Example addresses, not translated.
const SERVER_URL_EXAMPLE = "https://lifer.example.com";
const LOCAL_URL_EXAMPLE = "http://192.168.1.10:4310";

export default function ServerSettings() {
  return <ServerSection />;
}

function InsecureUrlWarning({ urls }: { urls: string[] }) {
  const { t } = useTranslation();
  const insecure = urls.filter(isInsecurePublicUrl);
  if (insecure.length === 0) return null;
  return (
    <p role="status" className="text-footnote text-amber-700 dark:text-amber-300">
      {t("settings.server.insecureUrl", { urls: formatList(insecure, "unit") })}
    </p>
  );
}

// Desktop shell only. Signing in to a server links this library to it: from then on photos and
// changes go up and the server's collection comes down by themselves (SyncSettings). Freeing
// local disk space stays an explicit action.
function ServerSection() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [config, setConfig] = useState<DesktopBridgeConfig | null>(null);
  const [signInUrl, setSignInUrl] = useState("");
  // Reachable but not yet signed in. Resets when the address changes.
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);

  useEffect(() => {
    window.liferSetup
      ?.getConfig()
      .then(setConfig)
      .catch((err) => setError(errorMessage(err, t("settings.server.configFailed"))));
  }, [t]);

  async function connectToServer(url: string) {
    setError(null);
    setBusy(true);
    const failure = await chooseConnection({ mode: "remote", serverUrl: url });
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
      } else {
        setError(t("settings.server.unreachableHint"));
      }
    } catch (err) {
      setError(errorMessage(err, t("settings.server.unreachable")));
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
      setError(errorMessage(err, t("settings.server.signInFailed")));
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

  async function deleteLocalFiles() {
    const ok = await confirm({
      title: t("settings.server.deleteLocalConfirm.title"),
      message: t("settings.server.deleteLocalConfirm.message"),
      confirmLabel: t("settings.server.deleteLocal"),
      danger: true,
    });
    if (!ok) return;
    setDeleteError(null);
    setDeleting(true);
    try {
      await api.post("/settings/delete-local-library", { confirm: true });
      setDeleted(true);
    } catch (err) {
      setDeleteError(errorMessage(err, t("settings.server.deleteLocalFailed")));
    } finally {
      setDeleting(false);
    }
  }

  // A server in a browser: only the devices linked to it.
  if (!window.liferSetup) return <LinkedDevices />;
  if (!config) return error ? <FormMessage error={error} /> : null;

  if (config.mode === "remote") {
    const connectionDescription =
      config.localUrl && config.externalUrls?.length
        ? t("settings.server.showingWithExternal", { local: config.localUrl, external: config.externalUrls[0] })
        : t("settings.server.showing", { url: config.serverUrl });
    return (
      <>
        <SettingsGroup title={t("settings.server.connection")}>
          <SettingRow
            label={t("settings.server.server")}
            description={connectionDescription}
            control={
              <Button variant="secondary" size="sm" onClick={switchToLocal} loading={busy}>
                {t("settings.server.useLocal")}
              </Button>
            }
          >
            {error && <FormMessage error={error} />}
          </SettingRow>
          <AutomaticUrlSwitchingRows />
        </SettingsGroup>
        <SyncSettings onServer />
        <LinkedDevices />
      </>
    );
  }
  const syncRows = <SyncSettings onServer={false} />;

  return (
    <>
      <SettingsGroup title={t("settings.groups.server")}>
        <SettingRow label={t("settings.server.signInLabel")} description={t("settings.server.signInDescription")}>
          {!connected ? (
            <form onSubmit={checkConnection} className="max-w-md space-y-2">
              <div className="flex flex-col gap-2 sm:flex-row">
                <TextField
                  size="sm"
                  type="text"
                  aria-label={t("settings.server.serverAddress")}
                  placeholder={SERVER_URL_EXAMPLE}
                  value={signInUrl}
                  onChange={(e) => setSignInUrl(e.target.value)}
                  required
                />
                <Button size="sm" type="submit" variant="secondary" loading={connecting} className="whitespace-nowrap">
                  {connecting ? t("settings.server.connecting") : t("settings.server.connect")}
                </Button>
              </div>
              <InsecureUrlWarning urls={[signInUrl]} />
            </form>
          ) : (
            <form onSubmit={signIn} className="max-w-md space-y-2">
              <p className="text-footnote text-green-700 dark:text-green-400">
                {t("settings.server.connectedTo", { url: signInUrl })}
              </p>
              <InsecureUrlWarning urls={[signInUrl]} />
              <TextField
                type="email"
                placeholder={t("settings.server.email")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <PasswordInput
                placeholder={t("settings.server.password")}
                value={password}
                onChange={setPassword}
                required
                autoComplete="current-password"
              />
              <div className="flex items-center gap-2">
                <Button size="sm" type="submit" variant="secondary" loading={signingIn || busy}>
                  {signingIn || busy ? t("settings.server.signingIn") : t("settings.server.signIn")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setConnected(false);
                    setError(null);
                  }}
                >
                  {t("settings.server.differentAddress")}
                </Button>
              </div>
            </form>
          )}
          {error && <FormMessage error={error} />}
        </SettingRow>
      </SettingsGroup>

      {syncRows}

      {!deleted || deleteError ? (
        <SettingsGroup title={t("settings.server.localFiles")}>
          <SettingRow
            label={t("settings.server.deleteLocal")}
            description={t("settings.server.deleteLocalDescription")}
            control={
              !deleted && (
                <Button variant="danger" size="sm" onClick={deleteLocalFiles} loading={deleting}>
                  {deleting ? t("common.deleting") : t("common.delete")}
                </Button>
              )
            }
          >
            {(deleteError || deleted) && (
              <FormMessage error={deleteError} success={deleted ? t("settings.server.deleteLocalDone") : null} />
            )}
          </SettingRow>
        </SettingsGroup>
      ) : null}
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
  const { t } = useTranslation();
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
      setError(errorMessage(err, t("settings.server.networkInfoFailed")));
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
    });
    if (failure) setError(failure);
    else setSaved(true);
    setSaving(false);
  }

  const label = t("settings.server.autoSwitching");
  const description = t("settings.server.autoSwitchingDescription");

  if (!enabled) {
    return (
      <SettingRow
        label={label}
        description={description}
        control={
          <Button variant="secondary" size="sm" onClick={() => setEnabled(true)}>
            {t("settings.server.setUp")}
          </Button>
        }
      />
    );
  }

  return (
    <>
      <SettingRow label={label} description={description} />
      <SettingRow
        label={t("settings.server.homeNetwork")}
        description={t("settings.server.homeNetworkDescription")}
        control={
          <Button variant="secondary" size="sm" onClick={useCurrentConnection} loading={usingCurrent}>
            {t("settings.server.useCurrent")}
          </Button>
        }
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <TextField
            type="text"
            aria-label={t("settings.server.localAddress")}
            placeholder={LOCAL_URL_EXAMPLE}
            value={localUrl}
            onChange={(e) => setLocalUrl(e.target.value)}
          />
          <TextField
            type="text"
            aria-label={t("settings.server.wifiName")}
            placeholder={t("settings.server.wifiName")}
            value={localNetworkName}
            onChange={(e) => setLocalNetworkName(e.target.value)}
          />
        </div>
      </SettingRow>
      <SettingRow
        label={t("settings.server.otherAddresses")}
        description={t("settings.server.otherAddressesDescription")}
      >
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
                className="flex items-center gap-2 py-1.5 text-callout"
              >
                <span className="cursor-grab text-muted" aria-hidden="true">
                  ⠿
                </span>
                <span className="flex-1 truncate text-ink">{entry.url}</span>
                {entry.status === "testing" && <InlineSpinner size="sm" label={t("settings.server.testing")} />}
                {entry.status === "ok" && (
                  <span
                    role="img"
                    aria-label={t("settings.server.reachable")}
                    title={t("settings.server.reachable")}
                    className="text-green-600"
                  >
                    ✓
                  </span>
                )}
                {entry.status === "error" && (
                  <span
                    role="img"
                    aria-label={t("settings.server.notReachable")}
                    title={t("settings.server.notReachable")}
                    className="text-rose-600"
                  >
                    ✕
                  </span>
                )}
                <IconButton
                  tone="plain"
                  onClick={() => removeExternalUrl(entry.url)}
                  aria-label={t("settings.server.remove", { url: entry.url })}
                >
                  ✕
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <TextField
            size="sm"
            type="text"
            aria-label={t("settings.server.newAddress")}
            placeholder={SERVER_URL_EXAMPLE}
            value={newExternalUrl}
            onChange={(e) => setNewExternalUrl(e.target.value)}
          />
          <Button size="sm" variant="secondary" onClick={addExternalUrl} className="whitespace-nowrap">
            {t("settings.server.add")}
          </Button>
        </div>
        <InsecureUrlWarning urls={[localUrl, newExternalUrl, ...externalUrls.map((e) => e.url)]} />
      </SettingRow>
      <SettingRow
        label={t("settings.server.saveAddresses")}
        description={t("settings.server.saveAddressesDescription")}
        control={
          <Button
            variant="secondary"
            size="sm"
            onClick={save}
            loading={saving}
            disabled={!localUrl || externalUrls.length === 0}
          >
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        }
      >
        {(error || saved) && <FormMessage error={error} success={saved ? t("settings.server.saved") : null} />}
      </SettingRow>
    </>
  );
}
