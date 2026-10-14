import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import type { JobStatus } from "@lifer/shared";
import { api } from "../api/client";
import { useEnterToConfirm } from "../hooks/useEnterToConfirm";
import { useJobPoll } from "../hooks/useJobPoll";
import { useRegions } from "../hooks/useRegions";
import { regionHasChecklist } from "../lib/checklistAdditions";
import { errorMessage } from "../lib/errorMessage";
import { backStateFor } from "../lib/backLabel";
import Button from "./Button";
import FormMessage from "./FormMessage";
import JobProgress from "./JobProgress";
import Modal from "./Modal";
import RegionBrowser from "./RegionBrowser";
import SearchInput from "./SearchInput";
import { formatList } from "../lib/format";
import { useSpeciesName } from "../lib/speciesName";
import type { SpeciesResult } from "./SpeciesPicker";

interface InatSearchResult {
  inatTaxonId: number;
  scientificName: string;
  commonName: string | null;
  iconicTaxon: string | null;
  thumbnailUrl: string | null;
}

type BulkJobStatus = JobStatus & {
  added: number;
  alreadyPresent: number;
  notFound: string[];
};

const NO_RESULTS: InatSearchResult[] = [];

// The "any taxa" search: adds a species from iNaturalist (taxa Lifer has no dataset for) to one
// region's checklist under Other Taxa, as your own checklist addition. Any country or province
// works, since no pack is involved; World and the continents have no checklist of their own.
export default function AddOtherTaxaModal({
  initialQuery,
  initialRegionId,
  onClose,
  onAdded,
}: {
  initialQuery: string;
  initialRegionId?: string | null;
  onClose: () => void;
  /** Hands the added species back (the import screen assigns it) instead of opening its page. */
  onAdded?: (species: SpeciesResult) => void;
}) {
  const speciesName = useSpeciesName();
  const [mode, setMode] = useState<"search" | "bulk">("search");
  const [query, setQuery] = useState(initialQuery);
  // Tagged with the query they answer: any other query is still searching, and the last list stays
  // up meanwhile. Under two characters there's no search, and the list is dropped so it doesn't
  // come back stale.
  const [found, setFound] = useState<{ query: string; results: InatSearchResult[] } | null>(null);
  const searchable = query.trim().length >= 2;
  if (!searchable && found) setFound(null);
  const results = (searchable && found?.results) || NO_RESULTS;
  const searching = searchable && found?.query !== query;
  const [selected, setSelected] = useState<InatSearchResult | null>(null);
  const [regionId, setRegionId] = useState<string | null>(initialRegionId ?? null);
  const { regions } = useRegions();
  const regionsById = useMemo(() => new Map((regions ?? []).map((r) => [r.id, r])), [regions]);
  const pickedRegion = regionId ? regionsById.get(regionId) : undefined;
  const regionOk = regionHasChecklist(pickedRegion, regionsById);
  const regionHint = pickedRegion && !regionOk && (
    <p className="mt-2 text-xs text-muted">
      {pickedRegion.name} has no checklist of its own. Pick a country, or a province or state inside one.
    </p>
  );
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();

  const [bulkText, setBulkText] = useState("");
  const bulkJob = useJobPoll<BulkJobStatus>("/species/other-taxa/bulk/status");
  // Only a run started from this modal is shown, not a finished one from earlier.
  const [bulkStarted, setBulkStarted] = useState(false);
  const bulkStatus = bulkStarted || bulkJob.status?.running ? bulkJob.status : null;

  // Enter confirms the step's main action; the search step has none until a result is picked.
  useEnterToConfirm(confirmAdd, mode === "search" && !!selected && regionOk && !adding);
  useEnterToConfirm(startBulkImport, mode === "bulk" && regionOk && bulkText.trim().length > 0 && !bulkStatus?.running);

  // Each query change cancels the pending timer and any in-flight request, so a slow older
  // response can't overwrite newer results or leave `searching` stuck on.
  useEffect(() => {
    if (query.trim().length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api
        .get<{ results: InatSearchResult[] }>(`/species/inat-search?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        })
        .then((res) => {
          if (!controller.signal.aborted) setFound({ query, results: res.results });
        })
        .catch(() => {
          if (!controller.signal.aborted) setFound({ query, results: [] });
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  async function startBulkImport() {
    const entries = bulkText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (entries.length === 0 || !regionId || !regionOk) return;
    if (await bulkJob.start("/species/other-taxa/bulk", { regionId, entries })) setBulkStarted(true);
  }

  async function confirmAdd() {
    if (!selected || !regionId || !regionOk) return;
    setAdding(true);
    setError(null);
    try {
      const res = await api.post<{ speciesId: string }>("/species/other-taxa", {
        inatTaxonId: selected.inatTaxonId,
        regionId,
      });
      onClose();
      if (onAdded)
        onAdded({ id: res.speciesId, scientific_name: selected.scientificName, common_name: selected.commonName });
      else navigate(`/species/${res.speciesId}`, { state: backStateFor(location, t) });
    } catch (err) {
      setError(errorMessage(err, "Couldn't add that species"));
    } finally {
      setAdding(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Search iNaturalist" size="lg">
      <p className="mb-3 text-xs text-muted">
        For species Lifer has no data for, like insects, plants and fungi. They get a photo and description from
        iNaturalist, but no tier or occurrence data.
      </p>

      <div className="mb-3 flex gap-1 rounded-md border border-line p-0.5 text-sm">
        <button
          type="button"
          onClick={() => setMode("search")}
          className={`flex-1 rounded px-2 py-1 ${mode === "search" ? "bg-surface-muted font-medium text-ink" : "text-muted"}`}
        >
          One species
        </button>
        <button
          type="button"
          onClick={() => setMode("bulk")}
          className={`flex-1 rounded px-2 py-1 ${mode === "bulk" ? "bg-surface-muted font-medium text-ink" : "text-muted"}`}
        >
          Import a list
        </button>
      </div>

      {mode === "bulk" ? (
        <>
          <p className="mb-2 text-xs text-muted">
            One species per line. Scientific names work best; common names and iNaturalist taxon IDs also work.
          </p>
          <textarea
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            placeholder={"Apis mellifera\nBombus impatiens\n..."}
            rows={6}
            disabled={bulkStatus?.running}
            className="mb-3 w-full rounded-md border border-line px-3 py-1.5 font-mono text-xs disabled:opacity-50"
          />
          <p className="mb-2 text-xs text-muted">Which region should these appear under?</p>
          <RegionBrowser regionId={regionId} onChange={setRegionId} allowAnyRegion />
          {regionHint}
          <FormMessage error={bulkJob.actionError} className="mt-2" />
          {bulkStatus && (
            <div className="mt-3 space-y-2 border-t border-line pt-3 text-xs text-muted">
              {bulkStatus.running && (
                <JobProgress
                  status={bulkStatus}
                  phases={{ importing: { label: "Importing", progress: "count" } }}
                  onCancel={() => void bulkJob.cancel("/species/other-taxa/bulk/cancel")}
                  cancelling={bulkJob.cancelling}
                />
              )}
              <p>
                {bulkStatus.running ? "" : bulkStatus.cancelled ? "Cancelled. " : "Done. "}
                {bulkStatus.added} added, {bulkStatus.alreadyPresent} already on the list
                {bulkStatus.notFound.length > 0 && `, ${bulkStatus.notFound.length} not found`}.
              </p>
              {!bulkStatus.running && bulkStatus.notFound.length > 0 && (
                <p className="mt-1">
                  Not found on iNaturalist: <span className="italic">{formatList(bulkStatus.notFound, "unit")}</span>
                </p>
              )}
              <FormMessage error={bulkStatus.error} className="mt-1" />
            </div>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              Close
            </Button>
            <Button
              size="sm"
              onClick={startBulkImport}
              disabled={!regionOk || bulkText.trim().length === 0 || bulkStatus?.running}
            >
              {bulkStatus?.running ? "Importing…" : "Start import"}
            </Button>
          </div>
        </>
      ) : !selected ? (
        <>
          <SearchInput
            value={query}
            onChange={setQuery}
            autoFocus
            placeholder="Scientific or common name…"
            className="mb-3"
          />
          {searching && <p className="text-xs text-muted">Searching…</p>}
          <ul className="space-y-1">
            {results.map((r) => (
              <li key={r.inatTaxonId}>
                <button
                  type="button"
                  onClick={() => setSelected(r)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-muted"
                >
                  {r.thumbnailUrl ? (
                    <img src={r.thumbnailUrl} alt="" loading="lazy" className="h-8 w-8 rounded object-cover" />
                  ) : (
                    <span className="h-8 w-8 rounded bg-surface-muted" />
                  )}
                  <span>
                    <span className="font-medium text-ink">{speciesName(r)}</span>{" "}
                    <span className="italic text-muted">{r.scientificName}</span>
                    {r.iconicTaxon && <span className="ml-1.5 text-xs text-muted">· {r.iconicTaxon}</span>}
                  </span>
                </button>
              </li>
            ))}
            {!searching && query.trim().length >= 2 && results.length === 0 && (
              <li className="px-2 py-1.5 text-sm text-muted">No matches on iNaturalist.</li>
            )}
          </ul>
        </>
      ) : (
        <>
          <div className="mb-3 flex items-center gap-2 border-b border-line pb-3 text-sm">
            {selected.thumbnailUrl ? (
              <img src={selected.thumbnailUrl} alt="" className="h-8 w-8 rounded object-cover" />
            ) : (
              <span className="h-8 w-8 rounded bg-surface-muted" />
            )}
            <span>
              <span className="font-medium text-ink">{speciesName(selected)}</span>{" "}
              <span className="italic text-muted">{selected.scientificName}</span>
            </span>
            <Button variant="ghost" size="sm" onClick={() => setSelected(null)} className="ml-auto">
              Change
            </Button>
          </div>
          <p className="mb-2 text-xs text-muted">Which region should this appear under?</p>
          <RegionBrowser regionId={regionId} onChange={setRegionId} allowAnyRegion />
          {regionHint}
          <FormMessage error={error} className="mt-2" />
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={confirmAdd} disabled={!regionOk} loading={adding}>
              {adding ? "Adding…" : "Add species"}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
