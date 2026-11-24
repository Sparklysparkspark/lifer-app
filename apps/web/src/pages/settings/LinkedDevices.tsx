// Desktop apps linked to this server: each is a "sync" key (POST /auth/desktop-link) with the
// device's name, when it last synced and a Revoke. Shown on the server's own Settings > Server.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath, type ApiResponse } from "../../api/client";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import InlineSpinner from "../../components/InlineSpinner";
import { useConfirm } from "../../hooks/useConfirm";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { formatDate } from "../../lib/format";
import { SettingRow, SettingsGroup } from "./shared";

type Device = ApiResponse<"/api-keys">["keys"][number];

export default function LinkedDevices() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const toast = useToast();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { keys } = await api.get("/api-keys");
      setDevices(keys.filter((k) => k.permissions.includes("sync")));
      setError(null);
    } catch (err) {
      setError(errorMessage(err, t("settings.devices.loadFailed")));
    }
  }, [t]);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    return () => clearTimeout(first);
  }, [load]);

  async function revoke(device: Device) {
    const ok = await confirm({
      title: t("settings.devices.revokeConfirm.title", { name: device.name }),
      message: t("settings.devices.revokeConfirm.message"),
      confirmLabel: t("settings.devices.revoke"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(apiPath("/api-keys/{id}", { id: device.id }));
      await load();
    } catch (err) {
      toast.error(errorMessage(err, t("settings.devices.revokeFailed")));
    }
  }

  return (
    <SettingsGroup title={t("settings.devices.title")}>
      <SettingRow label={t("settings.devices.description")}>
        {error && <FormMessage error={error} />}
        {!error && devices === null && <InlineSpinner />}
        {devices?.length === 0 && <p className="text-footnote text-muted">{t("settings.devices.empty")}</p>}
      </SettingRow>
      {devices?.map((device) => (
        <SettingRow
          key={device.id}
          label={
            <span className="block truncate" title={device.name}>
              {device.name}
            </span>
          }
          description={[
            t("settings.devices.linkedOn", { date: formatDate(device.createdAt) }),
            device.lastUsedAt
              ? t("settings.devices.lastUsed", { date: formatDate(device.lastUsedAt) })
              : t("settings.devices.neverUsed"),
          ].join(" · ")}
          control={
            <Button variant="secondary" size="sm" onClick={() => void revoke(device)}>
              {t("settings.devices.revoke")}
            </Button>
          }
        />
      ))}
    </SettingsGroup>
  );
}
