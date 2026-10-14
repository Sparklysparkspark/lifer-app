import { useState } from "react";
import { Link } from "react-router-dom";
import type { CullMarksOption, JobStatus } from "@lifer/shared";
import { api } from "../../api/client";
import Button from "../../components/Button";
import { FolderBrowser } from "../../components/FolderPicker";
import { pickFolderNative } from "../../lib/pickFolderNative";
import FormMessage from "../../components/FormMessage";
import JobProgress from "../../components/JobProgress";
import SegmentedControl from "../../components/SegmentedControl";
import Select from "../../components/Select";
import Switch from "../../components/Switch";
import { useConfirm } from "../../hooks/useConfirm";
import { useServerInfo } from "../../hooks/useDeploymentMode";
import { useJobPoll } from "../../hooks/useJobPoll";
import { useStorageVolumes } from "../../hooks/useStorageVolumes";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { pluralize, pluralWord } from "../../lib/pluralize";
import { REIMPORT_PHASES } from "./phases";
import { SettingRow, SettingsGroup } from "./shared";
import { formatList } from "../../lib/format";

interface UnmatchedFile {
  relativePath: string;
  contentHash: string | null;
  scientificNames: string[] | null;
}

type ReimportStatus = JobStatus<{ missingReferenceData: string[] }> & {
  processedJpegs: number;
  totalJpegs: number;
  processedRaws: number;
  totalRaws: number;
  jpegsRecovered: number;
  jpegsAlreadyKnown: number;
  jpegsRelinked: number;
  jpegsIgnored: number;
  jpegsRejected: number;
  jpegsHidden: number;
  unmatched: UnmatchedFile[];
  rawsRecovered: number;
  rawsAlreadyKnown: number;
  rawsRelinked: number;
  rawsUnmatched: number;
};

// The API runs one reimport job at a time, so one form with two modes rather than two forms.
type ReimportMode = "existing" | "foreign";

// Previews are keyed by content hash, so they stay right when an Ignore shifts the list. A row
// without a hash falls back to its position; the list is refetched after an Ignore for that reason.
function UnmatchedReviewPanel({ files, onIgnored }: { files: UnmatchedFile[]; onIgnored: () => Promise<unknown> }) {
  const toast = useToast();
  const [ignoringHash, setIgnoringHash] = useState<string | null>(null);

  async function ignore(contentHash: string) {
    setIgnoringHash(contentHash);
    try {
      await api.post("/library/ignore", { contentHash });
      await onIgnored();
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't ignore that file"));
    } finally {
      setIgnoringHash(null);
    }
  }

  return (
    <div className="max-h-96 space-y-1 overflow-y-auto">
      {files.map((f, i) => (
        <div key={f.contentHash ?? f.relativePath} className="flex items-center gap-3 py-1">
          {/* The index route can't bust the browser cache per file, so it gets the path as a key. */}
          <img
            src={
              f.contentHash
                ? `/api/library/reimport/unmatched-preview-by-hash/${encodeURIComponent(f.contentHash)}`
                : `/api/library/reimport/unmatched-preview/${i}?p=${encodeURIComponent(f.relativePath)}`
            }
            alt=""
            loading="lazy"
            className="h-12 w-12 shrink-0 rounded object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).style.visibility = "hidden";
            }}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-ink">{f.relativePath}</p>
            <p className="truncate text-[11px] text-muted">
              {f.scientificNames
                ? `Matched more than one species: ${formatList(f.scientificNames, "unit")}`
                : "No species tag found"}
            </p>
          </div>
          {f.contentHash && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => ignore(f.contentHash!)}
              disabled={ignoringHash !== null}
              loading={ignoringHash === f.contentHash}
              className="shrink-0"
            >
              Ignore
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

// Rebuilds records from photos already on disk (Lifer's own library or another app's), matching on
// embedded metadata, not folder names.
export default function LibraryReimportSection() {
  const job = useJobPoll<ReimportStatus>("/library/reimport/status", { intervalMs: 1500 });
  const status = job.status;
  const confirm = useConfirm();
  const { volumes } = useStorageVolumes();
  const connectedVolumes = volumes.filter((v) => v.connected);
  const serverInfo = useServerInfo();
  const isServer = serverInfo?.deploymentMode === "server";
  const [volumeId, setVolumeId] = useState("");
  const [mode, setMode] = useState<ReimportMode>("existing");
  const [foreignPath, setForeignPath] = useState("");
  const [browsingForeignPath, setBrowsingForeignPath] = useState(false);
  const [organize, setOrganize] = useState(false);
  const [cullMarks, setCullMarks] = useState<CullMarksOption>("hide");
  const [showUnmatched, setShowUnmatched] = useState(false);

  async function chooseForeignPath() {
    const native = await pickFolderNative();
    if (native === undefined) {
      setBrowsingForeignPath(true);
      return;
    }
    if (native === null) return;
    setForeignPath(native);
  }

  async function start() {
    const targetLabel = volumeId ? connectedVolumes.find((v) => v.id === volumeId)?.label : null;
    const message =
      mode === "foreign"
        ? `This walks "${foreignPath}", matches each photo to a species using tags already embedded in the file (species name, common name, or a past alias), and ${
            organize
              ? "moves matched photos into your library's own species folders"
              : "adds matched photos to your library without moving them"
          }. Anything it can't confidently match is left untouched on disk and listed for you to review.`
        : targetLabel
          ? `This walks "${targetLabel}"'s own photo folder and rebuilds any missing records, and repairs any already-known photo whose saved location has drifted (e.g. this drive remounting under a different name). It never modifies or moves your files.`
          : "This walks your whole photo library on disk and rebuilds any captures/species records missing from the database. It never modifies or moves your files.";
    const ok = await confirm({
      title: mode === "foreign" ? "Import this library?" : "Reimport your library?",
      message,
      confirmLabel: mode === "foreign" ? "Import" : "Reimport",
    });
    if (!ok) return;
    setShowUnmatched(false);
    const body =
      mode === "foreign"
        ? { path: foreignPath, organize, cullMarks }
        : volumeId
          ? { volumeId, cullMarks }
          : { cullMarks };
    await job.start("/library/reimport", body);
  }

  async function cancel() {
    const ok = await confirm({
      title: "Stop this reimport?",
      message: "Files already in progress will finish, but nothing queued behind them will be touched.",
      confirmLabel: "Stop reimport",
      cancelLabel: "Keep going",
      danger: true,
    });
    if (ok) await job.cancel("/library/reimport/cancel");
  }

  // Unreachable status endpoint: this section just doesn't render.
  if (status === null) return null;
  const busy = job.starting || status.running;
  const missingReferenceData = status.result?.missingReferenceData ?? [];
  const relinked = status.jpegsRelinked + status.rawsRelinked;

  const modes = [
    { value: "existing", label: "Lifer library" },
    { value: "foreign", label: "Another folder" },
  ] as const;
  const finished = !status.running && status.finishedAt !== null;

  return (
    <SettingsGroup title="Reimport">
      <SettingRow
        label="Source"
        description={
          mode === "existing"
            ? "Rebuilds missing records after a fresh install or migration, and repairs links to a renamed drive."
            : "Brings in photos from any folder layout, matched by the species tags in each file."
        }
        control={<SegmentedControl value={mode} onChange={(m) => !busy && setMode(m)} options={modes} />}
      />

      {mode === "existing" ? (
        connectedVolumes.length > 0 && (
          <SettingRow
            label="Scan"
            description="Only this one location is scanned. Pick a drive if its photos went stale."
            control={
              <Select
                variant="form"
                aria-label="Reimport from"
                value={volumeId}
                onChange={(e) => setVolumeId(e.target.value)}
                disabled={busy}
              >
                <option value="">Main library</option>
                {connectedVolumes.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </Select>
            }
          />
        )
      ) : (
        <>
          <SettingRow
            label="Folder to import"
            description="Photos it can't match are left in place and listed for review."
          >
            <div className="flex gap-2">
              <input
                type="text"
                aria-label="Folder to import"
                value={foreignPath}
                onChange={(e) => setForeignPath(e.target.value)}
                placeholder="/path/to/your/photos"
                disabled={busy}
                className="w-full min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink"
              />
              <Button variant="secondary" size="sm" onClick={chooseForeignPath} disabled={busy} className="shrink-0">
                Browse
              </Button>
            </div>
            {isServer && serverInfo.libraryRoots.length === 0 && (
              <p className="text-xs text-muted">
                This server can only reach folders inside the library folder. Mount others and list them in
                LIFER_LIBRARY_ROOTS (see Storage).
              </p>
            )}
            {browsingForeignPath && (
              <FolderBrowser
                onChoose={(p) => {
                  setForeignPath(p);
                  setBrowsingForeignPath(false);
                }}
                onCancel={() => setBrowsingForeignPath(false)}
              />
            )}
          </SettingRow>
          <SettingRow
            label="Move into species folders"
            description="Off adds photos to Lifer where they are. You can reorganize them later."
            control={
              <Switch label="Move into species folders" checked={organize} onChange={setOrganize} disabled={busy} />
            }
          />
        </>
      )}

      <SettingRow
        label="Rejected photos"
        description="Rejects marked in Lightroom, Photo Mechanic, digiKam and similar. Hidden ones show under the Gallery's Hidden filter."
        control={
          <Select
            id="reimport-cull-marks"
            aria-label="Photos a culling app marked rejected"
            variant="form"
            value={cullMarks}
            onChange={(e) => setCullMarks(e.target.value as CullMarksOption)}
            disabled={busy}
          >
            <option value="skip">Skip them</option>
            <option value="hide">Import them hidden</option>
            <option value="ignore">Import them anyway</option>
          </Select>
        }
      />

      <SettingRow
        label={mode === "foreign" ? "Import library" : "Reimport library"}
        description={
          finished && status.cancelled
            ? "Cancelled. Files already in progress were still recorded."
            : "Never changes your files unless you choose to move them."
        }
        control={
          <Button variant="secondary" size="sm" onClick={start} disabled={busy || (mode === "foreign" && !foreignPath)}>
            {status.running ? "Importing…" : mode === "foreign" ? "Import" : "Reimport"}
          </Button>
        }
      >
        {status.running && (
          <JobProgress
            status={status}
            phases={REIMPORT_PHASES}
            detail={`Photos: ${status.processedJpegs} of ${status.totalJpegs} · RAW files: ${status.processedRaws} of ${status.totalRaws}`}
            onCancel={cancel}
            cancelling={job.cancelling}
          />
        )}
        {finished && (
          <div className="space-y-1 text-xs text-muted">
            <p>
              Recovered {pluralize(status.jpegsRecovered, "photo")}
              {status.jpegsAlreadyKnown > 0 && ` (${status.jpegsAlreadyKnown} already known)`}
              {status.rawsRecovered > 0 && ` and matched ${pluralize(status.rawsRecovered, "RAW file")}`}.
            </p>
            {relinked > 0 && <p>Repaired {pluralize(relinked, "file")} whose saved location had drifted.</p>}
            {status.jpegsIgnored > 0 && <p>Skipped {pluralize(status.jpegsIgnored, "previously-ignored file")}.</p>}
            {status.jpegsRejected > 0 && (
              <p>Skipped {pluralize(status.jpegsRejected, "photo")} a culling app marked rejected.</p>
            )}
            {status.jpegsHidden > 0 && <p>Imported {pluralize(status.jpegsHidden, "rejected photo")} hidden.</p>}
            {status.rawsUnmatched > 0 && (
              <p>{pluralize(status.rawsUnmatched, "RAW file")} couldn't be matched to a recovered photo.</p>
            )}
            {missingReferenceData.length > 0 && (
              <p>
                {missingReferenceData.length} recovered species {pluralWord(missingReferenceData.length, "is", "are")}{" "}
                missing reference photos and descriptions.{" "}
                <Link
                  to={`/offline-packs?missing=${encodeURIComponent(missingReferenceData.join(","))}`}
                  className="underline hover:no-underline"
                >
                  See which packs restore them
                </Link>
                .
              </p>
            )}
          </div>
        )}
        <FormMessage error={job.actionError ?? status.error} />
      </SettingRow>

      {finished && status.unmatched.length > 0 && (
        <SettingRow
          label="Unmatched photos"
          description={`${pluralize(status.unmatched.length, "photo")} couldn't be matched to one species. Ignore one to skip it on future scans.`}
          control={
            <Button variant="secondary" size="sm" onClick={() => setShowUnmatched((v) => !v)}>
              {showUnmatched ? "Hide" : "Review"}
            </Button>
          }
        >
          {showUnmatched && <UnmatchedReviewPanel files={status.unmatched} onIgnored={job.refresh} />}
        </SettingRow>
      )}
    </SettingsGroup>
  );
}
