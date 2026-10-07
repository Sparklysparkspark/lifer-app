import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { useUploadQueue } from "../../lib/uploadQueue";
import type { EncountersResponse, SpeciesCapture, SpeciesDetail, UnmatchedRaw } from "./types";

const UNAVAILABLE_POLL_START_MS = 8000;
const UNAVAILABLE_POLL_MAX_MS = 60000;
// One shared empty list, so callers' memos don't see a new array every render.
const NO_RAWS: UnmatchedRaw[] = [];

/** Loads a species' detail, encounter summary and unmatched RAWs. Every request is aborted when a
 *  newer one starts or the species changes, so a slow response can't show the previous species. */
export function useSpeciesDetail(id: string | undefined, regionId: string | null) {
  const { jobs: uploadJobs } = useUploadQueue();
  const pendingUploadCount = uploadJobs.filter((j) => j.speciesId === id && !j.done).length;

  // Each result is tagged with the species it belongs to, so a different species never flashes
  // the previous one's data while it loads. A region change keeps the detail until the new one lands.
  const [loadedDetail, setLoadedDetail] = useState<{ id: string; detail: SpeciesDetail } | null>(null);
  const detail = loadedDetail && loadedDetail.id === id ? loadedDetail.detail : null;
  // The request that failed; a new species or region starts without the old error.
  const requestKey = JSON.stringify([id ?? null, regionId]);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const loadError = failedFor === requestKey;
  const detailController = useRef<AbortController | null>(null);

  const fetchDetail = useCallback(() => {
    if (!id) return;
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    const key = JSON.stringify([id, regionId]);
    const query = regionId ? `?regionId=${encodeURIComponent(regionId)}` : "";
    api
      .get<SpeciesDetail>(`/species/${id}${query}`, { signal: controller.signal })
      .then((res) => {
        if (!controller.signal.aborted) setLoadedDetail({ id, detail: res });
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailedFor(key);
      });
  }, [id, regionId]);

  // A reload asked for by the page or a timer: the error clears while it retries.
  const load = useCallback(() => {
    setFailedFor(null);
    fetchDetail();
  }, [fetchDetail]);

  const [loadedRaws, setLoadedRaws] = useState<{ id: string; rawFiles: UnmatchedRaw[] } | null>(null);
  const unmatchedRaws = loadedRaws && loadedRaws.id === id ? loadedRaws.rawFiles : NO_RAWS;
  const rawsController = useRef<AbortController | null>(null);
  const loadUnmatchedRaws = useCallback(() => {
    if (!id) return;
    rawsController.current?.abort();
    const controller = new AbortController();
    rawsController.current = controller;
    api
      .get<{ rawFiles: UnmatchedRaw[] }>(`/species/${id}/unmatched-raws`, { signal: controller.signal })
      .then((res) => {
        if (!controller.signal.aborted) setLoadedRaws({ id, rawFiles: res.rawFiles });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadedRaws({ id, rawFiles: [] });
      });
  }, [id]);

  // A new species or region is a new request key, so there's no stale error to clear here.
  useEffect(() => {
    fetchDetail();
    loadUnmatchedRaws();
  }, [fetchDetail, loadUnmatchedRaws]);

  useEffect(
    () => () => {
      detailController.current?.abort();
      rawsController.current?.abort();
    },
    [],
  );

  // An upload for this species just finished: reload so the new capture replaces its placeholder.
  const prevPendingUploadCountRef = useRef(pendingUploadCount);
  useEffect(() => {
    if (pendingUploadCount < prevPendingUploadCountRef.current) {
      load();
      loadUnmatchedRaws();
    }
    prevPendingUploadCountRef.current = pendingUploadCount;
  }, [pendingUploadCount, load, loadUnmatchedRaws]);

  const [loadedEncounters, setLoadedEncounters] = useState<{ id: string; encounters: EncountersResponse } | null>(null);
  const encounters = loadedEncounters && loadedEncounters.id === id ? loadedEncounters.encounters : null;
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    api
      .get<EncountersResponse>(`/species/${id}/encounters`, { signal: controller.signal })
      .then((res) => {
        if (!controller.signal.aborted) setLoadedEncounters({ id, encounters: res });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [id]);

  // Recheck while a drive holding an original is unplugged, backing off and pausing while hidden.
  const hasUnavailableOriginal = detail?.captures.some((c) => c.original_available === false) ?? false;
  useEffect(() => {
    if (!hasUnavailableOriginal) return;
    let delay = UNAVAILABLE_POLL_START_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      timer = setTimeout(tick, delay);
    };
    function tick() {
      timer = null;
      if (document.hidden) return;
      load();
      delay = Math.min(delay * 2, UNAVAILABLE_POLL_MAX_MS);
      schedule();
    }
    function onVisibilityChange() {
      if (document.hidden || timer) return;
      delay = UNAVAILABLE_POLL_START_MS;
      load();
      schedule();
    }
    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [hasUnavailableOriginal, load]);

  /** Patches captures in place, for optimistic updates that don't need a full reload. */
  const updateCaptures = useCallback((ids: Iterable<string>, patch: (c: SpeciesCapture) => Partial<SpeciesCapture>) => {
    const idSet = new Set(ids);
    setLoadedDetail((prev) =>
      prev
        ? {
            ...prev,
            detail: {
              ...prev.detail,
              captures: prev.detail.captures.map((c) => (idSet.has(c.id) ? { ...c, ...patch(c) } : c)),
            },
          }
        : prev,
    );
  }, []);

  return { detail, loadError, load, updateCaptures, encounters, unmatchedRaws, loadUnmatchedRaws, pendingUploadCount };
}
