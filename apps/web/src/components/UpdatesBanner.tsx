import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../api/client";
import { usePackDownloadStatus } from "../hooks/usePackDownloadStatus";
import { useIsTauri } from "../hooks/useDeploymentMode";
import { formatBytes } from "../lib/formatBytes";

const DISMISSED_KEY = "lifer-dismissed-updates";
const GITHUB_REPO = "Sparklysparkspark/lifer-app";

interface PackUpdatesSummary {
  updateCount: number;
  totalBytes: number;
  packIds: string[];
}

// Dev builds report this version and would always see an "update".
const DEV_BUILD_VERSION = "0.1.0";

// Same reasoning as this file's own dismissal key, generalized to cover both facts at once —
// changing EITHER (a newer app version ships, or the set of stale packs changes) invalidates a
// prior dismissal, rather than the two dismissals living independently and one going stale
// silently forever.
function dismissalKey(appVersion: string | null, packIds: string[]): string {
  return JSON.stringify({ v: appVersion, p: [...packIds].sort() });
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);
  return online;
}

// Replaces the previous two independent pills (UpdateAvailableBanner/DockerUpdateBanner for the
// app itself, PackUpdatesBanner for offline packs) with one, since a user seeing two floating
// pills at once for two different kinds of "update available" read as visual clutter rather than
// two distinct pieces of information. Same fixed-corner treatment as MigrationStatusIndicator.
// Skips every check entirely while offline (`useOnline` below) rather than letting fetches fail
// silently — there's nothing to check without a connection, and re-checks automatically once
// back online.
export default function UpdatesBanner() {
  const isTauri = useIsTauri();
  const online = useOnline();
  const location = useLocation();
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [packSummary, setPackSummary] = useState<PackUpdatesSummary | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // Server-truth job status — lets this banner reflect a pack update in progress (started from
  // here, from Settings, or from the Offline Packs page) instead of only knowing about the
  // stale "N updates available" count from the last updates-summary fetch.
  const downloadStatus = usePackDownloadStatus();

  function refetchPackSummary() {
    api
      .get<PackUpdatesSummary>("/offline-packs/updates-summary")
      .then((res) => setPackSummary(res.updateCount > 0 ? res : null))
      .catch(() => {
        // Silent — same reasoning as the mount-time fetch below.
      });
  }

  // Refetch the instant a job we can see finishes, rather than waiting for the user to leave
  // the Offline Packs page or reload — this is what makes the pill actually clear once an
  // update kicked off from HERE (or from Settings) completes, instead of it sitting there
  // advertising updates that already downloaded.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (downloadStatus === null) return;
    if (wasRunning.current && !downloadStatus.running) refetchPackSummary();
    wasRunning.current = downloadStatus.running;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloadStatus?.running]);

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
            fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`).then((r) => r.json() as Promise<{ tag_name?: string }>),
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
        // Always sync to the fresh result, including back to null when updateCount is 0 —
        // previously this only ever set a nonzero summary and never cleared it, so a stale
        // "N updates available" banner stuck around forever once shown once, even after the
        // user updated everything (e.g. from the Offline Packs page directly).
        if (!cancelled) setPackSummary(res.updateCount > 0 ? res : null);
      })
      .catch(() => {
        // Silent — same reasoning as above.
      });

    return () => {
      cancelled = true;
    };
    // Re-checked whenever the user navigates away from Offline Packs (having potentially just
    // downloaded something there), not on every route change generally.
  }, [online, location.pathname === "/offline-packs"]);

  // Offline Packs already shows per-pack update state inline — only suppress THAT half here,
  // an app-version update is still worth surfacing on that page too.
  const showPacks = packSummary !== null && location.pathname !== "/offline-packs";
  const showApp = appVersion !== null;

  if (!online || dismissed || (!showPacks && !showApp)) return null;
  const key = dismissalKey(appVersion, packSummary?.packIds ?? []);
  if (localStorage.getItem(DISMISSED_KEY) === key) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 flex items-center gap-3 rounded-full border border-line bg-surface px-4 py-2 text-xs text-ink shadow-sm">
      <span>
        {showApp && <>Lifer {appVersion} is available.</>}
        {showApp && showPacks && " "}
        {showPacks && packSummary && (
          <>
            {packSummary.updateCount} pack update{packSummary.updateCount === 1 ? "" : "s"} available (
            {formatBytes(packSummary.totalBytes)}).
          </>
        )}
      </span>
      {showApp && isTauri && (
        <Link to="/settings/general" className="font-medium text-accent hover:underline">
          Update
        </Link>
      )}
      {showApp && !isTauri && (
        // Self-hosted/Docker has no in-app way to apply an update at all — it only ever happens
        // by pulling a new image externally (Docker Compose, TrueNAS, etc.), so a "Update" link
        // into Settings was a dead end (AppUpdatesSection there is desktop-only and renders
        // nothing here, see its useIsTauri gate). Links out to the release notes
        // instead, which is genuinely useful information this banner can offer even though it
        // can't perform the update itself.
        <a
          href={`https://github.com/${GITHUB_REPO}/releases/latest`}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-accent hover:underline"
        >
          See what's new
        </a>
      )}
      {showPacks &&
        packSummary &&
        (downloadStatus?.running ? (
          <span className="font-medium text-muted">
            <span className="mr-1 inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent/40 border-t-accent align-[-2px]" />
            {downloadStatus.total != null && downloadStatus.total > 1
              ? `Updating packs (${Math.min((downloadStatus.processed ?? 0) + 1, downloadStatus.total)} of ${downloadStatus.total})`
              : "Updating…"}
          </span>
        ) : (
          <Link
            to="/offline-packs"
            onClick={() => {
              api.post("/offline-packs/download", { packIds: packSummary.packIds }).catch((err) => console.error("Couldn't start pack update", err));
            }}
            className="font-medium text-accent hover:underline"
          >
            Update all packs
          </Link>
        ))}
      <button
        type="button"
        onClick={() => {
          localStorage.setItem(DISMISSED_KEY, key);
          setDismissed(true);
        }}
        aria-label="Dismiss"
        className="text-muted hover:text-ink"
      >
        ✕
      </button>
    </div>
  );
}
