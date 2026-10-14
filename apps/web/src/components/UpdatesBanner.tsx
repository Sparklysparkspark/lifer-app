import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../api/client";
import { usePackDownloadStatus } from "../hooks/usePackDownloadStatus";
import { useIsTauri } from "../hooks/useDeploymentMode";
import { useOnline } from "../hooks/useOnline";
import { formatBytes } from "../lib/format";
import { ignore } from "../lib/ignore";
import { useTranslation } from "react-i18next";
import { backStateFor } from "../lib/backLabel";
import { DEV_BUILD_VERSION, GITHUB_REPO } from "../lib/appInfo";
import InlineSpinner from "./InlineSpinner";

const DISMISSED_KEY = "lifer-dismissed-updates";

interface PackUpdatesSummary {
  updateCount: number;
  totalBytes: number;
  packIds: string[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return (await res.json()) as T;
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

// One slim line under AppNav for both app and offline-pack updates. Skips every check
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
  // notice doesn't advertise updates that already downloaded.
  const downloadStatus = usePackDownloadStatus({ onFinish: () => refetchPackSummary() });

  function refetchPackSummary() {
    api
      .get<PackUpdatesSummary>("/offline-packs/updates-summary")
      .then((res) => setPackSummary(res.updateCount > 0 ? res : null))
      .catch(ignore("Couldn't check for pack updates"));
  }

  // The app version is checked once per time online: GitHub's unauthenticated API allows only 60
  // requests an hour per IP.
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
            fetchJson<{ version: string }>("/version"),
            fetchJson<{ tag_name?: string }>(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`),
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

    return () => {
      cancelled = true;
    };
  }, [online, isTauri]);

  // Re-checked when leaving Offline packs, where something may have just downloaded.
  const onPacksPage = location.pathname === "/offline-packs";
  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    api
      .get<PackUpdatesSummary>("/offline-packs/updates-summary")
      .then((res) => {
        // Also clears back to null at 0, so a stale count doesn't linger.
        if (!cancelled) setPackSummary(res.updateCount > 0 ? res : null);
      })
      .catch(ignore("Couldn't check for pack updates"));
    return () => {
      cancelled = true;
    };
  }, [online, onPacksPage]);

  // Offline packs shows per-pack state inline, so only the pack half is hidden there.
  const showPacks = packSummary !== null && location.pathname !== "/offline-packs";
  const showApp = appVersion !== null;

  if (!online || dismissed || (!showPacks && !showApp)) return null;
  const key = dismissalKey(appVersion, packSummary?.packIds ?? []);
  if (readDismissed() === key) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface px-6 py-1.5 text-xs text-ink">
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
        <Link
          to="/settings/general"
          state={backStateFor(location, t)}
          className="font-medium text-accent hover:underline"
        >
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
            state={backStateFor(location, t)}
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
        className="ml-auto text-muted hover:text-ink"
      >
        ✕
      </button>
    </div>
  );
}
