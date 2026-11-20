// Settings > Connect phone: pair a phone with a QR code or its 6 digits, see each paired phone,
// remove one. On the
// desktop app's own library the same page also holds the "keep syncing when Lifer is closed" and
// "Start at login" switches, which live in the shell (companion.rs). The page works against the
// signed-in user's own routes (companion/routes.ts); a phone's key never reaches it.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { generate } from "lean-qr";
import { toSvgDataURL } from "lean-qr/extras/svg";
import { groupPairingCode } from "@lifer/shared";
import { api, apiPath, type ApiResponse } from "../../api/client";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import InlineSpinner from "../../components/InlineSpinner";
import Modal from "../../components/Modal";
import Switch from "../../components/Switch";
import { useConfirm } from "../../hooks/useConfirm";
import { useDeploymentMode } from "../../hooks/useDeploymentMode";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { formatDate, formatRelativeTime } from "../../lib/format";
import { tauriInvoke, type TauriInvoke } from "../../lib/tauri";
import { SettingRow, SettingsGroup } from "./shared";

type Phone = ApiResponse<"/companion/v1/devices">["devices"][number];

interface ShellStatus {
  keepSyncing: boolean;
  lastSyncedAt: number | null;
  autostart: boolean;
}

const POLL_MS = 3000;
const KEEP_SYNCING = "companion_set_keep_syncing";
const AUTOSTART = "companion_set_autostart";

/** The QR is always dark on white with a quiet zone, whatever the theme, so cameras read it. */
function qrDataUrl(payload: string): string {
  // design-token: a QR code must be black on white to scan
  return toSvgDataURL(generate(payload), { on: "#000", off: "#fff", pad: 3 });
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export default function PhonesSettings() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const toast = useToast();
  const mode = useDeploymentMode();
  const invoke = tauriInvoke();
  // The desktop app's own library; a window showing a linked server's pages is the server's flow.
  const onThisComputer = mode === "desktop" && invoke !== null;
  const onLinkedServer = mode === "server" && invoke !== null;

  const [phones, setPhones] = useState<Phone[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [shell, setShell] = useState<ShellStatus | null>(null);

  const load = useCallback(async () => {
    try {
      const { devices } = await api.get("/companion/v1/devices");
      setPhones(devices);
      setError(null);
      // The shell listens for phones only while one is paired; it checks the count itself.
      if (onThisComputer) await invoke?.("companion_set_paired").catch(() => {});
    } catch (err) {
      setError(errorMessage(err, t("settings.phones.loadFailed")));
    }
  }, [t, onThisComputer, invoke]);

  const loadShell = useCallback(async () => {
    if (!onThisComputer) return;
    try {
      setShell((await invoke!("companion_status")) as ShellStatus);
    } catch {
      setShell(null);
    }
  }, [onThisComputer, invoke]);

  useEffect(() => {
    const first = setTimeout(() => {
      void load();
      void loadShell();
    }, 0);
    return () => clearTimeout(first);
  }, [load, loadShell]);

  // New pairings and "synced" times appear without a refresh while the page is open.
  useEffect(() => {
    const timer = setInterval(() => {
      void load();
      void loadShell();
    }, POLL_MS * 4);
    return () => clearInterval(timer);
  }, [load, loadShell]);

  async function revoke(phone: Phone) {
    const ok = await confirm({
      title: t("settings.phones.revokeConfirm.title", { name: phone.name }),
      message: t("settings.phones.revokeConfirm.message"),
      confirmLabel: t("settings.phones.revoke"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(apiPath("/companion/v1/devices/{id}", { id: phone.id }));
      await load();
    } catch (err) {
      toast.error(errorMessage(err, t("settings.phones.revokeFailed")));
    }
  }

  async function setShellOption(
    command: string,
    args: Record<string, unknown>,
    apply: (s: ShellStatus) => ShellStatus,
  ) {
    try {
      await invoke!(command, args);
      setShell((s) => (s ? apply(s) : s));
    } catch (err) {
      toast.error(errorMessage(err, t("settings.phones.optionFailed")));
    }
  }

  const platformLabel = {
    ios: t("settings.phones.platform.ios"),
    android: t("settings.phones.platform.android"),
  };
  const lastSynced = (phone: Phone) =>
    phone.lastUsedAt
      ? t("settings.phones.lastSynced", { when: formatRelativeTime(phone.lastUsedAt) })
      : t("settings.phones.neverSynced");

  return (
    <div className="space-y-6">
      <SettingsGroup title={t("settings.phones.title")}>
        <SettingRow
          label={t("settings.phones.pairLabel")}
          description={t(onLinkedServer ? "settings.phones.pairServerDescription" : "settings.phones.pairDescription")}
          control={
            <Button variant="primary" size="sm" disabled={phones === null} onClick={() => setPairing(true)}>
              {t("settings.phones.pair")}
            </Button>
          }
        />
        {onLinkedServer && (
          <SettingRow label={t("settings.phones.viaServer")} description={t("settings.phones.viaServerDescription")} />
        )}
        {error && (
          <SettingRow label={t("settings.phones.listTitle")}>
            <FormMessage error={error} />
          </SettingRow>
        )}
        {!error && phones === null && (
          <SettingRow label={t("settings.phones.listTitle")}>
            <InlineSpinner />
          </SettingRow>
        )}
        {phones?.length === 0 && (
          <SettingRow label={t("settings.phones.listTitle")} description={t("settings.phones.empty")} />
        )}
        {phones?.map((phone) => (
          <SettingRow
            key={phone.id}
            label={
              <span className="block truncate" title={phone.name}>
                {phone.name}
              </span>
            }
            description={[
              phone.platform ? platformLabel[phone.platform] : null,
              t("settings.phones.addedOn", { date: formatDate(phone.createdAt) }),
              lastSynced(phone),
            ]
              .filter(Boolean)
              .join(" · ")}
            control={
              <Button variant="secondary" size="sm" onClick={() => void revoke(phone)}>
                {t("settings.phones.revoke")}
              </Button>
            }
          />
        ))}
      </SettingsGroup>

      {onThisComputer && shell && (
        <SettingsGroup title={t("settings.phones.whenClosedTitle")}>
          <SettingRow
            label={t("settings.phones.keepSyncing")}
            description={t("settings.phones.keepSyncingDescription")}
            control={
              <Switch
                label={t("settings.phones.keepSyncing")}
                checked={shell.keepSyncing}
                onChange={(on) =>
                  void setShellOption(KEEP_SYNCING, { enabled: on }, (s) => ({ ...s, keepSyncing: on }))
                }
              />
            }
          />
          <SettingRow
            label={t("settings.phones.autostart")}
            description={t("settings.phones.autostartDescription")}
            control={
              <Switch
                label={t("settings.phones.autostart")}
                checked={shell.autostart}
                onChange={(on) => void setShellOption(AUTOSTART, { enabled: on }, (s) => ({ ...s, autostart: on }))}
              />
            }
          />
        </SettingsGroup>
      )}

      <PairModal
        open={pairing}
        onClose={() => {
          setPairing(false);
          void load();
        }}
        phones={phones}
        refresh={load}
        invoke={onThisComputer ? invoke : null}
      />
    </div>
  );
}

interface Code {
  code: string;
  payload: string;
  expiresAt: number;
}

function PairModal({
  open,
  onClose,
  phones,
  refresh,
  invoke,
}: {
  open: boolean;
  onClose: () => void;
  phones: Phone[] | null;
  refresh: () => Promise<void>;
  invoke: TauriInvoke | null;
}) {
  if (!open) return null;
  return <PairModalBody onClose={onClose} phones={phones} refresh={refresh} invoke={invoke} />;
}

function PairModalBody({
  onClose,
  phones,
  refresh,
  invoke,
}: {
  onClose: () => void;
  phones: Phone[] | null;
  refresh: () => Promise<void>;
  invoke: TauriInvoke | null;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState<Code | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Phones that were already paired when this opened; a new id means this code worked.
  const [knownIds] = useState(() => new Set(phones?.map((p) => p.id)));
  const newPhone = phones?.find((p) => !knownIds.has(p.id));

  const newCode = useCallback(async () => {
    setError(null);
    setCode(null);
    try {
      // A desktop asks its shell where phones can reach it and for the certificate to trust; a
      // server's address is the one this page was opened on.
      const info = invoke
        ? ((await invoke("companion_open_pairing")) as { addresses: string[]; certSha256: string })
        : { addresses: [window.location.origin], certSha256: undefined };
      const res = await api.post("/companion/v1/pair-codes", info);
      setCode({ code: res.code, payload: res.payload, expiresAt: new Date(res.expiresAt).getTime() });
      setNow(Date.now());
    } catch (err) {
      setError(errorMessage(err, t("settings.phones.codeFailed")));
    }
  }, [invoke, t]);

  useEffect(() => {
    const first = setTimeout(() => void newCode(), 0);
    return () => clearTimeout(first);
  }, [newCode]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => void refresh(), POLL_MS);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [refresh]);

  const remaining = code ? code.expiresAt - now : 0;
  const expired = code !== null && remaining <= 0;
  const image = code && !newPhone ? qrDataUrl(code.payload) : null;

  return (
    <Modal
      open
      onClose={onClose}
      title={t("settings.phones.modalTitle")}
      footer={
        <Button size="sm" variant={newPhone ? "primary" : "secondary"} onClick={onClose}>
          {newPhone ? t("settings.phones.done") : t("settings.phones.cancel")}
        </Button>
      }
    >
      {newPhone ? (
        <p className="text-body text-ink" role="status">
          <span className="font-semibold break-words">{t("settings.phones.paired", { name: newPhone.name })}</span>
          <span className="mt-1 block text-subheadline text-muted">{t("settings.phones.pairedHint")}</span>
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-subheadline text-muted">{t("settings.phones.modalSteps")}</p>
          {/* design-token: the QR sits on white in both themes so cameras can read it */}
          <div className="mx-auto flex aspect-square w-56 items-center justify-center overflow-hidden rounded-panel border border-line bg-white">
            {image ? (
              <img
                src={image}
                alt={t("settings.phones.qrAlt")}
                className={`h-full w-full [image-rendering:pixelated] ${expired ? "opacity-20" : ""}`}
              />
            ) : (
              !error && <InlineSpinner />
            )}
          </div>
          {code && !expired && (
            <div className="text-center">
              {/* The same code for typing; spaced digits so a screen reader reads them one by one. */}
              <p
                className="text-title-2 font-semibold tabular-nums tracking-widest text-ink"
                aria-label={t("settings.phones.typedCode", { digits: code.code.split("").join(" ") })}
              >
                {groupPairingCode(code.code)}
              </p>
              <p className="mt-1 text-footnote text-muted" aria-live="off">
                {t("settings.phones.expiresIn", { time: formatCountdown(remaining) })}
              </p>
            </div>
          )}
          {(expired || error) && (
            <div className="space-y-2 text-center">
              <FormMessage error={error} />
              {expired && <p className="text-footnote text-muted">{t("settings.phones.expired")}</p>}
              <Button variant="secondary" size="sm" onClick={() => void newCode()}>
                {t("settings.phones.newCode")}
              </Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
