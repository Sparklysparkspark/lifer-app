import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import { useDeploymentMode } from "../../hooks/useDeploymentMode";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { SettingRow, SettingsGroup, inputClass } from "./shared";

interface InaturalistStatus {
  available: boolean;
  connected: boolean;
  username: string | null;
}

interface InaturalistServerConfig {
  hasClientId: boolean;
  redirectUri: string;
}

// A server's own iNaturalist app registration stays hidden until Lifer's iNaturalist app is approved.
const SHOW_SERVER_REGISTRATION = false;

// iNaturalist linking stays hidden until the API has a client ID (env var, or the server-mode
// registration rows below), since Connect would only 501 without one.
export default function IntegrationsSettings() {
  const mode = useDeploymentMode();
  const [status, setStatus] = useState<InaturalistStatus | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false);

  const load = useCallback(() => {
    api
      .get("/inaturalist/status")
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setStatusLoaded(true));
  }, []);

  useEffect(load, [load]);
  // Sign-in finishes in the system browser; re-checking on focus notices it without polling.
  useEffect(() => {
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  const showServerConfig = SHOW_SERVER_REGISTRATION && mode === "server";
  const available = !!status?.available;

  return (
    <>
      {(available || showServerConfig) && (
        <SettingsGroup title="iNaturalist">
          {available && status && <InaturalistRow status={status} onChanged={load} />}
          {showServerConfig && <InaturalistServerConfigRows onSaved={load} />}
        </SettingsGroup>
      )}
      {statusLoaded && !available && !showServerConfig && (
        <SettingsGroup title="Integrations">
          <SettingRow label="Nothing here yet" description="Integrations will show up here in a future update." />
        </SettingsGroup>
      )}
    </>
  );
}

function InaturalistRow({ status, onChanged }: { status: InaturalistStatus; onChanged: () => void }) {
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function connect() {
    setError(null);
    setBusy(true);
    try {
      const { authorizeUrl } = await api.post<{ authorizeUrl: string }>("/inaturalist/connect");
      // window.open in the desktop shell goes through a plugin this app isn't granted; the opener plugin is.
      if (window.liferSetup) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(authorizeUrl);
      } else {
        window.open(authorizeUrl, "_blank", "noopener");
      }
    } catch (err) {
      setError(errorMessage(err, "Couldn't start the iNaturalist sign-in"));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await api.post("/inaturalist/disconnect");
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't disconnect iNaturalist"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingRow
      label="iNaturalist account"
      description={
        status.connected ? (
          <>
            Connected as {status.username}.{" "}
            <Link to="/inaturalist" className="underline hover:text-ink">
              Open iNaturalist
            </Link>
          </>
        ) : (
          "Link your account to send sightings to iNaturalist as draft observations."
        )
      }
      control={
        status.connected ? (
          <Button variant="secondary" size="sm" onClick={disconnect} disabled={busy}>
            Disconnect
          </Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={connect} loading={busy}>
            Connect
          </Button>
        )
      }
    >
      {error && <FormMessage error={error} />}
    </SettingRow>
  );
}

// OAuth needs an exact redirect URI per registered app, so each self-hosted deployment registers
// its own iNaturalist application and saves the client ID here (inat_server_config).
function InaturalistServerConfigRows({ onSaved }: { onSaved: () => void }) {
  const [config, setConfig] = useState<InaturalistServerConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  // Starts as the effective URI; "" means the default, which the API stores as unset.
  const [redirectUri, setRedirectUri] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    api
      .get<InaturalistServerConfig>("/inaturalist/server-config")
      .then((res) => {
        setConfig(res);
        setRedirectUri(res.redirectUri);
        setLoadError(null);
      })
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load the iNaturalist settings")));
  }
  useEffect(load, []);

  async function save() {
    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      await api.put("/inaturalist/server-config", {
        clientId: clientId.trim() || null,
        redirectUri: redirectUri.trim(),
      });
      setClientId("");
      setSuccess("Saved.");
      load();
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Couldn't save this"));
    } finally {
      setSaving(false);
    }
  }

  if (!config)
    return loadError ? <SettingRow label="App registration">{<FormMessage error={loadError} />}</SettingRow> : null;

  return (
    <>
      <SettingRow
        label="Redirect URI"
        description={
          <>
            Register an app at{" "}
            <a
              href="https://www.inaturalist.org/oauth/applications"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              inaturalist.org/oauth/applications
            </a>{" "}
            with this redirect URI.
          </>
        }
        control={
          <Button variant="secondary" size="sm" onClick={() => setRedirectUri("")} disabled={redirectUri === ""}>
            Reset to default
          </Button>
        }
      >
        <input
          type="text"
          aria-label="Redirect URI to register"
          value={redirectUri}
          onChange={(e) => setRedirectUri(e.target.value)}
          placeholder="Default (saved as unset)"
          spellCheck={false}
          className={`${inputClass} font-mono text-xs`}
        />
      </SettingRow>
      <SettingRow
        label="Client ID"
        description={
          config.hasClientId
            ? "A client ID is set. Leave the box empty to keep it."
            : "Paste the client ID of the app you registered."
        }
        control={
          <Button variant="secondary" size="sm" onClick={save} loading={saving}>
            Save
          </Button>
        }
      >
        {/* The saved client ID is never sent back; an empty box keeps it. */}
        <input
          type="text"
          aria-label="Client ID"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="Client ID"
          className={inputClass}
        />
        {(error || success) && <FormMessage error={error} success={success} />}
      </SettingRow>
    </>
  );
}
