import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import RegionBrowser from "./RegionBrowser";
import SearchInput from "./SearchInput";

interface InatSearchResult {
  inatTaxonId: number;
  scientificName: string;
  commonName: string | null;
  iconicTaxon: string | null;
  thumbnailUrl: string | null;
}

interface BulkJobStatus {
  running: boolean;
  processed: number;
  total: number;
  added: number;
  alreadyPresent: number;
  notFound: string[];
  error: string | null;
  finishedAt: number | null;
}

// Settings > Species & Import's "any taxa" search, opened from SpeciesPicker when a jump-to-
// species query has no local match and the feature is enabled — pulls a species straight from
// iNaturalist (insects, arachnids, plants, fungi, anything Lifer has no real dataset for) and
// drops it onto one region's checklist under "Other Taxa," reusing the exact same region picker
// (RegionBrowser) the import flow already uses, per the user's own request to keep this
// consistent with that existing control rather than build a second one — but with
// allowAnyRegion set, since adding a single iNat species to a region has nothing to do with
// having a species pack downloaded for it.
export default function AddOtherTaxaModal({
  initialQuery,
  initialRegionId,
  onClose,
}: {
  initialQuery: string;
  initialRegionId?: string | null;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"search" | "bulk">("search");
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<InatSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<InatSearchResult | null>(null);
  const [regionId, setRegionId] = useState<string | null>(initialRegionId ?? null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [bulkText, setBulkText] = useState("");
  const [bulkStatus, setBulkStatus] = useState<BulkJobStatus | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Same scroll lock Lightbox uses — this modal's own content scrolls internally
  // (overflow-y-auto on its panel), but without this the page underneath kept scrolling right
  // along with it on any wheel input that missed the panel.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      api
        .get<{ results: InatSearchResult[] }>(`/species/inat-search?q=${encodeURIComponent(query)}`)
        .then((res) => setResults(res.results))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  async function startBulkImport() {
    const entries = bulkText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (entries.length === 0 || !regionId) return;
    setBulkError(null);
    try {
      await api.post("/species/other-taxa/bulk", { regionId, entries });
    } catch (err) {
      setBulkError(err instanceof ApiError ? err.message : "Couldn't start the import");
      return;
    }
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      api
        .get<BulkJobStatus>("/species/other-taxa/bulk/status")
        .then((status) => {
          setBulkStatus(status);
          if (!status.running && pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
        })
        .catch(() => {});
    }, 1000);
  }

  async function confirmAdd() {
    if (!selected || !regionId) return;
    setAdding(true);
    setError(null);
    try {
      const res = await api.post<{ speciesId: string }>("/species/other-taxa", {
        inatTaxonId: selected.inatTaxonId,
        regionId,
      });
      onClose();
      navigate(`/species/${res.speciesId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that species");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-md border border-line bg-surface p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-sm font-medium text-ink">Search iNaturalist</h2>
        <p className="mb-3 text-xs text-muted">
          For taxa Lifer doesn't have a dataset for (insects, arachnids, plants, fungi, and more). No species tiers or
          occurrence data, just a photo and description pulled from iNaturalist.
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
              Paste one entry per line — scientific names work best, common names or raw iNaturalist taxon IDs also
              work (handy for building your own target list, like every bee species in a region, or sharing one with
              someone else on the same instance).
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
            {bulkError && <p className="mt-2 text-sm text-red-600">{bulkError}</p>}
            {bulkStatus && (
              <div className="mt-3 rounded-md border border-line px-3 py-2 text-xs text-muted">
                <p>
                  {bulkStatus.running ? "Importing…" : "Done."} {bulkStatus.processed}/{bulkStatus.total} processed
                  {" — "}
                  {bulkStatus.added} added, {bulkStatus.alreadyPresent} already on the list
                  {bulkStatus.notFound.length > 0 && `, ${bulkStatus.notFound.length} not found`}.
                </p>
                {!bulkStatus.running && bulkStatus.notFound.length > 0 && (
                  <p className="mt-1">
                    Not found on iNaturalist: <span className="italic">{bulkStatus.notFound.join(", ")}</span>
                  </p>
                )}
                {bulkStatus.error && <p className="mt-1 text-red-600">{bulkStatus.error}</p>}
              </div>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-muted">
                Close
              </button>
              <button
                type="button"
                onClick={startBulkImport}
                disabled={!regionId || bulkText.trim().length === 0 || bulkStatus?.running}
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-50"
              >
                {bulkStatus?.running ? "Importing…" : "Start import"}
              </button>
            </div>
          </>
        ) : !selected ? (
          <>
            <SearchInput value={query} onChange={setQuery} autoFocus placeholder="Scientific or common name…" className="mb-3" />
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
                      <img src={r.thumbnailUrl} alt="" className="h-8 w-8 rounded object-cover" />
                    ) : (
                      <span className="h-8 w-8 rounded bg-surface-muted" />
                    )}
                    <span>
                      <span className="font-medium text-ink">{r.commonName ?? r.scientificName}</span>{" "}
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
            <div className="mb-3 flex items-center gap-2 rounded-md border border-line px-2 py-1.5 text-sm">
              {selected.thumbnailUrl ? (
                <img src={selected.thumbnailUrl} alt="" className="h-8 w-8 rounded object-cover" />
              ) : (
                <span className="h-8 w-8 rounded bg-surface-muted" />
              )}
              <span>
                <span className="font-medium text-ink">{selected.commonName ?? selected.scientificName}</span>{" "}
                <span className="italic text-muted">{selected.scientificName}</span>
              </span>
              <button type="button" onClick={() => setSelected(null)} className="ml-auto text-xs text-muted hover:underline">
                Change
              </button>
            </div>
            <p className="mb-2 text-xs text-muted">Which region should this appear under?</p>
            <RegionBrowser regionId={regionId} onChange={setRegionId} allowAnyRegion />
            {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-muted">
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmAdd}
                disabled={!regionId || adding}
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-50"
              >
                {adding ? "Adding…" : "Add species"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
