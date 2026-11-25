import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDeploymentMode } from "../hooks/useDeploymentMode";
import { ignore } from "../lib/ignore";
import {
  dismissLocation,
  fetchLibraryLocations,
  isLocationDismissed,
  LIBRARY_LOCATION_CONNECTED,
  type LibraryLocation,
} from "../lib/libraryLocations";
import { IconButton } from "./Button";
import ConnectShareButton from "./ConnectShareButton";

/** One quiet line under the toolbar when a drive or share holding the library isn't reachable.
 *  Desktop only, and once per share: dismissing it is remembered for good. */
export default function LibraryLocationBanner() {
  const { t } = useTranslation();
  const desktop = useDeploymentMode() === "desktop";
  const [missing, setMissing] = useState<LibraryLocation | null>(null);

  const check = useCallback(() => {
    fetchLibraryLocations()
      .then((all) => setMissing(all.find((l) => l.status !== "connected" && !isLocationDismissed(l.mountPath)) ?? null))
      .catch(ignore("Couldn't check the library locations"));
  }, []);

  useEffect(() => {
    if (!desktop) return;
    check();
    window.addEventListener("focus", check);
    window.addEventListener(LIBRARY_LOCATION_CONNECTED, check);
    return () => {
      window.removeEventListener("focus", check);
      window.removeEventListener(LIBRARY_LOCATION_CONNECTED, check);
    };
  }, [desktop, check]);

  if (!desktop || !missing) return null;
  const { name } = missing;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-surface-muted px-6 py-1.5 text-footnote text-muted"
    >
      <p className="min-w-0 flex-1 basis-64 break-words">
        {missing.status === "not_responding"
          ? t("libraryLocations.bannerNotResponding", { name })
          : t("libraryLocations.bannerNotConnected", { name })}
      </p>
      {missing.connectable && missing.status === "not_connected" && (
        <ConnectShareButton mountPath={missing.mountPath} name={name} />
      )}
      <IconButton
        tone="plain"
        onClick={() => {
          dismissLocation(missing.mountPath);
          setMissing(null);
        }}
        aria-label={t("libraryLocations.dismiss")}
      >
        ✕
      </IconButton>
    </div>
  );
}
