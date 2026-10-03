import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { useUploadQueue } from "../../lib/uploadQueue";
import type { EncountersResponse, SpeciesCapture, SpeciesDetail, UnmatchedRaw } from "./types";

const UNAVAILABLE_POLL_START_MS = 8000;
const UNAVAILABLE_POLL_MAX_MS = 60000;

/** Loads a species' detail, encounter summary and unmatched RAWs. Every request is aborted when a
 *  newer one starts or the species changes, so a slow response can't show the previous species. */
export function useSpeciesDetail(id: string | undefined, regionId: string | null) {
  const { jobs: uploadJobs } = useUploadQueue();
  const pendingUploadCount = uploadJobs.filter((j) => j.speciesId === id && !j.done).length;

  const [detail, setDetail] = useState<SpeciesDetail | null>(null);
  const [loadError, setLoadError] = useState(false);
  const detailController = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    setLoadError(false);
    const query = regionId ? `?regionId=${encodeURIComponent(regionId)}` : "";
    api
      .get<SpeciesDetail>(`/species/${id}${query}`, { signal: controller.signal })
      .then((res) => {
        if (!controller.signal.aborted) setDetail(res);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadError(true);
      });
  }, [id, regionId]);

  const [unmatchedRaws, setUnmatchedRaws] = useState<UnmatchedRaw[]>([]);
  const rawsController = useRef<AbortController | null>(null);
  const loadUnmatchedRaws = useCallback(() => {
    if (!id) return;
    rawsController.current?.abort();
    const controller = new AbortController();
    rawsController.current = controller;
    api
      .get<{ rawFiles: UnmatchedRaw[] }>(`/species/${id}/unmatched-raws`, { signal: controller.signal })
      .then((res) => {
        if (!controller.signal.aborted) setUnmatchedRaws(res.rawFiles);
      })
      .catch(() => {
        if (!controller.signal.aborted) setUnmatchedRaws([]);
      });
  }, [id]);

  // A different species must never flash the previous one's data while it loads.
  useEffect(() => {
    setDetail(null);
    setUnmatchedRaws([]);
  }, [id]);

  useEffect(() => {
    load();
    loadUnmatchedRaws();
  }, [load, loadUnmatchedRaws]);

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

  const [encounters, setEncounters] = useState<EncountersResponse | null>(null);
  useEffect(() => {
    if (!id) return;
    setEncounters(null);
    const controller = new AbortController();
    api
      .get<EncountersResponse>(`/species/${id}/encounters`, { signal: controller.signal })
      .then((res) => {
        if (!controller.signal.aborted) setEncounters(res);
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
    setDetail((prev) =>
      prev ? { ...prev, captures: prev.captures.map((c) => (idSet.has(c.id) ? { ...c, ...patch(c) } : c)) } : prev,
    );
  }, []);

  return { detail, loadError, load, updateCaptures, encounters, unmatchedRaws, loadUnmatchedRaws, pendingUploadCount };
}
