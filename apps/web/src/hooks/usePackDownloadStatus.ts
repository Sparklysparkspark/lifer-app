import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ApiError, api } from "../api/client";
import { errorMessage } from "../lib/errorMessage";
import {
  getPackDownloadState,
  markPackDownloadStarted,
  onPackDownloadFinish,
  refreshPackDownload,
  setPackDownloadAuthed,
  subscribePackDownload,
  type PackDownloadStatus,
} from "../lib/packDownloadStore";
import type { JobPoll } from "./useJobPoll";
import { useAuth } from "./useAuth";

export type { PackDownloadStatus } from "../lib/packDownloadStore";

// "downloading", "applying", then "photos" per pack; bytes are per pack, processed/total count packs.
export const PACK_DOWNLOAD_PHASES = {
  downloading: { label: "Downloading", progress: "bytes" as const, showItem: true },
  applying: { label: "Applying", progress: "none" as const, showItem: true },
  // The pack's photos this install doesn't have yet, from the shared photo store.
  photos: { label: "Downloading photos", progress: "bytes" as const, showItem: true },
  // A brand-new server still loading its species catalog; the pack is downloaded and waits.
  preparing: { label: "Finishing setup", progress: "none" as const, showItem: false },
  // A newer species catalog is installed before the packs, so none of their species is left out.
  updating_catalog: { label: "Updating the species catalog first", progress: "none" as const, showItem: false },
};

export interface PackDownloadOptions {
  // Fires once when a run seen running stops (success, error or cancel).
  onFinish?: (status: PackDownloadStatus) => void;
}

function usePackDownloadState(onFinish?: (status: PackDownloadStatus) => void) {
  const { user } = useAuth();
  useEffect(() => setPackDownloadAuthed(!!user), [user]);

  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;
  useEffect(() => onPackDownloadFinish((s) => onFinishRef.current?.(s)), []);

  return useSyncExternalStore(subscribePackDownload, getPackDownloadState, getPackDownloadState);
}

// The job's real state lives server-side (offlinePacks/routes.ts), so every screen reflects an
// in-flight download no matter where it was started. All callers share one poller.
export function usePackDownloadJob(options: PackDownloadOptions = {}): JobPoll<PackDownloadStatus> {
  const { status, loadError } = usePackDownloadState(options.onFinish);
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = useCallback(async (startUrl: string, body?: unknown): Promise<boolean> => {
    setStarting(true);
    setActionError(null);
    try {
      await api.post(startUrl, body ?? {});
    } catch (err) {
      // 409 means one is already running: just follow it.
      if (!(err instanceof ApiError && err.status === 409)) {
        console.error(err);
        if (mounted.current) {
          setActionError(errorMessage(err, "Couldn't start"));
          setStarting(false);
        }
        return false;
      }
    }
    markPackDownloadStarted();
    await refreshPackDownload();
    if (mounted.current) setStarting(false);
    return true;
  }, []);

  const cancel = useCallback(async (cancelUrl: string) => {
    setCancelling(true);
    try {
      await api.post(cancelUrl, {});
      await refreshPackDownload();
    } catch (err) {
      console.error(err);
      if (mounted.current) setActionError(errorMessage(err, "Couldn't cancel"));
    } finally {
      if (mounted.current) setCancelling(false);
    }
  }, []);

  const clearActionError = useCallback(() => setActionError(null), []);

  return { status, loadError, actionError, starting, cancelling, refresh: refreshPackDownload, start, cancel, clearActionError };
}

export function usePackDownloadStatus(options: PackDownloadOptions = {}): PackDownloadStatus | null {
  return usePackDownloadState(options.onFinish).status;
}

export function packProgressDetail(status: PackDownloadStatus | null): string | null {
  if (!status?.running || status.total == null || status.total <= 1) return null;
  return `Pack ${Math.min((status.processed ?? 0) + 1, status.total)} of ${status.total}`;
}
