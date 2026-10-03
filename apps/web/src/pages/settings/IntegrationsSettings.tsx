import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import Button, { buttonClasses } from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import { useDeploymentMode } from "../../hooks/useDeploymentMode";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { Card, inputClass } from "./shared";

interface InaturalistStatus {
  available: boolean;
  connected: boolean;
  username: string | null;
}

interface InaturalistServerConfig {
  hasClientId: boolean;
  redirectUri: string;
}

// iNaturalist linking stays hidden until the API has a client ID (env var, or the server-mode
// registration card below), since Connect would only 501 without one.
export default function IntegrationsSettings() {
  const mode = useDeploymentMode();
  const [status, setStatus] = useState<InaturalistStatus | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false);

  const load = useCallback(() => {
    api
      .get<InaturalistStatus>("/inaturalist/status")
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

  const showServerConfig = mode === "server";
  const available = !!status?.available;

  return (
    <>
      {available && status && <InaturalistSection status={status} onChanged={load} />}
      {showServerConfig && <InaturalistServerConfigSection onSaved={load} />}
      {statusLoaded && !available && !showServerConfig && (
        <Card title="Integrations" description="" learnMore="integrations">
          <p className="text-sm text-muted">Nothing to see here yet, check back on a future update.</p>
        </Card>
      )}
    </>
  );
}

function InaturalistSection({ status, onChanged }: { status: InaturalistStatus; onChanged: () => void }) {
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
    <Card
      title="iNaturalist"
      learnMore="integrations"
      description="Optionally link your iNaturalist account to send sightings there as draft observations."
    >
      {status.connected ? (
        <>
          <p className="text-sm text-ink">Connected as {status.username}</p>
          <div className="flex gap-3">
            <Link to="/inaturalist" className={buttonClasses("secondary", "sm")}>
              Open iNaturalist
            </Link>
            <Button variant="secondary" size="sm" onClick={disconnect} disabled={busy}>
              Disconnect
            </Button>
          </div>
        </>
      ) : (
        <Button variant="secondary" size="sm" onClick={connect} loading={busy}>
          Connect iNaturalist account
        </Button>
      )}
      <FormMessage error={error} />
    </Card>
  );
}

// OAuth needs an exact redirect URI per registered app, so each self-hosted deployment registers
// its own iNaturalist application and saves the client ID here (inat_server_config).
function InaturalistServerConfigSection({ onSaved }: { onSaved: () => void }) {
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
      await api.put("/inaturalist/server-config", { clientId: clientId.trim() || null, redirectUri: redirectUri.trim() });
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

  if (!config) return loadError ? <FormMessage error={loadError} /> : null;

  return (
    <Card
      title="iNaturalist app registration"
      learnMore="integrations"
      description="Register your own application at inaturalist.org/oauth/applications with the redirect URI below, then paste its client ID here."
    >
      <label className="block space-y-1">
        <span className="text-xs text-muted">Redirect URI to register</span>
        <div className="flex gap-2">
          <input
            type="text"
            value={redirectUri}
            onChange={(e) => setRedirectUri(e.target.value)}
            placeholder="Default (saved as unset)"
            spellCheck={false}
            className={`${inputClass} flex-1 font-mono text-xs`}
          />
          <Button variant="secondary" size="sm" onClick={() => setRedirectUri("")} disabled={redirectUri === ""}>
            Reset to default
          </Button>
        </div>
      </label>
      <p className="text-sm text-ink">{config.hasClientId ? "A client ID is currently set." : "No client ID set yet."}</p>
      <div className="flex gap-2">
        <input type="text" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client ID" className={`${inputClass} flex-1`} />
        <Button variant="secondary" size="sm" onClick={save} loading={saving}>
          Save
        </Button>
      </div>
      {/* The saved client ID is never sent back; an empty box keeps it. */}
      {config.hasClientId && !clientId.trim() && <p className="text-xs text-muted">Leave the Client ID box empty to keep the saved one.</p>}
      <FormMessage error={error} success={success} />
    </Card>
  );
}
