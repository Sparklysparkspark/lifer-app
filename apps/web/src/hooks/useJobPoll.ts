import { useCallback, useEffect, useRef, useState } from "react";
import type { JobStatus } from "@lifer/shared";
import { api, ApiError } from "../api/client";
import { errorMessage } from "../lib/errorMessage";

export interface JobPollOptions<S> {
  // Poll cadence while the job is running.
  intervalMs?: number;
  // Poll cadence while idle, to notice a job started elsewhere. null stops polling when idle
  // (refresh() or start() wakes it up again).
  idleIntervalMs?: number | null;
  // false skips polling entirely (e.g. the job only matters after the user starts it here).
  enabled?: boolean;
  // Fires once when a run this hook saw running stops (success, error or cancel).
  onFinish?: (status: S) => void;
}

export interface JobPoll<S> {
  status: S | null;
  // Set when the status endpoint itself can't be reached (404 outside desktop mode, offline).
  loadError: string | null;
  // Set when start() or cancel() fails.
  actionError: string | null;
  starting: boolean;
  cancelling: boolean;
  refresh: () => Promise<S | null>;
  // POSTs to startUrl, then polls. A 409 (already running) just resumes polling.
  start: (startUrl: string, body?: unknown) => Promise<boolean>;
  // POSTs to cancelUrl. The next poll picks up the cancelled state.
  cancel: (cancelUrl: string) => Promise<void>;
  clearActionError: () => void;
}

// Polls a JobStatus endpoint (see packages/shared/src/job.ts) while its job runs. One recursive
// setTimeout per mounted hook, torn down on unmount or URL change, and responses that arrive
// after that are dropped, so nothing calls setState on an unmounted component.
export function useJobPoll<S extends JobStatus<unknown> = JobStatus<unknown>>(
  statusUrl: string | null,
  options: JobPollOptions<S> = {},
): JobPoll<S> {
  const { intervalMs = 1000, idleIntervalMs = null, enabled = true } = options;
  const [status, setStatus] = useState<S | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const onFinishRef = useRef(options.onFinish);
  onFinishRef.current = options.onFinish;
  // Bumped on unmount/URL change so in-flight responses from an old session are ignored.
  const session = useRef(0);
  // Bumped per poll so only the newest poll schedules the next one.
  const pollSeq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasRunning = useRef(false);
  const live = enabled && statusUrl != null;

  const poll = useCallback(async (): Promise<S | null> => {
    if (!live || !statusUrl) return null;
    const mySession = session.current;
    const mySeq = ++pollSeq.current;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    let next: S | null = null;
    try {
      next = await api.get<S>(statusUrl);
      if (mySession !== session.current) return null;
      setStatus(next);
      setLoadError(null);
      if (wasRunning.current && !next.running) onFinishRef.current?.(next);
      wasRunning.current = next.running;
    } catch (err) {
      if (mySession !== session.current) return null;
      setLoadError(errorMessage(err, "Couldn't reach the server"));
    }
    if (mySession === session.current && mySeq === pollSeq.current) {
      // Keep polling through a transient failure mid-run; otherwise follow the idle cadence.
      const running = next ? next.running : wasRunning.current;
      const delay = running ? intervalMs : idleIntervalMs;
      if (delay != null) timer.current = setTimeout(() => void poll(), delay);
    }
    return next;
  }, [live, statusUrl, intervalMs, idleIntervalMs]);

  useEffect(() => {
    if (!live) return;
    void poll();
    return () => {
      session.current++;
      wasRunning.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [live, poll]);

  const start = useCallback(
    async (startUrl: string, body?: unknown): Promise<boolean> => {
      const mySession = session.current;
      setStarting(true);
      setActionError(null);
      try {
        await api.post(startUrl, body ?? {});
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 409)) {
          console.error(err);
          if (mySession === session.current) {
            setActionError(errorMessage(err, "Couldn't start"));
            setStarting(false);
          }
          return false;
        }
      }
      // Seen as running from here on, so onFinish fires even if the job ends before the next poll.
      wasRunning.current = true;
      await poll();
      if (mySession === session.current) setStarting(false);
      return true;
    },
    [poll],
  );

  const cancel = useCallback(
    async (cancelUrl: string) => {
      const mySession = session.current;
      setCancelling(true);
      try {
        await api.post(cancelUrl, {});
        await poll();
      } catch (err) {
        console.error(err);
        if (mySession === session.current) setActionError(errorMessage(err, "Couldn't cancel"));
      } finally {
        if (mySession === session.current) setCancelling(false);
      }
    },
    [poll],
  );

  const clearActionError = useCallback(() => setActionError(null), []);

  return { status, loadError, actionError, starting, cancelling, refresh: poll, start, cancel, clearActionError };
}
