import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ApiError, api } from "../api/client";
import { errorMessage } from "../lib/errorMessage";
import i18n from "../i18n";
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
import { useLatest } from "./useLatest";

export type { PackDownloadStatus } from "../lib/packDownloadStore";

export interface PackDownloadOptions {
  // Fires once when a run seen running stops (success, error or cancel).
  onFinish?: (status: PackDownloadStatus) => void;
}

function usePackDownloadState(onFinish?: (status: PackDownloadStatus) => void) {
  const { user } = useAuth();
  useEffect(() => setPackDownloadAuthed(!!user), [user]);

  const onFinishRef = useLatest(onFinish);
  useEffect(() => onPackDownloadFinish((s) => onFinishRef.current?.(s)), [onFinishRef]);

  return useSyncExternalStore(subscribePackDownload, getPackDownloadState, getPackDownloadState);
}

// The job's real state lives server-side (offlinePacks/routes.ts), so every screen reflects an
// in-flight download no matter where it was started. All callers share one poller.
export function usePackDownloadJob(
  options: PackDownloadOptions = {},
): JobPoll<PackDownloadStatus> & { cancel: (cancelUrl: string, body?: { downloadsOnly?: boolean }) => Promise<void> } {
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
          setActionError(errorMessage(err, i18n.t("offlinePacks.download.startFailed")));
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

  const cancel = useCallback(async (cancelUrl: string, body?: { downloadsOnly?: boolean }) => {
    setCancelling(true);
    try {
      await api.post(cancelUrl, body ?? {});
      await refreshPackDownload();
    } catch (err) {
      console.error(err);
      if (mounted.current) setActionError(errorMessage(err, i18n.t("offlinePacks.download.cancelFailed")));
    } finally {
      if (mounted.current) setCancelling(false);
    }
  }, []);

  const clearActionError = useCallback(() => setActionError(null), []);

  return {
    status,
    loadError,
    actionError,
    starting,
    cancelling,
    refresh: refreshPackDownload,
    start,
    cancel,
    clearActionError,
  };
}

export function usePackDownloadStatus(options: PackDownloadOptions = {}): PackDownloadStatus | null {
  return usePackDownloadState(options.onFinish).status;
}
