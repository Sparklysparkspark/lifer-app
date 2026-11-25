// Drives and network shares holding the library, and connecting a share through the OS
// (apps/api/src/storageVolumes/networkShares.ts). Pages showing unavailable originals reload on
// LIBRARY_LOCATION_CONNECTED.
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { useToast } from "../hooks/useToast";

export const LIBRARY_LOCATION_CONNECTED = "lifer:library-location-connected";

export interface LibraryLocation {
  mountPath: string;
  name: string;
  status: "connected" | "not_connected" | "not_responding";
  connectable: boolean;
  mountedAt: string | null;
  serverConnected: boolean;
}

export function fetchLibraryLocations(): Promise<LibraryLocation[]> {
  return api.get("/storage-volumes/library-locations").then((res) => res.locations as LibraryLocation[]);
}

/** Connects a share in the background: the OS may take a while or ask for a password, so only the
 *  caller's own button waits, and a toast reports how it went. */
export function useConnectLocation(): (mountPath: string, name: string) => Promise<boolean> {
  const { t } = useTranslation();
  const toast = useToast();
  return useCallback(
    async (mountPath, name) => {
      toast.info(t("libraryLocations.connecting", { name }));
      const location = await api
        .post("/storage-volumes/library-locations/connect", { mountPath })
        .then((res) => res as LibraryLocation)
        .catch(() => null);
      const ok = location?.status === "connected";
      if (ok) {
        toast.success(t("libraryLocations.connected", { name }));
        window.dispatchEvent(new Event(LIBRARY_LOCATION_CONNECTED));
      } else toast.error(t("libraryLocations.failed", { name }));
      return ok;
    },
    [t, toast],
  );
}

// The missing-share notice shows once per share, ever: dismissed ones are kept on this device.
const DISMISSED_KEY = "lifer:libraryLocationDismissed";

function readDismissed(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function isLocationDismissed(mountPath: string): boolean {
  return readDismissed().includes(mountPath);
}

export function dismissLocation(mountPath: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...new Set([...readDismissed(), mountPath])]));
  } catch {
    // Storage blocked: the caller still hides it until this page reloads.
  }
}
