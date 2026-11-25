import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import Button from "../../components/Button";
import { TOUR_STATE } from "../../components/Tour";
import ReleaseNotes from "../../components/ReleaseNotes";
import FormMessage from "../../components/FormMessage";
import JobProgress from "../../components/JobProgress";
import SegmentedControl from "../../components/SegmentedControl";
import Select from "../../components/Select";
import { useLocalePreference } from "../../hooks/useLocalePreference";
import { AVAILABLE_LOCALES } from "../../i18n";
import { nativeLanguageName } from "../../i18n/resolveLocale";
import { useDeploymentMode, useIsTauri } from "../../hooks/useDeploymentMode";
import { useOnline } from "../../hooks/useOnline";
import { useTheme } from "../../hooks/useTheme";
import { DEV_BUILD_VERSION, GITHUB_REPO, macUpdateDownloadUrl } from "../../lib/appInfo";
import { errorMessage } from "../../lib/errorMessage";
import { platform, storeManagedUpdates } from "../../lib/platform";
import { tauriInvoke } from "../../lib/tauri";
import { APP_UPDATE_PHASES } from "./phases";
import { SettingLinkRow, SettingRow, SettingSwitchRow, SettingsGroup } from "./shared";
import MapSettingsRows from "./MapSettingsRows";
import PhotoEditorRow from "./PhotoEditorRow";
import { useServerSetting } from "./useServerSetting";
import { useSettings } from "../../hooks/useSettings";
import Switch from "../../components/Switch";
import { useSpeciesNamePrefs, type AlsoShow } from "../../lib/speciesName";
import { saveSpeciesNames, usePersistedFlag } from "../collection/useCollectionDisplayPrefs";
import Checkbox from "../../components/Checkbox";
import { SPECIES_DOWNLOADS_PATH } from "../../lib/speciesDownloads";

const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;

export default function GeneralSettings() {
  const { t } = useTranslation();
  const isTauri = useIsTauri();
  const mode = useDeploymentMode();
  return (
    <>
      <SettingsGroup title={t("settings.general.appearance")}>
        <ThemeRow />
        {/* English is the only language for now; the picker appears once there's another (or the dev pseudo-locale). */}
        {AVAILABLE_LOCALES.length > 1 && <LanguageRow />}
      </SettingsGroup>
      <SettingsGroup title={t("settings.general.map.title")}>
        <MapSettingsRows />
      </SettingsGroup>
      {/* The files are on this computer only in the desktop app's own library. */}
      {isTauri && mode === "desktop" && (
        <SettingsGroup title={t("settings.general.editor.group")}>
          <PhotoEditorRow />
        </SettingsGroup>
      )}
      <SettingsGroup title={t("settings.general.names.title")}>
        <NameRows />
      </SettingsGroup>
      <SettingsGroup title={t("settings.general.tips.title")}>
        <TipsRows />
      </SettingsGroup>
      <SettingsGroup title={t("settings.general.about")}>
        {isTauri && !storeManagedUpdates && <AppUpdateRows />}
        <SettingLinkRow to="/guide" label={t("settings.general.gettingStarted.openGuide")} />
      </SettingsGroup>
    </>
  );
}

// How species cards name each species, saved to the account for share pages; and the card badges,
// per browser. Every option shows here, since Settings isn't tied to one view.
function NameRows() {
  const { t } = useTranslation();
  const names = useSpeciesNamePrefs();
  const [hideLabels, setHideLabels] = usePersistedFlag("hideLabels");
  const also: Array<{ value: AlsoShow; label: string; title?: string }> = [
    {
      value: "other",
      label: names.main === "scientific" ? t("collection.toolbar.alsoCommon") : t("collection.toolbar.alsoScientific"),
    },
    {
      value: "aba",
      label: t("settings.species.naming.abaCode"),
      title: t("settings.species.naming.abaCodeHint"),
    },
    {
      value: "ebird",
      label: t("settings.species.naming.ebirdCode"),
      title: t("settings.species.naming.ebirdCodeHint"),
    },
  ];
  return (
    <>
      <SettingRow
        label={t("collection.toolbar.mainName")}
        control={
          <SegmentedControl
            value={names.main}
            onChange={(main) => saveSpeciesNames({ main })}
            options={[
              { value: "common", label: t("collection.toolbar.mainNameCommon") },
              { value: "scientific", label: t("collection.toolbar.mainNameScientific") },
            ]}
          />
        }
      />
      <SettingRow
        label={<span id="settings-names-also">{t("collection.toolbar.alsoShow")}</span>}
        description={t("settings.general.names.codesDescription")}
        control={
          <div
            role="group"
            aria-labelledby="settings-names-also"
            className="flex flex-wrap justify-end gap-x-4 gap-y-1"
          >
            {also.map(({ value, label, title }) => (
              <Checkbox
                key={value}
                title={title}
                checked={names.also.includes(value)}
                onChange={(checked) =>
                  saveSpeciesNames({
                    also: checked ? [...names.also, value] : names.also.filter((v) => v !== value),
                  })
                }
              >
                {label}
              </Checkbox>
            ))}
          </div>
        }
      />
      <SettingRow
        label={t("settings.general.names.showCardTags")}
        description={t("settings.general.names.showCardTagsDescription")}
        control={
          <Switch
            label={t("settings.general.names.showCardTags")}
            checked={!hideLabels}
            onChange={(show) => setHideLabels(!show)}
          />
        }
      />
    </>
  );
}

// Tips are on for new accounts; "Show tips again" also turns them back on.
function TipsRows() {
  const { t } = useTranslation();
  const setting = useServerSetting("tipsEnabled", "/settings/tips");
  const { setLocal } = useSettings();
  const navigate = useNavigate();
  const [resetting, setResetting] = useState(false);
  const [reset, setReset] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  async function showAgain() {
    setResetting(true);
    setResetError(null);
    try {
      setLocal(await api.post("/settings/tips/reset"));
      setReset(true);
    } catch (err) {
      setResetError(errorMessage(err, t("settings.general.tips.resetFailed")));
    } finally {
      setResetting(false);
    }
  }

  return (
    <>
      <SettingSwitchRow
        setting={setting}
        label={t("settings.general.tips.show")}
        description={t("settings.general.tips.showDescription")}
      />
      <SettingRow
        label={t("settings.general.tips.showAgain")}
        description={t(reset ? "settings.general.tips.showAgainDone" : "settings.general.tips.showAgainDescription")}
        control={
          <Button variant="secondary" size="sm" onClick={() => void showAgain()} disabled={resetting}>
            {resetting ? t("settings.general.tips.resetting") : t("settings.general.tips.showAgainButton")}
          </Button>
        }
      >
        <FormMessage error={resetError} />
      </SettingRow>
      <SettingRow
        label={t("settings.general.tips.tour")}
        description={t("settings.general.tips.tourDescription")}
        control={
          <Button variant="secondary" size="sm" onClick={() => navigate("/", { state: TOUR_STATE })}>
            {t("tour.start")}
          </Button>
        }
      />
    </>
  );
}

function ThemeRow() {
  const { t } = useTranslation();
  const { preference, setPreference } = useTheme();
  const options = [
    { value: "system", label: t("settings.general.theme.system") },
    { value: "light", label: t("settings.general.theme.light") },
    { value: "dark", label: t("settings.general.theme.dark") },
  ] as const;
  return (
    <SettingRow
      label={t("settings.general.theme.label")}
      control={<SegmentedControl value={preference} onChange={setPreference} options={options} />}
    />
  );
}

// Only locales with a translation file (plus the dev-only pseudo-locale) are offered, each by
// its own name, so a reader finds their language whatever language is showing.
function LanguageRow() {
  const { t } = useTranslation();
  const { preference, saving, error, setPreference } = useLocalePreference();
  return (
    <SettingRow
      label={t("settings.general.language.title")}
      description={t("settings.general.language.description")}
      control={
        <Select
          variant="form"
          aria-label={t("settings.general.language.title")}
          value={AVAILABLE_LOCALES.includes(preference) ? preference : "auto"}
          disabled={saving}
          onChange={(e) => void setPreference(e.target.value)}
        >
          <option value="auto">{t("settings.general.language.automatic")}</option>
          {AVAILABLE_LOCALES.map((code) => (
            <option key={code} value={code} lang={code}>
              {nativeLanguageName(code)}
            </option>
          ))}
        </Select>
      }
    >
      {error && <FormMessage error={error} />}
    </SettingRow>
  );
}

type DownloadEventLike =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

type CheckResult = {
  version: string;
  body?: string;
  download: (onEvent: (e: DownloadEventLike) => void) => Promise<void>;
  install: () => Promise<void>;
};

type UpdateState = "idle" | "checking" | "up-to-date" | "available" | "downloading" | "installing" | "error" | "dev";

// Desktop only. The Tauri updater/process plugins are imported dynamically so the browser build
// never runs their invoke() calls.
function AppUpdateRows() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<UpdateState>("idle");
  const [update, setUpdate] = useState<CheckResult | null>(null);
  const [progress, setProgress] = useState<{ downloaded: number; total: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only set when the install step itself fails (usually macOS refusing to swap the bundle),
  // where a manual download is the way forward.
  const [installFailed, setInstallFailed] = useState(false);
  const [translocated, setTranslocated] = useState(false);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [versionResolved, setVersionResolved] = useState(false);
  const [packUpdateCount, setPackUpdateCount] = useState(0);
  const online = useOnline();

  // The check itself, once "checking" is showing. Only touches state setters, so one copy serves.
  const runUpdateCheck = useCallback(
    (): Promise<void> =>
      import("@tauri-apps/plugin-updater")
        .then(({ check }) => check())
        .then((result) => {
          setUpdate(result ?? null);
          setStatus(result ? "available" : "up-to-date");
        })
        .catch((err) => {
          console.error("Update check failed", err);
          setError(errorMessage(err, t("settings.general.updates.checkFailed")));
          setStatus("error");
        }),
    [t],
  );

  async function checkForUpdate() {
    if (!online) {
      setError(t("settings.general.updates.offline"));
      setStatus("error");
      return;
    }
    setStatus("checking");
    setError(null);
    setInstallFailed(false);
    await runUpdateCheck();
  }

  // Version first: dev builds report DEV_BUILD_VERSION and would always see an "update".
  useEffect(() => {
    if (!window.liferSetup) return;
    import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then((version) => {
        setCurrentVersion(version);
        if (version === DEV_BUILD_VERSION) setStatus("dev");
      })
      .catch(() => {
        // Only the version label depends on it.
      })
      .finally(() => setVersionResolved(true));
  }, []);

  // Checked once the version is known and again whenever connectivity comes back. "checking" is
  // set as the trigger changes, while rendering; the effect then runs the check.
  const autoCheckTrigger = `${online}|${versionResolved}`;
  const [seenTrigger, setSeenTrigger] = useState<string | null>(null);
  const [autoChecks, setAutoChecks] = useState(0);
  if (seenTrigger !== autoCheckTrigger) {
    setSeenTrigger(autoCheckTrigger);
    if (window.liferSetup && online && versionResolved && currentVersion !== DEV_BUILD_VERSION) {
      setStatus("checking");
      setError(null);
      setInstallFailed(false);
      setAutoChecks((n) => n + 1);
    }
  }
  useEffect(() => {
    if (autoChecks > 0) void runUpdateCheck();
  }, [autoChecks, runUpdateCheck]);

  useEffect(() => {
    if (!online) return;
    api
      .get<{ updateCount: number }>("/offline-packs/updates-summary")
      .then((res) => setPackUpdateCount(res.updateCount))
      .catch(() => {
        // Optional extra line; the packs page shows the real state.
      });
  }, [online]);

  async function installUpdate() {
    if (!update) return;
    setStatus("downloading");
    setError(null);
    setInstallFailed(false);
    setProgress(null);
    let totalBytes: number | null = null;
    let downloaded = 0;
    // Download (which verifies the signature) and install are separate so a failure is attributed
    // to the right step. Until the first chunk arrives the bar shows as indeterminate.
    try {
      await update.download((event) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength ?? null;
          setProgress({ downloaded: 0, total: totalBytes });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setProgress({ downloaded, total: totalBytes });
        }
      });
    } catch (err) {
      console.error("Update download failed", err);
      setError(errorMessage(err, t("settings.general.updates.downloadFailed")));
      setStatus("error");
      return;
    }
    setStatus("installing");
    try {
      await update.install();
    } catch (err) {
      console.error("Update install failed", err);
      setError(errorMessage(err, t("settings.general.updates.installFailed")));
      setInstallFailed(true);
      setStatus("error");
      if (platform === "mac") {
        tauriInvoke()?.("app_install_info")
          .then((info) => setTranslocated(Boolean((info as { translocated?: boolean } | null)?.translocated)))
          .catch((infoErr) => console.error("app_install_info failed", infoErr));
      }
      return;
    }
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (err) {
      console.error("Relaunch failed", err);
      setError(t("settings.general.updates.relaunchFailed"));
      setStatus("error");
    }
  }

  async function openZipDownload() {
    if (!update) return;
    const url = macUpdateDownloadUrl(update.version, window.liferSetup?.arch);
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } catch (err) {
      console.error(err);
      setError(errorMessage(err, t("settings.general.updates.openLinkFailed")));
    }
  }

  if (!window.liferSetup) return null;

  // eslint-disable-next-line no-restricted-syntax -- baseline, migrate to openExternal() or a shared link component
  const releasesLink = { a: <a href={RELEASES_URL} target="_blank" rel="noreferrer" className="underline" /> };
  const bold = { b: <strong /> };

  const version = currentVersion ? t("settings.general.updates.version", { version: currentVersion }) : "";
  const withVersion = (text: string) => [version, text].filter(Boolean).join(" ");
  let description: string;
  let control: ReactNode = null;
  if (status === "dev") {
    description = withVersion(t("settings.general.updates.devBuild"));
  } else if (status === "checking") {
    description = version || t("settings.general.updates.checking");
    control = (
      <Button variant="secondary" size="sm" loading>
        {t("settings.general.updates.checkingButton")}
      </Button>
    );
  } else if (status === "up-to-date") {
    description = withVersion(t("settings.general.updates.upToDate"));
    control = (
      <Button variant="secondary" size="sm" onClick={checkForUpdate}>
        {t("settings.general.updates.checkAgain")}
      </Button>
    );
  } else if (status === "available" && update) {
    description = currentVersion
      ? t("settings.general.updates.available", { version: update.version, current: currentVersion })
      : t("settings.general.updates.availableFromOlder", { version: update.version });
    control = (
      <Button variant="secondary" size="sm" onClick={installUpdate}>
        {t("settings.general.updates.updateNow")}
      </Button>
    );
  } else if (status === "downloading" || status === "installing") {
    description = update
      ? t("settings.general.updates.updatingTo", { version: update.version })
      : t("settings.general.updates.updating");
  } else if (status === "error") {
    description = version;
    control = (
      <Button variant="secondary" size="sm" onClick={update && !installFailed ? installUpdate : checkForUpdate}>
        {update && !installFailed ? t("common.retry") : t("settings.general.updates.checkAgain")}
      </Button>
    );
  } else {
    description = version;
    control = (
      <Button variant="secondary" size="sm" onClick={checkForUpdate}>
        {t("settings.general.updates.check")}
      </Button>
    );
  }

  return (
    <>
      <SettingRow label={t("settings.general.updates.label")} description={description || undefined} control={control}>
        {status === "available" && update?.body && (
          // The release's changelog section.
          <ReleaseNotes
            markdown={update.body.trim()}
            className="max-h-60 overflow-y-auto break-words text-callout text-muted"
          />
        )}
        {(status === "downloading" || status === "installing") && (
          <JobProgress
            status={{
              running: true,
              phase: status,
              downloadedBytes: status === "downloading" && progress ? progress.downloaded : null,
              totalBytes: progress?.total ?? null,
              processed: null,
              total: null,
              currentItem: null,
              error: null,
              cancelRequested: false,
              cancelled: false,
            }}
            phases={APP_UPDATE_PHASES}
          />
        )}
        {status === "error" && <FormMessage error={error} />}
        {installFailed && (
          <div className="space-y-2 text-callout text-muted">
            {platform === "mac" && translocated && <p>{t("settings.general.updates.translocated")}</p>}
            {platform === "mac" && !translocated && (
              <>
                <p>{t("settings.general.updates.macBlocked")}</p>
                <Button variant="secondary" size="sm" onClick={openZipDownload}>
                  {t("settings.general.updates.downloadZip", { version: update?.version ?? "" })}
                </Button>
                <p>{t("settings.general.updates.zipSteps")}</p>
              </>
            )}
            {platform === "windows" && (
              <p>
                <Trans i18nKey="settings.general.updates.windowsInstaller" components={releasesLink} />
              </p>
            )}
            {platform === "other" && (
              <p>
                <Trans i18nKey="settings.general.updates.otherDownload" components={releasesLink} />
              </p>
            )}
            {platform === "mac" && (
              <p>
                <Trans i18nKey="settings.general.updates.macAlso" components={releasesLink} />
              </p>
            )}
            {/* A manual download isn't notarized, so it gets the first-launch warning again. */}
            {platform === "mac" && !translocated && (
              <p>
                <Trans i18nKey="settings.general.updates.macGatekeeper" components={bold} />
              </p>
            )}
            {platform === "windows" && (
              <p>
                <Trans i18nKey="settings.general.updates.windowsSmartScreen" components={bold} />
              </p>
            )}
          </div>
        )}
      </SettingRow>
      {packUpdateCount > 0 && (
        <SettingLinkRow
          to={SPECIES_DOWNLOADS_PATH}
          label={t("settings.general.packUpdates.label")}
          description={t("settings.general.packUpdates.description", { count: packUpdateCount })}
        />
      )}
    </>
  );
}
