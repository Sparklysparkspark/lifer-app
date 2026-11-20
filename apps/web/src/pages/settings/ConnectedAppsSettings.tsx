import { Fragment, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath, type ApiResponse } from "../../api/client";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import Switch from "../../components/Switch";
import { useConfirm } from "../../hooks/useConfirm";
import { useDeploymentMode } from "../../hooks/useDeploymentMode";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { getHostPreference, onHostPreference, setHostPreference } from "../../lib/hostPreference";
import { formatDate, formatList, formatRelativeTime } from "../../lib/format";
import {
  opensInBackground,
  useBackgroundPlugins,
  useHiddenPlugins,
  useNoticePlugins,
  usePlugins,
} from "../../lib/plugins";
import { SUGGESTED_APPS, setShowSuggestedApps, useShowSuggestedApps } from "../../lib/suggestedApps";
import { SettingRow, SettingsGroup } from "./shared";

type Key = ApiResponse<"/api-keys">["keys"][number];
type AppChange = ApiResponse<"/changes/apps">["changes"][number];
type Grant = ApiResponse<"/plugins/v1/grants">["grants"][number];

// Rows shown before "Show more"; the API keeps the latest 50.
const CHANGES_SHOWN = 10;

/** Settings > Connected apps: the apps paired with this library and what each may do, with Revoke;
 *  on the desktop, the installed apps and whether each shows in the sidebar; on a server, the code
 *  an app types to pair. */
export default function ConnectedAppsSettings() {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const mode = useDeploymentMode();
  const installed = usePlugins() ?? [];
  const { hidden, hide, show } = useHiddenPlugins();
  const { off, setBackground } = useBackgroundPlugins();
  const { muted, setNotices } = useNoticePlugins();
  const showSuggested = useShowSuggestedApps();
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [changes, setChanges] = useState<AppChange[]>([]);
  const [allChanges, setAllChanges] = useState(false);
  // "Open inside Lifer", per app whose key may ask for it (desktop only).
  const [openInside, setOpenInside] = useState<Record<string, boolean>>({});
  // Apps allowed from Lifer (a suggested app's button) that haven't connected yet.
  const [grants, setGrants] = useState<Grant[]>([]);
  const loadGrants = useCallback(() => {
    if (mode === "desktop")
      api
        .get("/plugins/v1/grants")
        .then((r) => setGrants(r.grants))
        .catch(() => {});
  }, [mode]);
  useEffect(loadGrants, [loadGrants]);

  async function cancelGrant(g: Grant) {
    try {
      await api.delete(apiPath("/plugins/v1/grants/{pluginId}", { pluginId: g.pluginId }));
    } catch (err) {
      toast.error(errorMessage(err, t("connectedApps.cancelGrantFailed")));
    }
    loadGrants();
  }

  // One label per scope an app can hold; anything unknown shows as its id.
  const scopeLabels: Record<string, string> = {
    "userdata.read": t("connectedApps.scope.yourData"),
    "userdata.write": t("connectedApps.scope.yourDataWrite"),
    "imports.write": t("connectedApps.scope.imports"),
    "opendata.read": t("connectedApps.scope.openData"),
    "host.preference": t("connectedApps.scope.hostPreference"),
  };

  const load = useCallback(
    () =>
      api
        .get("/api-keys")
        .then((r) => setKeys(r.keys.filter((k) => k.pluginId)))
        .catch((err) => setError(errorMessage(err, t("connectedApps.loadFailed")))),
    [t],
  );
  const loadChanges = useCallback(
    () =>
      api
        .get("/changes/apps")
        .then((r) => setChanges(r.changes))
        .catch((err) => setError(errorMessage(err, t("connectedApps.changesLoadFailed")))),
    [t],
  );
  useEffect(() => {
    void load();
    void loadChanges();
  }, [load, loadChanges]);

  const askers = (keys ?? []).filter((k) => k.pluginId);
  const askerIds = askers.map((k) => k.pluginId!).join("\n");
  useEffect(() => {
    if (mode !== "desktop" || !askerIds) return;
    const ids = askerIds.split("\n");
    for (const id of ids) {
      getHostPreference(id)
        .then((p) => setOpenInside((was) => ({ ...was, [id]: p.openInHost })))
        .catch(() => {});
    }
    // A Yes in the dialog while this page is open.
    const offs = ids.map((id) => onHostPreference(id, (p) => setOpenInside((was) => ({ ...was, [id]: p.openInHost }))));
    return () => offs.forEach((off) => off());
  }, [mode, askerIds]);

  async function flipOpenInside(pluginId: string, on: boolean) {
    setOpenInside((was) => ({ ...was, [pluginId]: on }));
    try {
      await setHostPreference(pluginId, on);
    } catch (err) {
      setOpenInside((was) => ({ ...was, [pluginId]: !on }));
      toast.error(errorMessage(err, t("connectedApps.openInsideFailed")));
    }
  }

  async function undo(change: AppChange) {
    try {
      await api.post(apiPath("/changes/{id}/undo", { id: change.id }));
      toast.show(t("connectedApps.undone", { summary: change.summary }), { tone: "success" });
    } catch (err) {
      toast.error(errorMessage(err, t("connectedApps.undoFailed")));
    }
    await loadChanges();
  }

  async function revoke(key: Key) {
    const ok = await confirm({
      title: t("connectedApps.revokeTitle", { name: key.name }),
      message: t("connectedApps.revokeMessage"),
      confirmLabel: t("connectedApps.revoke"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(apiPath("/api-keys/{id}", { id: key.id }));
      await load();
    } catch (err) {
      toast.error(errorMessage(err, t("connectedApps.revokeFailed")));
    }
  }

  // Remove only unpairs and hides: the app itself and its files stay where they are.
  async function remove(p: { id: string; name: string }) {
    const ok = await confirm({
      title: t("connectedApps.removeTitle", { name: p.name }),
      message: t("connectedApps.removeMessage"),
      confirmLabel: t("connectedApps.remove"),
      danger: true,
    });
    if (!ok) return;
    try {
      const all = await api.get("/api-keys");
      await Promise.all(
        all.keys.filter((k) => k.pluginId === p.id).map((k) => api.delete(apiPath("/api-keys/{id}", { id: k.id }))),
      );
      hide(p.id);
      toast.show(t("connectedApps.removed", { name: p.name }), { tone: "success" });
    } catch (err) {
      toast.error(errorMessage(err, t("connectedApps.removeFailed")));
    }
    await load();
  }

  async function pair() {
    try {
      setCode(await api.post("/plugins/v1/pair-codes"));
    } catch (err) {
      setError(errorMessage(err, t("connectedApps.codeFailed")));
    }
  }

  return (
    <>
      <FormMessage error={error} />
      {mode === "desktop" && installed.length > 0 && (
        <SettingsGroup title={t("connectedApps.installed")}>
          {installed.map((p) => (
            <Fragment key={p.id}>
              <SettingRow
                label={<span className="break-words">{p.name}</span>}
                control={
                  <Switch
                    label={t("connectedApps.showInSidebar", { name: p.name })}
                    checked={!hidden.has(p.id)}
                    onChange={(on) => (on ? show(p.id) : hide(p.id))}
                  />
                }
                description={t("connectedApps.showInSidebarHint")}
              />
              {p.capabilities.includes("background") && (
                <SettingRow
                  label={t("connectedApps.openInBackground")}
                  control={
                    <Switch
                      label={t("connectedApps.openInBackgroundLabel", { name: p.name })}
                      checked={opensInBackground(p, off)}
                      onChange={(on) => setBackground(p.id, on)}
                    />
                  }
                  description={t("connectedApps.openInBackgroundHint")}
                />
              )}
              {p.capabilities.includes("notifications") && (
                <SettingRow
                  label={t("connectedApps.notices")}
                  control={
                    <Switch
                      label={t("connectedApps.noticesLabel", { name: p.name })}
                      checked={!muted.has(p.id)}
                      onChange={(on) => setNotices(p.id, on)}
                    />
                  }
                />
              )}
              <SettingRow
                label={t("connectedApps.removeRow")}
                description={t("connectedApps.removeHint")}
                control={
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={t("connectedApps.removeLabel", { name: p.name })}
                    onClick={() => void remove(p)}
                  >
                    {t("connectedApps.remove")}
                  </Button>
                }
              />
            </Fragment>
          ))}
        </SettingsGroup>
      )}
      {mode === "desktop" && SUGGESTED_APPS.length > 0 && (
        <SettingsGroup title={t("suggestedApps.title")}>
          <SettingRow
            label={t("suggestedApps.toggle")}
            description={t("suggestedApps.toggleHint")}
            control={
              <Switch label={t("suggestedApps.toggle")} checked={showSuggested} onChange={setShowSuggestedApps} />
            }
          />
        </SettingsGroup>
      )}
      <SettingsGroup title={t("connectedApps.paired")}>
        {keys !== null && keys.length === 0 && grants.length === 0 && <SettingRow label={t("connectedApps.none")} />}
        {keys?.map((k) => (
          <Fragment key={k.id}>
            <SettingRow
              label={<span className="break-words">{k.name}</span>}
              description={[
                formatList(
                  k.permissions.map((s) => scopeLabels[s] ?? s),
                  "unit",
                ),
                k.lastUsedAt
                  ? t("connectedApps.lastUsed", { date: formatDate(k.lastUsedAt) })
                  : t("connectedApps.neverUsed"),
              ].join(". ")}
              control={
                <Button variant="secondary" size="sm" onClick={() => void revoke(k)}>
                  {t("connectedApps.revoke")}
                </Button>
              }
            />
            {/* For apps that can ask, and any already set to open here so it can be turned off. */}
            {mode === "desktop" &&
              k.pluginId &&
              openInside[k.pluginId] !== undefined &&
              (openInside[k.pluginId] ||
                installed.some((p) => p.id === k.pluginId && p.capabilities.includes("host.preference"))) && (
                <SettingRow
                  label={t("connectedApps.openInside")}
                  control={
                    <Switch
                      label={t("connectedApps.openInsideLabel", { name: k.name })}
                      checked={openInside[k.pluginId]}
                      onChange={(on) => void flipOpenInside(k.pluginId!, on)}
                    />
                  }
                />
              )}
          </Fragment>
        ))}
        {grants.map((g) => (
          <SettingRow
            key={g.pluginId}
            label={<span className="break-words">{g.name}</span>}
            description={t("connectedApps.grantWaiting")}
            control={
              <Button
                variant="secondary"
                size="sm"
                aria-label={t("connectedApps.cancelGrantLabel", { name: g.name })}
                onClick={() => void cancelGrant(g)}
              >
                {t("connectedApps.cancelGrant")}
              </Button>
            }
          />
        ))}
        {mode === "server" && (
          <SettingRow
            label={t("connectedApps.pairTitle")}
            description={code ? t("connectedApps.pairCode", { code: code.code }) : t("connectedApps.pairHint")}
            control={
              <Button variant="secondary" size="sm" onClick={() => void pair()}>
                {code ? t("connectedApps.newCode") : t("connectedApps.pair")}
              </Button>
            }
          />
        )}
      </SettingsGroup>
      {/* What apps with "userdata.write" changed, newest first, each undoable on its own. */}
      {changes.length > 0 && (
        <SettingsGroup title={t("connectedApps.changes")}>
          {(allChanges ? changes : changes.slice(0, CHANGES_SHOWN)).map((c) => (
            <SettingRow
              key={c.id}
              label={<span className="break-words">{c.summary}</span>}
              description={
                <span className="break-words">
                  {t("connectedApps.changeBy", { name: c.appName, when: formatRelativeTime(c.createdAt) })}
                </span>
              }
              control={
                c.undoneAt ? (
                  <span className="text-subheadline text-muted">{t("connectedApps.wasUndone")}</span>
                ) : (
                  <Button variant="secondary" size="sm" onClick={() => void undo(c)}>
                    {t("connectedApps.undo")}
                  </Button>
                )
              }
            />
          ))}
          {!allChanges && changes.length > CHANGES_SHOWN && (
            <SettingRow
              label={
                <Button variant="link" size="sm" onClick={() => setAllChanges(true)}>
                  {t("connectedApps.showMoreChanges", { count: changes.length - CHANGES_SHOWN })}
                </Button>
              }
            />
          )}
        </SettingsGroup>
      )}
    </>
  );
}
