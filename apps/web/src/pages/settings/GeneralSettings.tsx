import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import Button from "../../components/Button";
import ReleaseNotes from "../../components/ReleaseNotes";
import { buttonClasses } from "../../lib/buttonClasses";
import FormMessage from "../../components/FormMessage";
import InlineSpinner from "../../components/InlineSpinner";
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
import { Card } from "./shared";

const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;

export default function GeneralSettings() {
  const isTauri = useIsTauri();
  return (
    <>
      <AppearanceSection />
      {/* English is the only language for now; the picker appears once there's another (or the dev pseudo-locale). */}
      {AVAILABLE_LOCALES.length > 1 && <LanguageSection />}
      {isTauri && <AppUpdatesSection />}
      <GettingStartedSection />
    </>
  );
}

function AppearanceSection() {
  const { preference, setPreference } = useTheme();
  const options = [
    { value: "system", label: "Follow system" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ] as const;
  return (
    <Card
      title="Appearance"
      description="Light or dark mode, or follow whatever this device is set to."
      learnMore="appearance"
    >
      <SegmentedControl value={preference} onChange={setPreference} options={options} size="md" />
    </Card>
  );
}

// Only locales with a translation file (plus the dev-only pseudo-locale) are offered, each by
// its own name, so a reader finds their language whatever language is showing.
function LanguageSection() {
  const { t } = useTranslation();
  const { preference, saving, error, setPreference } = useLocalePreference();
  return (
    <Card
      title={t("settings.general.language.title")}
      description={t("settings.general.language.description")}
      learnMore="language"
    >
      <Select
        variant="form"
        aria-label={t("settings.general.language.title")}
        value={AVAILABLE_LOCALES.includes(preference) ? preference : "auto"}
        disabled={saving}
        onChange={(e) => void setPreference(e.target.value)}
        className="max-w-xs"
      >
        <option value="auto">{t("settings.general.language.automatic")}</option>
        {AVAILABLE_LOCALES.map((code) => (
          <option key={code} value={code} lang={code}>
            {nativeLanguageName(code)}
          </option>
        ))}
      </Select>
      <FormMessage error={error} />
    </Card>
  );
}

function GettingStartedSection() {
  return (
    <Card
      title="Getting started"
      description="A quick tour of how Lifer's collection, import, and offline pack features fit together."
      learnMore="general"
    >
      <Link to="/guide" className={buttonClasses("secondary", "sm")}>
        Open the guide
      </Link>
    </Card>
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
function AppUpdatesSection() {
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
    <a href={RELEASES_URL} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">
      Releases page
    </a>
  );

  return (
    <Card title="App updates" description="Check for and install a newer version of Lifer." learnMore="app-updates">
      {currentVersion && <p className="text-sm text-muted">You're on version {currentVersion}.</p>}
      {status === "dev" && <p className="text-sm text-muted">This is a development build, so update checks are off.</p>}
      {status === "idle" && <Button onClick={checkForUpdate}>Check for updates</Button>}
      {status === "checking" && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <InlineSpinner />
          Checking…
        </p>
      )}
      {status === "up-to-date" && (
        <div className="space-y-2">
          <p className="text-sm text-muted">You're on the latest version.</p>
          <button type="button" onClick={checkForUpdate} className="text-sm text-ink underline">
            Check again
          </button>
        </div>
      )}
      {status === "available" && update && (
        <div className="space-y-3 rounded-lg border border-line bg-surface-muted p-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-ink">Update available</p>
            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">New</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted">Installed</span>
            <span className="font-medium text-ink">v{currentVersion ?? "?"}</span>
            <span aria-hidden="true" className="text-muted">
              →
            </span>
            <span className="text-muted">Latest</span>
            <span className="font-medium text-accent">v{update.version}</span>
          </div>
          {/* The release's changelog section. */}
          {update.body && (
            <ReleaseNotes
              markdown={update.body.trim()}
              className="max-h-60 overflow-y-auto break-words text-sm text-muted"
            />
          )}
          <Button onClick={installUpdate}>Update now</Button>
        </div>
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
      {status === "error" && (
        <div className="space-y-2">
          <FormMessage error={error} />
          <button
            type="button"
            onClick={update && !installFailed ? installUpdate : checkForUpdate}
            className="text-sm text-ink underline"
          >
            {update && !installFailed ? "Retry" : "Check again"}
          </button>
        </div>
      )}
      {installFailed && (
        <div className="space-y-2 text-sm text-muted">
          {platform === "mac" && translocated && (
            <p>
              Lifer is running from a temporary location. Move Lifer.app into your Applications folder, then try again.
            </p>
          )}
          {platform === "mac" && !translocated && (
            <>
              <p>macOS blocked Lifer from replacing itself. You can install the new version by hand:</p>
              <Button onClick={openZipDownload}>Download Lifer {update?.version ?? ""} (.zip)</Button>
              <p>Open the downloaded .zip, then drag Lifer into your Applications folder, replacing the old copy.</p>
            </>
          )}
          {platform === "windows" && <p>Download the installer from the {releasesLink} and run it.</p>}
          {platform === "other" && <p>Download the latest version from the {releasesLink}.</p>}
          {platform === "mac" && <p>You can also get it from the {releasesLink}.</p>}
          {/* A manual download isn't notarized, so it gets the first-launch warning again. */}
          {platform === "mac" && !translocated && (
            <p>
              The first time you open the new version, macOS may block it. Open{" "}
              <strong>System Settings, Privacy &amp; Security</strong>, scroll down, click <strong>Open Anyway</strong>,
              then open Lifer again.
            </p>
          )}
          {platform === "windows" && (
            <p>
              Windows may warn "Windows protected your PC" on a manually downloaded installer. Click{" "}
              <strong>More info</strong>, then <strong>Run anyway</strong>.
            </p>
          )}
        </div>
      )}
      {packUpdateCount > 0 && (
        <p className="mt-3 border-t border-line pt-3 text-sm text-ink">
          Pack update available: {pluralize(packUpdateCount, "offline pack")} ready to update.{" "}
          <Link to="/offline-packs" className="font-medium text-accent hover:underline">
            View packs
          </Link>
        </p>
      )}
    </Card>
  );
}
