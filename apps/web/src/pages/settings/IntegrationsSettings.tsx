import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { api } from "../../api/client";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import { useConfirm } from "../../hooks/useConfirm";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { useRefreshInatStatus } from "../../hooks/useInatStatus";
import ConnectedAppsSettings from "./ConnectedAppsSettings";
import ImmichSettings from "./ImmichSettings";
import PhonesSettings from "./PhonesSettings";
import Modal from "../../components/Modal";
import { formatDate } from "../../lib/format";
import { SettingLinkRow, SettingRow, SettingsGroup } from "./shared";

interface InaturalistStatus {
  available: boolean;
  connected: boolean;
  username: string | null;
}

// iNaturalist linking stays hidden until the API has a client ID, since Connect would only 501 without one.
export default function IntegrationsSettings() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<InaturalistStatus | null>(null);

  const load = useCallback(() => {
    api
      .get("/inaturalist/status")
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useEffect(load, [load]);
  // Sign-in finishes in the system browser; re-checking on focus notices it without polling.
  useEffect(() => {
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  const available = !!status?.available;

  return (
    <>
      {available && status && (
        <SettingsGroup title="iNaturalist">
          <InaturalistRow status={status} onChanged={load} />
        </SettingsGroup>
      )}
      <ImmichSettings />
      <SettingsGroup title={t("settings.integrations.assistantTitle")}>
        <AssistantSetup />
        <SettingLinkRow
          to="/settings/api-keys"
          label={t("settings.account.apiKeys")}
          description={t("settings.account.apiKeysDescription")}
        />
      </SettingsGroup>
      <PhonesSettings />
      <ConnectedAppsSettings />
    </>
  );
}

// For a server: the assistant runs on the owner's own computer. The same config works in Claude Desktop and other assistants that read an "mcpServers" block.
// The key is never filled in: the person makes one on the API keys page and pastes it.
function ManualAssistantSetup() {
  const { t } = useTranslation();
  const toast = useToast();
  const snippet = JSON.stringify(
    {
      mcpServers: {
        lifer: {
          command: "node",
          args: [t("settings.integrations.assistantPathPlaceholder")],
          env: { LIFER_URL: window.location.origin, LIFER_API_KEY: t("settings.integrations.assistantKeyPlaceholder") },
        },
      },
    },
    null,
    2,
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      toast.success(t("settings.integrations.assistantCopied"));
    } catch {
      toast.error(t("settings.integrations.assistantCopyFailed"));
    }
  }

  return (
    <SettingRow
      label={t("settings.integrations.assistantLabel")}
      description={
        <Trans
          i18nKey="settings.integrations.assistantDescription"
          components={{ a: <Link to="/settings/api-keys" className="text-accent hover:underline" /> }}
        />
      }
      control={
        <Button variant="secondary" size="sm" onClick={() => void copy()}>
          {t("settings.integrations.assistantCopy")}
        </Button>
      }
    >
      <pre className="overflow-x-auto rounded-control bg-surface-muted p-2 text-footnote text-ink">{snippet}</pre>
    </SettingRow>
  );
}

const ASSISTANT_SCOPES = [
  "gallery.read",
  "species.read",
  "stats.read",
  "trips.read",
  "album.read",
  "album.write",
  "collection.read",
] as const;

interface AssistantInfo {
  available: boolean;
  command: string | null;
  script: string | null;
  url: string | null;
}

/** On the desktop app the assistant server ships with Lifer, so setup is one click: make a key and
 *  show the config with the real paths filled in. A server's owner runs the assistant on their own
 *  computer, so they get the manual snippet. */
function AssistantSetup() {
  const { t } = useTranslation();
  const toast = useToast();
  const [info, setInfo] = useState<AssistantInfo | null>(null);
  const [config, setConfig] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get("/assistant/setup")
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("settings.integrations.assistantCopied"));
    } catch {
      toast.error(t("settings.integrations.assistantCopyFailed"));
    }
  }

  async function setUp() {
    if (!info?.command || !info.script || !info.url) return;
    setBusy(true);
    try {
      const key = await api.post("/api-keys", {
        name: t("settings.integrations.assistantKeyName", { date: formatDate(new Date(), "medium") }),
        permissions: [...ASSISTANT_SCOPES],
      });
      setConfig(
        JSON.stringify(
          {
            mcpServers: {
              lifer: {
                command: info.command,
                args: [info.script],
                env: { LIFER_URL: info.url, LIFER_API_KEY: key.token },
              },
            },
          },
          null,
          2,
        ),
      );
    } catch (err) {
      toast.error(errorMessage(err, t("settings.integrations.assistantKeyFailed")));
    } finally {
      setBusy(false);
    }
  }

  if (!info?.available) return <ManualAssistantSetup />;
  return (
    <>
      <SettingRow
        label={t("settings.integrations.assistantLabel")}
        description={t("settings.integrations.assistantDescriptionDesktop")}
        control={
          <Button variant="secondary" size="sm" onClick={() => void setUp()} loading={busy}>
            {t("settings.integrations.assistantSetUp")}
          </Button>
        }
      />
      <Modal
        open={config !== null}
        onClose={() => setConfig(null)}
        title={t("settings.integrations.assistantModalTitle")}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setConfig(null)}>
              {t("common.done")}
            </Button>
            <Button size="sm" onClick={() => void copy(config ?? "")}>
              {t("settings.integrations.assistantCopy")}
            </Button>
          </>
        }
      >
        <div className="space-y-item">
          <ol className="list-decimal space-y-1 pl-5 text-callout text-ink">
            <li>{t("settings.integrations.assistantStep1")}</li>
            <li>{t("settings.integrations.assistantStep2")}</li>
            <li>{t("settings.integrations.assistantStep3")}</li>
          </ol>
          <pre className="max-h-64 overflow-auto rounded-control bg-surface-muted p-2 text-footnote text-ink">
            {config}
          </pre>
          <p className="text-footnote text-muted">{t("settings.integrations.assistantKeyNote")}</p>
        </div>
      </Modal>
    </>
  );
}

function InaturalistRow({ status, onChanged }: { status: InaturalistStatus; onChanged: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Sign-in continues on iNaturalist's site; the focus re-check flips the row once it's done.
  const [waiting, setWaiting] = useState(false);
  const navigate = useNavigate();
  const refreshStatus = useRefreshInatStatus();

  async function connect() {
    setError(null);
    setBusy(true);
    try {
      let reply = await api.post<{ authorizeUrl?: string; needsTrust?: boolean; address?: string }>(
        "/inaturalist/connect",
      );
      // A web address Lifer hasn't used for this before: say where iNaturalist's reply goes, once.
      if (reply.needsTrust && reply.address) {
        const ok = await confirm({
          title: t("settings.integrations.trustTitle"),
          message: t("settings.integrations.trustMessage", { address: reply.address }),
          confirmLabel: t("settings.integrations.trustConfirm"),
        });
        if (!ok) return;
        await api.post("/inaturalist/trust", { address: reply.address });
        reply = await api.post("/inaturalist/connect");
      }
      const authorizeUrl = reply.authorizeUrl;
      if (!authorizeUrl) throw new Error(t("settings.integrations.connectFailed"));
      // window.open in the desktop shell goes through a plugin this app isn't granted; the opener plugin is.
      if (window.liferSetup) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(authorizeUrl);
      } else {
        // eslint-disable-next-line no-restricted-syntax -- baseline, migrate to openExternal() or a shared link component
        window.open(authorizeUrl, "_blank", "noopener");
      }
      setWaiting(true);
    } catch (err) {
      setError(errorMessage(err, t("settings.integrations.connectFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await api.post("/inaturalist/disconnect");
      setWaiting(false);
      onChanged();
      refreshStatus();
    } catch (err) {
      toast.error(errorMessage(err, t("settings.integrations.disconnectFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingRow
      label={t("settings.integrations.inatAccount")}
      description={
        status.connected
          ? t("settings.integrations.connectedAs", { username: status.username })
          : waiting
            ? t("settings.integrations.finishSignIn")
            : t("settings.integrations.linkDescription")
      }
      control={
        status.connected ? (
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => navigate("/inaturalist")}>
              {t("settings.integrations.openInat")}
            </Button>
            <Button variant="secondary" size="sm" onClick={disconnect} loading={busy}>
              {t("settings.integrations.disconnect")}
            </Button>
          </div>
        ) : (
          <Button variant="secondary" size="sm" onClick={connect} loading={busy}>
            {t("settings.integrations.connect")}
          </Button>
        )
      }
    >
      {error && <FormMessage error={error} />}
    </SettingRow>
  );
}
