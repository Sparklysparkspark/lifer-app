import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../api/client";
import { usePackDownloadStatus } from "../hooks/usePackDownloadStatus";
import { useIsTauri } from "../hooks/useDeploymentMode";
import { useOnline } from "../hooks/useOnline";
import { formatBytes } from "../lib/format";
import { useTranslation } from "react-i18next";
import { DEV_BUILD_VERSION, GITHUB_REPO } from "../lib/appInfo";
import InlineSpinner from "./InlineSpinner";

const DISMISSED_KEY = "lifer-dismissed-updates";

interface PackUpdatesSummary {
  updateCount: number;
  totalBytes: number;
  packIds: string[];
}

// A newer app version or a different set of stale packs invalidates a prior dismissal.
function dismissalKey(appVersion: string | null, packIds: string[]): string {
  return JSON.stringify({ v: appVersion, p: [...packIds].sort() });
}

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(key: string) {
  try {
    localStorage.setItem(DISMISSED_KEY, key);
  } catch {
    // Dismissed for this session only.
  }
}

// One pill for both app and offline-pack updates, positioned by StatusTray. Skips every check
// while offline and re-checks once back online.
export default function UpdatesBanner() {
  const { t } = useTranslation();
  const isTauri = useIsTauri();
  const online = useOnline();
  const location = useLocation();
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [packSummary, setPackSummary] = useState<PackUpdatesSummary | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // Reflects a pack update started anywhere, and refetches the summary when it finishes so the
  // pill doesn't advertise updates that already downloaded.
  const downloadStatus = usePackDownloadStatus({ onFinish: () => refetchPackSummary() });

  function refetchPackSummary() {
    api
      .get<PackUpdatesSummary>("/offline-packs/updates-summary")
      .then((res) => setPackSummary(res.updateCount > 0 ? res : null))
      .catch(() => {
        // Silent, like the mount-time fetch below.
      });
  }

  // Re-checked when leaving Offline packs, where something may have just downloaded.
  const onPacksPage = location.pathname === "/offline-packs";
  useEffect(() => {
    if (!online) return;
    let cancelled = false;

    (async () => {
      try {
        if (isTauri) {
          const { getVersion } = await import("@tauri-apps/api/app");
          if ((await getVersion()) === DEV_BUILD_VERSION) return;
          const { check } = await import("@tauri-apps/plugin-updater");
          const update = await check();
          if (!cancelled && update) setAppVersion(update.version);
        } else {
          const [versionRes, releaseRes] = await Promise.all([
            fetch("/version").then((r) => r.json() as Promise<{ version: string }>),
            fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`).then(
              (r) => r.json() as Promise<{ tag_name?: string }>,
            ),
          ]);
          if (cancelled || versionRes.version === "dev" || !releaseRes.tag_name) return;
          const latest = releaseRes.tag_name.replace(/^v/, "");
          if (latest !== versionRes.version) setAppVersion(latest);
        }
      } catch (err) {
        // A background nicety, not worth an error toast if the network's flaky or the
        // updater/GitHub endpoint is unreachable. Settings shows the real error.
        console.error("Background update check failed", err);
      }
    })();

    api
      .get<PackUpdatesSummary>("/offline-packs/updates-summary")
      .then((res) => {
        // Also clears back to null at 0, so a stale count doesn't linger.
        if (!cancelled) setPackSummary(res.updateCount > 0 ? res : null);
      })
      .catch(() => {
        // Silent: a background nicety.
      });

    return () => {
      cancelled = true;
    };
  }, [online, onPacksPage, isTauri]);

  // Offline packs shows per-pack state inline, so only the pack half is hidden there.
  const showPacks = packSummary !== null && location.pathname !== "/offline-packs";
  const showApp = appVersion !== null;

  if (!online || dismissed || (!showPacks && !showApp)) return null;
  const key = dismissalKey(appVersion, packSummary?.packIds ?? []);
  if (readDismissed() === key) return null;

  return (
    <div className="flex items-center gap-3 rounded-full border border-line bg-surface px-4 py-2 text-xs text-ink shadow-sm">
      <span>
        {showApp && t("updates.appAvailable", { version: appVersion })}
        {showApp && showPacks && " "}
        {showPacks && packSummary && (
          <>
            {t("updates.packsAvailable", {
              count: packSummary.updateCount,
              size: formatBytes(packSummary.totalBytes),
            })}
          </>
        )}
      </span>
      {showApp && isTauri && (
        <Link to="/settings/general" className="font-medium text-accent hover:underline">
          {t("updates.update")}
        </Link>
      )}
      {showApp && !isTauri && (
        // A server updates by pulling a new image, so link to the release notes instead.
        <a
          href={`https://github.com/${GITHUB_REPO}/releases/latest`}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-accent hover:underline"
        >
          {t("updates.seeWhatsNew")}
        </a>
      )}
      {showPacks &&
        packSummary &&
        (downloadStatus?.running ? (
          <span className="inline-flex items-center gap-1 font-medium text-muted">
            <InlineSpinner />
            {downloadStatus.total != null && downloadStatus.total > 1
              ? t("updates.updatingPacksProgress", {
                  current: Math.min((downloadStatus.processed ?? 0) + 1, downloadStatus.total),
                  total: downloadStatus.total,
                })
              : t("updates.updating")}
          </span>
        ) : (
          <Link
            to="/offline-packs"
            onClick={() => {
              api
                .post("/offline-packs/download", { packIds: packSummary.packIds })
                .catch((err) => console.error("Couldn't start pack update", err));
            }}
            className="font-medium text-accent hover:underline"
          >
            {t("updates.updateAllPacks")}
          </Link>
        ))}
      <button
        type="button"
        onClick={() => {
          writeDismissed(key);
          setDismissed(true);
        }}
        aria-label={t("updates.dismiss")}
        className="text-muted hover:text-ink"
      >
        ✕
      </button>
    </div>
  );
}
