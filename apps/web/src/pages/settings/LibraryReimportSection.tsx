import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { CullMarksOption, JobStatus } from "@lifer/shared";
import { api, apiPath } from "../../api/client";
import Button from "../../components/Button";
import { FolderBrowser } from "../../components/FolderPicker";
import { pickFolderNative } from "../../lib/pickFolderNative";
import FormMessage from "../../components/FormMessage";
import FolderPath from "../../components/FolderPath";
import { useLightbox } from "../../components/Lightbox";
import JobProgress from "../../components/JobProgress";
import Select from "../../components/Select";
import Switch from "../../components/Switch";
import { useConfirm } from "../../hooks/useConfirm";
import { useServerInfo } from "../../hooks/useDeploymentMode";
import { useJobPoll } from "../../hooks/useJobPoll";
import { useStorageVolumes } from "../../hooks/useStorageVolumes";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { REIMPORT_PHASES } from "./phases";
import { SettingRow, SettingsGroup } from "./shared";
import { formatList } from "../../lib/format";
import { useSpeciesName } from "../../lib/speciesName";
import { ignore } from "../../lib/ignore";
import { SPECIES_DOWNLOADS_PATH } from "../../lib/speciesDownloads";

interface SpeciesSuggestion {
  inatTaxonId: number;
  scientificName: string;
  commonName: string | null;
  exact: boolean;
}

interface UnmatchedFile {
  relativePath: string;
  contentHash: string | null;
  scientificNames: string[] | null;
  suggestion?: SpeciesSuggestion | null;
}

type ReimportStatus = JobStatus<{ missingReferenceData: string[] }> & {
  processedJpegs: number;
  totalJpegs: number;
  processedRaws: number;
  totalRaws: number;
  jpegsRecovered: number;
  jpegsAlreadyKnown: number;
  jpegsRelinked: number;
  jpegsMoved: number;
  jpegsIgnored: number;
  jpegsRejected: number;
  jpegsHidden: number;
  unmatched: UnmatchedFile[];
  rawsRecovered: number;
  rawsAlreadyKnown: number;
  rawsRelinked: number;
  rawsMoved: number;
  rawsUnmatched: number;
};

// Previews are keyed by content hash, so they stay right when an Ignore shifts the list. A row
// without a hash falls back to its position; the list is refetched after an Ignore for that reason.
export function UnmatchedReviewPanel({
  files,
  onIgnored,
}: {
  files: UnmatchedFile[];
  onIgnored: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [ignoringHash, setIgnoringHash] = useState<string | null>(null);
  const [assigningTaxon, setAssigningTaxon] = useState<number | null>(null);
  const viewer = useLightbox();
  // The index route can't bust the browser cache per file, so it gets the path as a key.
  const previewUrl = (f: UnmatchedFile, i: number) =>
    f.contentHash
      ? `/api/library/reimport/unmatched-preview-by-hash/${encodeURIComponent(f.contentHash)}`
      : `/api/library/reimport/unmatched-preview/${i}?p=${encodeURIComponent(f.relativePath)}`;
  const slides = files.map((f, i) => ({ url: previewUrl(f, i), caption: f.relativePath }));
  const speciesName = useSpeciesName();
  const speciesLabel = (s: SpeciesSuggestion) =>
    speciesName(s) === s.scientificName ? s.scientificName : `${speciesName(s)} (${s.scientificName})`;

  // Confirms a suggestion for every listed photo it was made for: a folder of one species is one click.
  async function assign(suggestion: SpeciesSuggestion) {
    const contentHashes = files
      .filter((f) => f.contentHash && f.suggestion?.inatTaxonId === suggestion.inatTaxonId)
      .map((f) => f.contentHash!);
    setAssigningTaxon(suggestion.inatTaxonId);
    try {
      const { assigned } = await api.post("/library/reimport/assign", {
        contentHashes,
        inatTaxonId: suggestion.inatTaxonId,
        scientificName: suggestion.scientificName,
      });
      toast.success(t("settings.reimport.review.imported", { count: assigned, species: speciesName(suggestion) }));
      await onIgnored();
    } catch (err) {
      toast.error(errorMessage(err, t("settings.reimport.review.importFailed")));
    } finally {
      setAssigningTaxon(null);
    }
  }
  const sameSuggestion = (s: SpeciesSuggestion) =>
    files.filter((f) => f.suggestion?.inatTaxonId === s.inatTaxonId).length;

  async function ignore(contentHash: string) {
    setIgnoringHash(contentHash);
    try {
      await api.post("/library/ignore", { contentHash });
      await onIgnored();
    } catch (err) {
      toast.error(errorMessage(err, t("settings.reimport.review.ignoreFailed")));
    } finally {
      setIgnoringHash(null);
    }
  }

  return (
    <div className="max-h-96 space-y-1 overflow-y-auto">
      {files.map((f, i) => (
        <div key={f.contentHash ?? f.relativePath} className="flex items-center gap-3 py-1">
          {/* raw-control: a thumbnail that opens the file full size. */}
          <button
            type="button"
            onClick={() => viewer.open(slides, i)}
            aria-label={t("settings.reimport.review.openPreview", { file: f.relativePath })}
            className="shrink-0 rounded-badge"
          >
            <img
              src={previewUrl(f, i)}
              alt=""
              loading="lazy"
              className="h-12 w-12 rounded-badge object-cover"
              onError={(e) => {
                (e.target as HTMLImageElement).style.visibility = "hidden";
              }}
            />
          </button>
          <div className="min-w-0 flex-1">
            {/* The file name tells files apart: it comes first, the full path on hover. */}
            <FolderPath path={f.relativePath} className="text-footnote" />
            <p className="truncate text-caption text-muted">
              {f.scientificNames
                ? t("settings.reimport.review.matchedMany", { names: formatList(f.scientificNames, "unit") })
                : f.suggestion
                  ? t(f.suggestion.exact ? "settings.reimport.review.looksLike" : "settings.reimport.review.maybe", {
                      species: speciesLabel(f.suggestion),
                    })
                  : t("settings.reimport.review.noTag")}
            </p>
          </div>
          {f.contentHash && f.suggestion && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => assign(f.suggestion!)}
              disabled={assigningTaxon !== null || ignoringHash !== null}
              loading={assigningTaxon === f.suggestion.inatTaxonId}
              className="shrink-0"
            >
              {sameSuggestion(f.suggestion) > 1
                ? t("settings.reimport.review.importAll", { count: sameSuggestion(f.suggestion) })
                : t("settings.reimport.import.button")}
            </Button>
          )}
          {f.contentHash && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => ignore(f.contentHash!)}
              disabled={ignoringHash !== null || assigningTaxon !== null}
              loading={ignoringHash === f.contentHash}
              className="shrink-0"
            >
              {t("settings.reimport.review.ignore")}
            </Button>
          )}
        </div>
      ))}
      {viewer.node}
    </div>
  );
}

// Brings photos already on disk into Lifer: any folder (another app's layout, or another Lifer
// library with everything its record holds), or a rescan of this library to rebuild what's missing.
export default function LibraryReimportSection() {
  const { t } = useTranslation();
  const job = useJobPoll<ReimportStatus>("/library/reimport/status", { intervalMs: 1500 });
  const status = job.status;
  const confirm = useConfirm();
  const { volumes } = useStorageVolumes();
  const connectedVolumes = volumes.filter((v) => v.connected);
  const serverInfo = useServerInfo();
  const isServer = serverInfo?.deploymentMode === "server";
  const [volumeId, setVolumeId] = useState("");
  const [folder, setFolder] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [moveIn, setMoveIn] = useState(false);
  // Null until chosen. Rejects are skipped from a new folder, but a Lifer library (or a rescan of
  // this one) keeps them hidden: they were imported on purpose, and a recovery shouldn't drop them.
  const [chosenCullMarks, setCullMarks] = useState<CullMarksOption | null>(null);
  const [showUnmatched, setShowUnmatched] = useState(false);
  // The folder a Lifer library was found in, so a stale answer for an older path never shows.
  const [liferLibraryAt, setLiferLibraryAt] = useState<string | null>(null);

  useEffect(() => {
    if (!folder.startsWith("/") && !/^[A-Za-z]:\\/.test(folder)) return;
    let current = true;
    const timer = setTimeout(() => {
      api
        .get(apiPath("/library/inspect-folder", {}, { path: folder }))
        .then((r) => current && setLiferLibraryAt(r.liferLibrary ? folder : null))
        .catch(ignore("Couldn't inspect the folder"));
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [folder]);
  const liferLibrary = liferLibraryAt === folder && folder !== "";
  const cullMarks: CullMarksOption = chosenCullMarks ?? (folder === "" || liferLibrary ? "hide" : "skip");

  async function chooseFolder() {
    const native = await pickFolderNative();
    if (native === undefined) {
      setBrowsing(true);
      return;
    }
    if (native === null) return;
    setFolder(native);
  }

  async function importFolder() {
    const ok = await confirm({
      title: t("settings.reimport.importConfirm.title"),
      message: t("settings.reimport.importConfirm.message", {
        folder,
        files: moveIn ? "move" : "inPlace",
        library: liferLibrary ? "lifer" : "other",
      }),
      confirmLabel: t("settings.reimport.import.button"),
    });
    if (!ok) return;
    setShowUnmatched(false);
    await job.start("/library/reimport", { path: folder, organize: moveIn, cullMarks });
  }

  async function rescan() {
    const drive = volumeId ? connectedVolumes.find((v) => v.id === volumeId)?.label : null;
    const ok = await confirm({
      title: t("settings.reimport.rescanConfirm.title"),
      message: drive
        ? t("settings.reimport.rescanConfirm.messageDrive", { drive })
        : t("settings.reimport.rescanConfirm.message"),
      confirmLabel: t("settings.reimport.rescan.button"),
    });
    if (!ok) return;
    setShowUnmatched(false);
    await job.start("/library/reimport", volumeId ? { volumeId, cullMarks } : { cullMarks });
  }

  async function cancel() {
    const ok = await confirm({
      title: t("settings.reimport.cancelConfirm.title"),
      message: t("settings.reimport.cancelConfirm.message"),
      confirmLabel: t("settings.reimport.cancelConfirm.confirm"),
      cancelLabel: t("settings.reimport.cancelConfirm.keepGoing"),
      danger: true,
    });
    if (ok) await job.cancel("/library/reimport/cancel");
  }

  // Unreachable status endpoint: this section just doesn't render.
  if (status === null) return null;
  const busy = job.starting || status.running;
  const missingReferenceData = status.result?.missingReferenceData ?? [];
  const relinked = status.jpegsRelinked + status.rawsRelinked;
  const moved = status.jpegsMoved + status.rawsMoved;
  const finished = !status.running && status.finishedAt !== null;
  const suggested = status.unmatched.filter((f) => f.suggestion).length;

  return (
    <SettingsGroup title={t("settings.reimport.title")}>
      <SettingRow
        label={t("settings.reimport.folder.label")}
        description={t(liferLibrary ? "settings.reimport.folder.liferLibrary" : "settings.reimport.folder.anyLayout")}
      >
        {/* Picked, never typed: the folder browser reaches every folder this Lifer can. */}
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1" aria-label={t("settings.reimport.folder.ariaLabel")}>
            {folder && <FolderPath path={folder} className="text-callout" />}
          </div>
          <Button size="sm" variant="secondary" onClick={chooseFolder} disabled={busy} className="shrink-0">
            {t("settings.reimport.folder.choose")}
          </Button>
        </div>
        {isServer && serverInfo.libraryRoots.length === 0 && (
          <p className="text-footnote text-muted">{t("settings.reimport.folder.serverRootsHint")}</p>
        )}
        {browsing && (
          <FolderBrowser
            onChoose={(p) => {
              setFolder(p);
              setBrowsing(false);
            }}
            onCancel={() => setBrowsing(false)}
          />
        )}
      </SettingRow>
      <SettingRow
        label={t("settings.reimport.moveIn.label")}
        description={t("settings.reimport.moveIn.description")}
        control={
          <Switch label={t("settings.reimport.moveIn.label")} checked={moveIn} onChange={setMoveIn} disabled={busy} />
        }
      />
      <SettingRow
        label={t("settings.reimport.rejected.label")}
        description={t("settings.reimport.rejected.description")}
        control={
          <Select
            id="reimport-cull-marks"
            aria-label={t("settings.reimport.rejected.ariaLabel")}
            variant="form"
            value={cullMarks}
            onChange={(e) => setCullMarks(e.target.value as CullMarksOption)}
            disabled={busy}
          >
            <option value="skip">{t("settings.reimport.rejected.skip")}</option>
            <option value="hide">{t("settings.reimport.rejected.hide")}</option>
            <option value="ignore">{t("settings.reimport.rejected.ignore")}</option>
          </Select>
        }
      />
      <SettingRow
        label={t("settings.reimport.import.label")}
        description={t(
          finished && status.cancelled ? "settings.reimport.import.stopped" : "settings.reimport.import.description",
        )}
        control={
          <Button size="sm" onClick={importFolder} disabled={busy || !folder}>
            {status.running ? t("settings.reimport.import.importing") : t("settings.reimport.import.button")}
          </Button>
        }
      >
        {status.running && (
          <JobProgress
            status={status}
            phases={REIMPORT_PHASES}
            detail={t("settings.reimport.import.progress", {
              photos: status.processedJpegs,
              totalPhotos: status.totalJpegs,
              raws: status.processedRaws,
              totalRaws: status.totalRaws,
            })}
            onCancel={cancel}
            cancelling={job.cancelling}
          />
        )}
        {finished && (
          <div className="space-y-1 text-footnote text-muted">
            <p>
              {t("settings.reimport.summary.added", {
                count: status.jpegsRecovered,
                known: status.jpegsAlreadyKnown,
                raws: status.rawsRecovered,
              })}
            </p>
            {moved > 0 && <p>{t("settings.reimport.summary.moved", { count: moved })}</p>}
            {relinked > 0 && <p>{t("settings.reimport.summary.relinked", { count: relinked })}</p>}
            {status.jpegsIgnored > 0 && <p>{t("settings.reimport.summary.ignored", { count: status.jpegsIgnored })}</p>}
            {status.jpegsRejected > 0 && (
              <p>{t("settings.reimport.summary.rejected", { count: status.jpegsRejected })}</p>
            )}
            {status.jpegsHidden > 0 && <p>{t("settings.reimport.summary.hidden", { count: status.jpegsHidden })}</p>}
            {status.rawsUnmatched > 0 && (
              <p>{t("settings.reimport.summary.rawsUnmatched", { count: status.rawsUnmatched })}</p>
            )}
            {missingReferenceData.length > 0 && (
              <p>
                <Trans
                  i18nKey="settings.reimport.summary.missingReferenceData"
                  values={{ count: missingReferenceData.length }}
                  components={{
                    a: (
                      <Link
                        to={`${SPECIES_DOWNLOADS_PATH}?missing=${encodeURIComponent(missingReferenceData.join(","))}`}
                        className="underline hover:no-underline"
                      />
                    ),
                  }}
                />
              </p>
            )}
          </div>
        )}
        <FormMessage error={job.actionError ?? status.error} />
      </SettingRow>

      {finished && status.unmatched.length > 0 && (
        <SettingRow
          label={t("settings.reimport.unmatched.label")}
          description={t("settings.reimport.unmatched.description", {
            count: status.unmatched.length,
            suggested,
          })}
          control={
            <Button variant="secondary" size="sm" onClick={() => setShowUnmatched((v) => !v)}>
              {showUnmatched ? t("settings.reimport.unmatched.hide") : t("settings.reimport.unmatched.review")}
            </Button>
          }
        >
          {showUnmatched && <UnmatchedReviewPanel files={status.unmatched} onIgnored={job.refresh} />}
        </SettingRow>
      )}

      <SettingRow
        label={t("settings.reimport.rescan.label")}
        description={t("settings.reimport.rescan.description")}
        control={
          <div className="flex items-center gap-2">
            {connectedVolumes.length > 0 && (
              <Select
                variant="form"
                aria-label={t("settings.reimport.rescan.ariaLabel")}
                value={volumeId}
                onChange={(e) => setVolumeId(e.target.value)}
                disabled={busy}
              >
                <option value="">{t("settings.reimport.rescan.mainLibrary")}</option>
                {connectedVolumes.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </Select>
            )}
            <Button variant="secondary" size="sm" onClick={rescan} disabled={busy}>
              {t("settings.reimport.rescan.button")}
            </Button>
          </div>
        }
      />
    </SettingsGroup>
  );
}
