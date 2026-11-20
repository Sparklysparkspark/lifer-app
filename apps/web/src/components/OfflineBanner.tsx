import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOnline } from "../hooks/useOnline";
import { IconButton } from "./Button";
import { createStore } from "../lib/resource";

// Long enough that a blip (Wi-Fi switching networks) never flashes it.
export const OFFLINE_BANNER_DELAY_MS = 4000;
// Per session, like LibraryFolderBanner's: a relaunch brings it back.
const DISMISSED_KEY = "lifer-offline-dismissed";

// Whether the banner is up, so a failed load under it doesn't say "You're offline" a second time.
export const offlineBannerShown = createStore(false);

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** One quiet line docked under the toolbar while the device has been offline for a few seconds,
 *  so a page that can't load says why once, app-wide (ux-rules S9). */
export default function OfflineBanner() {
  const { t } = useTranslation();
  const online = useOnline();
  const [shown, setShown] = useState(false);
  const [dismissed, setDismissed] = useState(readDismissed);

  useEffect(() => {
    if (online) return;
    const timer = setTimeout(() => setShown(true), OFFLINE_BANNER_DELAY_MS);
    return () => {
      clearTimeout(timer);
      setShown(false);
    };
  }, [online]);

  const visible = shown && !dismissed;
  useEffect(() => {
    offlineBannerShown.set(visible);
    return () => offlineBannerShown.set(false);
  }, [visible]);

  if (!visible) return null;
  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-line bg-surface-muted px-6 py-1.5 text-footnote text-muted"
    >
      <p className="min-w-0 flex-1">{t("status.offline.message")}</p>
      <IconButton
        tone="plain"
        onClick={() => {
          try {
            sessionStorage.setItem(DISMISSED_KEY, "1");
          } catch {
            // Storage blocked: hidden until this page reloads.
          }
          setDismissed(true);
        }}
        aria-label={t("status.offline.dismiss")}
      >
        ✕
      </IconButton>
    </div>
  );
}
