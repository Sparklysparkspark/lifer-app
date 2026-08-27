import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

const DISMISSED_VERSION_KEY = "lifer-dismissed-update-version";

// Silent launch-time check — desktop-only (window.liferSetup is absent everywhere else, same
// gating as SettingsPage's AppUpdatesSection, which does the actual download/install). Never a
// forced dialog: a small, dismissible banner pointing at Settings, same fixed-corner treatment
// as MigrationStatusIndicator. Dismissal is remembered per-version (localStorage) so declining
// an update doesn't nag again until a NEWER one ships.
export default function UpdateAvailableBanner() {
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!window.liferSetup) return;
    let cancelled = false;
    import("@tauri-apps/plugin-updater")
      .then(({ check }) => check())
      .then((update) => {
        if (cancelled || !update) return;
        if (localStorage.getItem(DISMISSED_VERSION_KEY) === update.version) return;
        setAvailableVersion(update.version);
      })
      .catch(() => {
        // Silent — this is a background nicety, not something that should surface an error
        // toast on every launch if the network's down or GitHub is unreachable.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!availableVersion || dismissed) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-full border border-line bg-surface px-4 py-2 text-xs text-ink shadow-sm">
      <span>Lifer {availableVersion} is available.</span>
      <Link to="/settings" className="font-medium text-accent hover:underline">
        Update
      </Link>
      <button
        type="button"
        onClick={() => {
          localStorage.setItem(DISMISSED_VERSION_KEY, availableVersion);
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
