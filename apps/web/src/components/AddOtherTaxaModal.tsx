import ProgressiveImg from "./ProgressiveImg";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import type { JobStatus } from "@lifer/shared";
import { api, apiPath } from "../api/client";
import { useEnterToConfirm } from "../hooks/useEnterToConfirm";
import { useJobPoll } from "../hooks/useJobPoll";
import { useRegions } from "../hooks/useRegions";
import { useToast } from "../hooks/useToast";
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
import type { SpeciesResult } from "./speciesResult";
import { TextArea } from "./TextField";
import Checkbox from "./Checkbox";
import SegmentedControl from "./SegmentedControl";

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
// Scientific names read the same in every language.
const BULK_PLACEHOLDER = "Apis mellifera\nBombus impatiens\n...";

// The "any taxa" search: adds a species from iNaturalist (taxa Lifer has no dataset for) to one
// region's checklist under Other Taxa, as your own checklist addition. Any country or province
// works, since no pack is involved; World and the continents have no checklist of their own.
export default function AddOtherTaxaModal({
  initialQuery,
  initialRegionId,
  startWithList = false,
  onClose,
  onAdded,
}: {
  initialQuery: string;
  initialRegionId?: string | null;
  /** Opens on the list of names, for the Add species menu's import item. */
  startWithList?: boolean;
  onClose: () => void;
  /** Hands the added species back (the import screen assigns it) instead of opening its page. */
  onAdded?: (species: SpeciesResult) => void;
}) {
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  const toast = useToast();
  const [mode, setMode] = useState<"search" | "bulk">(startWithList ? "bulk" : "search");
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
    <p className="mt-2 text-footnote text-muted">{t("otherTaxa.noChecklist", { region: pickedRegion.name })}</p>
  );
  const [adding, setAdding] = useState(false);
  const [markSeen, setMarkSeen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

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
      // With onAdded the caller decides (a photo being assigned, or a dialog that marks it itself).
      if (!onAdded && markSeen)
        await api
          .patch(apiPath("/species/{id}/seen", { id: res.speciesId }))
          .catch(() => toast.error(t("otherTaxa.markSeenFailed", { name: speciesName(selected) })));
      onClose();
      if (onAdded)
        onAdded({ id: res.speciesId, scientific_name: selected.scientificName, common_name: selected.commonName });
      else navigate(`/species/${res.speciesId}`, { state: backStateFor(location, t) });
    } catch (err) {
      setError(errorMessage(err, t("otherTaxa.addFailed")));
    } finally {
      setAdding(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t("otherTaxa.title")}
      description={t("otherTaxa.intro")}
      footer={
        mode === "bulk" ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              {t("otherTaxa.close")}
            </Button>
            <Button
              onClick={startBulkImport}
              disabled={!regionOk || bulkText.trim().length === 0 || bulkStatus?.running}
            >
              {bulkStatus?.running ? t("otherTaxa.importingEllipsis") : t("otherTaxa.startImport")}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            {selected && (
              <Button onClick={confirmAdd} disabled={!regionOk} loading={adding}>
                {adding ? t("otherTaxa.adding") : t("otherTaxa.addSpecies")}
              </Button>
            )}
          </>
        )
      }
    >
      <div className="mb-3">
        <SegmentedControl
          value={mode}
          onChange={setMode}
          options={[
            { value: "search", label: t("otherTaxa.oneSpecies") },
            { value: "bulk", label: t("otherTaxa.importList") },
          ]}
        />
      </div>

      {mode === "bulk" ? (
        <>
          <p className="mb-2 text-footnote text-muted">{t("otherTaxa.bulkHint")}</p>
          <TextArea
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            placeholder={BULK_PLACEHOLDER}
            rows={6}
            disabled={bulkStatus?.running}
            className="mb-3 font-mono"
          />
          <p className="mb-2 text-footnote text-muted">{t("otherTaxa.whichRegionMany")}</p>
          <RegionBrowser
            regionId={regionId}
            onChange={setRegionId}
            allowAnyRegion
            suggestedRegionIds={[initialRegionId]}
          />
          {regionHint}
          <FormMessage error={bulkJob.actionError} className="mt-2" />
          {bulkStatus && (
            <div className="mt-3 space-y-2 border-t border-line pt-3 text-footnote text-muted">
              {bulkStatus.running && (
                <JobProgress
                  status={bulkStatus}
                  phases={{ importing: { label: t("otherTaxa.importing"), progress: "count" } }}
                  onCancel={() => void bulkJob.cancel("/species/other-taxa/bulk/cancel")}
                  cancelling={bulkJob.cancelling}
                />
              )}
              <p>
                {bulkStatus.running
                  ? ""
                  : `${bulkStatus.cancelled ? t("otherTaxa.bulkCancelled") : t("otherTaxa.bulkDone")} `}
                {bulkStatus.notFound.length > 0
                  ? t("otherTaxa.bulkSummaryNotFound", {
                      added: bulkStatus.added,
                      alreadyPresent: bulkStatus.alreadyPresent,
                      notFound: bulkStatus.notFound.length,
                    })
                  : t("otherTaxa.bulkSummary", { added: bulkStatus.added, alreadyPresent: bulkStatus.alreadyPresent })}
              </p>
              {!bulkStatus.running && bulkStatus.notFound.length > 0 && (
                <p className="mt-1">
                  {t("otherTaxa.notFoundList")}{" "}
                  <span className="italic">{formatList(bulkStatus.notFound, "unit")}</span>
                </p>
              )}
              <FormMessage error={bulkStatus.error} className="mt-1" />
            </div>
          )}
        </>
      ) : !selected ? (
        <>
          <SearchInput
            value={query}
            onChange={setQuery}
            autoFocus
            placeholder={t("otherTaxa.searchPlaceholder")}
            className="mb-3"
          />
          {searching && <p className="text-footnote text-muted">{t("otherTaxa.searching")}</p>}
          <ul className="space-y-1">
            {results.map((r) => (
              <li key={r.inatTaxonId}>
                {/* raw-control: a row of the search results. */}
                <button
                  type="button"
                  onClick={() => setSelected(r)}
                  className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-callout hover:bg-surface-muted"
                >
                  {r.thumbnailUrl ? (
                    <ProgressiveImg thumbSrc={r.thumbnailUrl} alt="" className="h-8 w-8 rounded-badge object-cover" />
                  ) : (
                    <span className="h-8 w-8 rounded-badge bg-surface-muted" />
                  )}
                  <span>
                    <span className="font-medium text-ink">{speciesName(r)}</span>{" "}
                    <span className="italic text-muted">{r.scientificName}</span>
                    {r.iconicTaxon && <span className="ml-1.5 text-footnote text-muted">· {r.iconicTaxon}</span>}
                  </span>
                </button>
              </li>
            ))}
            {!searching && query.trim().length >= 2 && results.length === 0 && (
              <li className="px-2 py-1.5 text-callout text-muted">{t("otherTaxa.noMatches")}</li>
            )}
          </ul>
        </>
      ) : (
        <>
          <div className="mb-3 flex items-center gap-2 border-b border-line pb-3 text-callout">
            {selected.thumbnailUrl ? (
              <img src={selected.thumbnailUrl} alt="" className="h-8 w-8 rounded-badge object-cover" />
            ) : (
              <span className="h-8 w-8 rounded-badge bg-surface-muted" />
            )}
            <span>
              <span className="font-medium text-ink">{speciesName(selected)}</span>{" "}
              <span className="italic text-muted">{selected.scientificName}</span>
            </span>
            <Button variant="ghost" size="sm" onClick={() => setSelected(null)} className="ml-auto">
              {t("otherTaxa.change")}
            </Button>
          </div>
          <p className="mb-2 text-footnote text-muted">{t("otherTaxa.whichRegionOne")}</p>
          <RegionBrowser
            regionId={regionId}
            onChange={setRegionId}
            allowAnyRegion
            suggestedRegionIds={[initialRegionId]}
          />
          {regionHint}
          {!onAdded && (
            <Checkbox checked={markSeen} onChange={setMarkSeen} className="mt-3">
              {t("otherTaxa.markSeen")}
            </Checkbox>
          )}
          <FormMessage error={error} className="mt-2" />
        </>
      )}
    </Modal>
  );
}
