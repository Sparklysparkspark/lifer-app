import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import Button from "../../components/Button";
import ReleaseNotes from "../../components/ReleaseNotes";
import FormMessage from "../../components/FormMessage";
import JobProgress from "../../components/JobProgress";
import SegmentedControl from "../../components/SegmentedControl";
import Select from "../../components/Select";
import { useLocalePreference } from "../../hooks/useLocalePreference";
import { AVAILABLE_LOCALES } from "../../i18n";
import { nativeLanguageName } from "../../i18n/resolveLocale";
import { useIsTauri } from "../../hooks/useDeploymentMode";
import { useOnline } from "../../hooks/useOnline";
import { useTheme } from "../../hooks/useTheme";
import { DEV_BUILD_VERSION, GITHUB_REPO, macUpdateDownloadUrl } from "../../lib/appInfo";
import { errorMessage } from "../../lib/errorMessage";
import { pluralize } from "../../lib/pluralize";
import { platform } from "../../lib/platform";
import { tauriInvoke } from "../../lib/tauri";
import { APP_UPDATE_PHASES } from "./phases";
import { SettingRow, SettingsGroup } from "./shared";

const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;

export default function GeneralSettings() {
  const isTauri = useIsTauri();
  return (
    <>
      <SettingsGroup title="Appearance">
        <ThemeRow />
        {/* English is the only language for now; the picker appears once there's another (or the dev pseudo-locale). */}
        {AVAILABLE_LOCALES.length > 1 && <LanguageRow />}
      </SettingsGroup>
      <SettingsGroup title="About">
        {isTauri && <AppUpdateRows />}
        <SettingRow
          label="Getting started"
          description="How collections, imports and offline packs fit together."
          control={
            <Link to="/guide" className="text-sm text-ink underline">
              Open the guide
            </Link>
          }
        />
      </SettingsGroup>
    </>
  );
}

function ThemeRow() {
  const { preference, setPreference } = useTheme();
  const options = [
    { value: "system", label: "Follow system" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ] as const;
  return (
    <SettingRow
      label="Theme"
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
          setError(errorMessage(err, "Couldn't check for updates"));
          setStatus("error");
        }),
    [],
  );

  async function checkForUpdate() {
    if (!online) {
      setError("You're offline. Connect to the internet to check for updates.");
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
      setError(errorMessage(err, "Couldn't download the update"));
      setStatus("error");
      return;
    }
    setStatus("installing");
    try {
      await update.install();
    } catch (err) {
      console.error("Update install failed", err);
      setError(errorMessage(err, "Couldn't install the update"));
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
      setError("The update is installed. Quit and reopen Lifer to finish.");
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
      setError(errorMessage(err, "Couldn't open the download link"));
    }
  }

  if (!window.liferSetup) return null;

  const releasesLink = (
    <a href={RELEASES_URL} target="_blank" rel="noreferrer" className="underline">
      Releases page
    </a>
  );

  const version = currentVersion ? `Version ${currentVersion}.` : "";
  let description: string;
  let control: ReactNode = null;
  if (status === "dev") {
    description = `${version} Development build, so update checks are off.`.trim();
  } else if (status === "checking") {
    description = version || "Checking for updates.";
    control = (
      <Button variant="secondary" size="sm" loading>
        Checking…
      </Button>
    );
  } else if (status === "up-to-date") {
    description = `${version} You're up to date.`.trim();
    control = (
      <Button variant="secondary" size="sm" onClick={checkForUpdate}>
        Check again
      </Button>
    );
  } else if (status === "available" && update) {
    description = `Version ${update.version} is available. You have ${currentVersion ?? "an older version"}.`;
    control = (
      <Button variant="secondary" size="sm" onClick={installUpdate}>
        Update now
      </Button>
    );
  } else if (status === "downloading" || status === "installing") {
    description = update ? `Updating to version ${update.version}.` : "Updating.";
  } else if (status === "error") {
    description = version;
    control = (
      <Button variant="secondary" size="sm" onClick={update && !installFailed ? installUpdate : checkForUpdate}>
        {update && !installFailed ? "Retry" : "Check again"}
      </Button>
    );
  } else {
    description = version;
    control = (
      <Button variant="secondary" size="sm" onClick={checkForUpdate}>
        Check for updates
      </Button>
    );
  }

  return (
    <>
      <SettingRow label="App updates" description={description || undefined} control={control}>
        {status === "available" && update?.body && (
          // The release's changelog section.
          <ReleaseNotes
            markdown={update.body.trim()}
            className="max-h-60 overflow-y-auto break-words text-sm text-muted"
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
          <div className="space-y-2 text-sm text-muted">
            {platform === "mac" && translocated && (
              <p>Lifer is running from a temporary location. Move Lifer.app into Applications, then try again.</p>
            )}
            {platform === "mac" && !translocated && (
              <>
                <p>macOS blocked Lifer from replacing itself. You can install the new version by hand:</p>
                <Button variant="secondary" size="sm" onClick={openZipDownload}>
                  Download Lifer {update?.version ?? ""} (.zip)
                </Button>
                <p>Open the .zip, then drag Lifer into Applications, replacing the old copy.</p>
              </>
            )}
            {platform === "windows" && <p>Download the installer from the {releasesLink} and run it.</p>}
            {platform === "other" && <p>Download the latest version from the {releasesLink}.</p>}
            {platform === "mac" && <p>You can also get it from the {releasesLink}.</p>}
            {/* A manual download isn't notarized, so it gets the first-launch warning again. */}
            {platform === "mac" && !translocated && (
              <p>
                If macOS blocks the new version on first open, go to{" "}
                <strong>System Settings, Privacy &amp; Security</strong>, click <strong>Open Anyway</strong>, then open
                Lifer again.
              </p>
            )}
            {platform === "windows" && (
              <p>
                If Windows says "Windows protected your PC", click <strong>More info</strong>, then{" "}
                <strong>Run anyway</strong>.
              </p>
            )}
          </div>
        )}
      </SettingRow>
      {packUpdateCount > 0 && (
        <SettingRow
          label="Offline packs"
          description={`${pluralize(packUpdateCount, "offline pack")} ready to update.`}
          control={
            <Link to="/offline-packs" className="text-sm text-ink underline">
              View packs
            </Link>
          }
        />
      )}
    </>
  );
}
