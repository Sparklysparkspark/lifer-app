import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type ApiResponse } from "../../api/client";
import Button from "../../components/Button";
import { FolderBrowser } from "../../components/FolderPicker";
import FolderList from "../../components/FolderList";
import FormMessage from "../../components/FormMessage";
import Menu, { MenuItem, MenuPanel } from "../../components/Menu";
import Switch from "../../components/Switch";
import { useDeploymentMode } from "../../hooks/useDeploymentMode";
import { useDropdownMenu } from "../../hooks/useDropdownMenu";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { ignore } from "../../lib/ignore";
import { pickFolderNative } from "../../lib/pickFolderNative";
import { SettingRow, SettingsGroup } from "./shared";

interface Watched {
  path: string;
  enabled: boolean;
  available: boolean;
}
type Added = ApiResponse<"/library/watched-folders", "post">;
type Notice = { kind: "covered"; by: string } | { kind: "merge"; path: string; count: number };

// Folders Lifer checks for new photos and imports in place. Desktop only: a server watches its
// own library folder.
export default function WatchedFoldersGroup() {
  const { t } = useTranslation();
  const mode = useDeploymentMode();
  const [folders, setFolders] = useState<Watched[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const toast = useToast();
  const { openKey, setOpenKey, ref } = useDropdownMenu<string>();

  const load = useCallback(
    () =>
      api
        .get("/library/watched-folders")
        .then((r) => setFolders(r.folders))
        .catch(ignore("Couldn't load watched folders")),
    [],
  );
  useEffect(() => {
    if (mode === "desktop") void load();
  }, [mode, load]);

  async function change(run: () => Promise<unknown>): Promise<boolean> {
    setError(null);
    try {
      await run();
      await load();
      return true;
    } catch (err) {
      setError(errorMessage(err, t("settings.library.watched.saveFailed")));
      return false;
    }
  }

  // A folder already covered, or one holding watched folders, is never watched twice (ux-rules S11).
  async function add(path: string, merge = false) {
    setNotice(null);
    let res: Added | undefined;
    await change(async () => (res = await api.post("/library/watched-folders", { path, merge })));
    if (!res || res.added) return;
    setNotice(
      res.coveredBy ? { kind: "covered", by: res.coveredBy } : { kind: "merge", path, count: res.contains.length },
    );
  }

  async function stopWatching(f: Pick<Watched, "path" | "enabled">) {
    if (!(await change(() => api.post("/library/watched-folders/remove", { path: f.path })))) return;
    // Undo puts it back as it was, switched off or on.
    const undo = () =>
      change(async () => {
        await api.post("/library/watched-folders", { path: f.path });
        if (!f.enabled) await api.patch("/library/watched-folders", { path: f.path, enabled: false });
      });
    toast.show(t("settings.library.watched.stopped", { folder: f.path }), {
      actions: [{ label: t("common.undo"), onClick: () => void undo() }],
    });
  }

  async function choose() {
    const native = await pickFolderNative();
    if (native === undefined) setBrowsing(true);
    else if (native !== null) await add(native);
  }

  if (mode !== "desktop" || folders === null) return null;
  return (
    <SettingsGroup title={t("settings.library.watched.title")}>
      <SettingRow
        label={t("settings.library.watched.label")}
        description={t("settings.library.watched.description")}
        control={
          <Button size="sm" variant="secondary" onClick={() => void choose()}>
            {t("settings.library.watched.add")}
          </Button>
        }
      >
        <FormMessage error={error} />
        {browsing && (
          <FolderBrowser
            onChoose={(p) => {
              setBrowsing(false);
              void add(p);
            }}
            onCancel={() => setBrowsing(false)}
          />
        )}
        {notice?.kind === "covered" && (
          <p role="status" className="break-words text-callout text-ink">
            {t("settings.library.watched.coveredBy", { folder: notice.by })}
          </p>
        )}
        {notice?.kind === "merge" && (
          <div role="status" className="flex flex-wrap items-center justify-between gap-item">
            <p className="min-w-0 text-callout text-ink">
              {t("settings.library.watched.mergeOffer", { count: notice.count })}
            </p>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="secondary" onClick={() => setNotice(null)}>
                {t("common.cancel")}
              </Button>
              <Button size="sm" variant="primary" autoFocus onClick={() => void add(notice.path, true)}>
                {t("settings.library.watched.merge")}
              </Button>
            </div>
          </div>
        )}
        {folders.length > 0 && (
          <FolderList
            label={t("settings.library.watched.title")}
            folders={folders.map((f) => ({
              ...f,
              available: undefined,
              note: f.available ? undefined : t("settings.library.watched.unavailable"),
            }))}
            renderControl={(f) => (
              <div className="flex shrink-0 items-center gap-2">
                <Switch
                  label={t("settings.library.watched.switchLabel", { folder: f.path })}
                  checked={f.enabled}
                  onChange={(enabled) =>
                    void change(() => api.patch("/library/watched-folders", { path: f.path, enabled }))
                  }
                />
                <Menu
                  open={openKey === f.path}
                  onToggle={() => setOpenKey(openKey === f.path ? null : f.path)}
                  menuRef={ref}
                  className="relative shrink-0"
                  trigger="plain"
                >
                  <MenuPanel className="whitespace-nowrap">
                    <MenuItem onSelect={() => void stopWatching(f)}>{t("settings.library.watched.remove")}</MenuItem>
                  </MenuPanel>
                </Menu>
              </div>
            )}
          />
        )}
      </SettingRow>
    </SettingsGroup>
  );
}
