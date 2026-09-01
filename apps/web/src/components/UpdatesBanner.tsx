import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../api/client";

const DISMISSED_KEY = "lifer-dismissed-updates";
const GITHUB_REPO = "Sparklysparkspark/lifer-app";

interface PackUpdatesSummary {
  updateCount: number;
  totalBytes: number;
  packIds: string[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

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
  const online = useOnline();
  const location = useLocation();
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [packSummary, setPackSummary] = useState<PackUpdatesSummary | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!online) return;
    let cancelled = false;

    (async () => {
      try {
        if (window.liferSetup) {
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
      } catch {
        // Silent — a background nicety, not worth an error toast if the network's flaky or the
        // updater/GitHub endpoint is unreachable.
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
      {showApp && (
        <Link to="/settings" className="font-medium text-accent hover:underline">
          Update
        </Link>
      )}
      {showPacks && packSummary && (
        <Link
          to="/offline-packs"
          onClick={async () => {
            await api.post("/offline-packs/download", { packIds: packSummary.packIds });
          }}
          className="font-medium text-accent hover:underline"
        >
          Update all packs
        </Link>
      )}
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
