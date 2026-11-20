import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import Button from "../../components/Button";
import { FolderBrowser } from "../../components/FolderPicker";
import FolderPath from "../../components/FolderPath";
import FormMessage from "../../components/FormMessage";
import Menu, { MenuItem, MenuPanel } from "../../components/Menu";
import Switch from "../../components/Switch";
import { useDeploymentMode } from "../../hooks/useDeploymentMode";
import { useDropdownMenu } from "../../hooks/useDropdownMenu";
import { errorMessage } from "../../lib/errorMessage";
import { ignore } from "../../lib/ignore";
import { pickFolderNative } from "../../lib/pickFolderNative";
import { SettingRow, SettingsGroup } from "./shared";

interface Watched {
  path: string;
  enabled: boolean;
  available: boolean;
}

// Folders Lifer checks for new photos and imports in place. Desktop only: a server watches its
// own library folder.
export default function WatchedFoldersGroup() {
  const { t } = useTranslation();
  const mode = useDeploymentMode();
  const [folders, setFolders] = useState<Watched[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
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

  async function change(run: () => Promise<unknown>) {
    setError(null);
    try {
      await run();
      await load();
    } catch (err) {
      setError(errorMessage(err, t("settings.library.watched.saveFailed")));
    }
  }

  const add = (path: string) => change(() => api.post("/library/watched-folders", { path }));

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
      </SettingRow>
      {folders.map((f) => (
        <SettingRow
          key={f.path}
          label={<FolderPath path={f.path} />}
          description={f.available ? undefined : t("settings.library.watched.unavailable")}
          control={
            <div className="flex items-center gap-2">
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
                  <MenuItem
                    onSelect={() => void change(() => api.post("/library/watched-folders/remove", { path: f.path }))}
                  >
                    {t("settings.library.watched.remove")}
                  </MenuItem>
                </MenuPanel>
              </Menu>
            </div>
          }
        />
      ))}
    </SettingsGroup>
  );
}
