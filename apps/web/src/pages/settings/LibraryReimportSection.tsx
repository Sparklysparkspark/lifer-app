import { useState } from "react";
import { Link } from "react-router-dom";
import type { CullMarksOption, JobStatus } from "@lifer/shared";
import { api } from "../../api/client";
import Button from "../../components/Button";
import { FolderBrowser } from "../../components/FolderPicker";
import { pickFolderNative } from "../../lib/pickFolderNative";
import FormMessage from "../../components/FormMessage";
import JobProgress from "../../components/JobProgress";
import Select from "../../components/Select";
import { useConfirm } from "../../hooks/useConfirm";
import { useServerInfo } from "../../hooks/useDeploymentMode";
import { useJobPoll } from "../../hooks/useJobPoll";
import { useStorageVolumes } from "../../hooks/useStorageVolumes";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { pluralize, pluralWord } from "../../lib/pluralize";
import { REIMPORT_PHASES } from "./phases";
import { Card } from "./shared";

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
    <div className="max-h-96 space-y-1 overflow-y-auto rounded-md border border-line bg-canvas p-2">
      {files.map((f, i) => (
        <div
          key={f.contentHash ?? f.relativePath}
          className="flex items-center gap-3 rounded-md p-1.5 hover:bg-surface-muted"
        >
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
                ? `Matched more than one species: ${f.scientificNames.join(", ")}`
                : "No species tag found"}
            </p>
          </div>
          {f.contentHash && (
            <button
              type="button"
              onClick={() => ignore(f.contentHash!)}
              disabled={ignoringHash !== null}
              className="shrink-0 rounded-md border border-line px-2 py-1 text-[11px] text-ink hover:bg-surface-muted disabled:opacity-50"
            >
              {ignoringHash === f.contentHash ? "Ignoring…" : "Ignore"}
            </button>
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
    const body = mode === "foreign" ? { path: foreignPath, organize, cullMarks } : volumeId ? { volumeId, cullMarks } : { cullMarks };
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

  return (
    <Card
      title="Reimport library"
      learnMore="reimport"
      description="Rebuild your species records straight from photos already on disk, for after a fresh install or server migration, to repair links after a drive got reconnected under a different name, or to bring in a library you've been keeping in a different app or folder layout."
    >
      <div className="flex rounded-md border border-line text-xs">
        <button
          type="button"
          onClick={() => setMode("existing")}
          disabled={busy}
          aria-pressed={mode === "existing"}
          className={`flex-1 rounded-l-md px-2.5 py-1.5 ${mode === "existing" ? "bg-accent text-accent-fg" : "text-muted hover:bg-surface-muted"}`}
        >
          Reimport my existing library
        </button>
        <button
          type="button"
          onClick={() => setMode("foreign")}
          disabled={busy}
          aria-pressed={mode === "foreign"}
          className={`flex-1 rounded-r-md px-2.5 py-1.5 ${mode === "foreign" ? "bg-accent text-accent-fg" : "text-muted hover:bg-surface-muted"}`}
        >
          Import a library organized differently
        </button>
      </div>

      {mode === "existing" ? (
        <>
          <p className="text-xs text-muted">
            This only scans the one location you pick below, either your main library folder, or a single connected
            drive or library folder, never everything at once. Pick "Main library" for a fresh install or server
            migration; pick a specific drive if that drive's own photos have gone stale (path drifted after reconnecting
            under a different name, for example).
          </p>
          {connectedVolumes.length > 0 && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted">Reimport from</label>
              <Select variant="form" value={volumeId} onChange={(e) => setVolumeId(e.target.value)} disabled={busy}>
                <option value="">Main library</option>
                {connectedVolumes.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="text-xs text-muted">
            Point this at any folder of photos, however it's organized: Lightroom exports, a flat dump by date,
            whatever. We'll match each photo to a species using tags already embedded in the file: its species name,
            common name, or an older name it may have been tagged with before a taxonomic rename. Anything we can't
            confidently match won't be touched. It's left in place and listed below, where you can review it or mark it
            "Ignore" so it stops showing up on future scans (handy for e.g. a folder of insect photos this app doesn't
            track).
          </p>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted">Folder to import</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={foreignPath}
                onChange={(e) => setForeignPath(e.target.value)}
                placeholder="/path/to/your/photos"
                disabled={busy}
                className="w-full min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink"
              />
              <Button variant="secondary" size="sm" onClick={chooseForeignPath} disabled={busy} className="shrink-0">
                Browse…
              </Button>
            </div>
            {isServer && serverInfo.libraryRoots.length === 0 && (
              <p className="text-xs text-muted">
                On this server you can pick folders inside the library folder. To import from somewhere else, mount it
                and declare it with LIFER_LIBRARY_ROOTS (see Settings &gt; Storage).
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
          </div>
          <label className="flex items-center gap-2 text-xs text-ink">
            <input
              type="checkbox"
              checked={organize}
              onChange={(e) => setOrganize(e.target.checked)}
              disabled={busy}
              className="h-3.5 w-3.5"
            />
            Organize matched photos into species folders in my library (leave off to add them to Lifer without moving
            the files from where they are now: you can migrate them into the folder scheme later from Settings &gt;
            Library &gt; Photo library organization)
          </label>
        </>
      )}

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted" htmlFor="reimport-cull-marks">
          Photos a culling app marked rejected
        </label>
        <Select
          id="reimport-cull-marks"
          variant="form"
          value={cullMarks}
          onChange={(e) => setCullMarks(e.target.value as CullMarksOption)}
          disabled={busy}
        >
          <option value="skip">Skip them</option>
          <option value="hide">Import them hidden</option>
          <option value="ignore">Import them anyway</option>
        </Select>
        <p className="text-xs text-muted">
          Read from Lightroom, Photo Mechanic, digiKam and similar apps. Skipped photos stay on disk untouched; hidden
          ones are found with the Gallery's Hidden filter.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={start} disabled={busy || (mode === "foreign" && !foreignPath)}>
          {status.running ? "Importing…" : mode === "foreign" ? "Import library now" : "Reimport library now"}
        </Button>
      </div>
      {status.running && (
        <JobProgress
          status={status}
          phases={REIMPORT_PHASES}
          detail={`Photos: ${status.processedJpegs} of ${status.totalJpegs} · RAW files: ${status.processedRaws} of ${status.totalRaws}`}
          onCancel={cancel}
          cancelling={job.cancelling}
        />
      )}
      {!status.running && status.finishedAt !== null && status.cancelled && (
        <p className="text-xs text-muted">
          Cancelled. Files already in progress when you cancelled were still recorded below.
        </p>
      )}
      {!status.running && status.finishedAt !== null && (
        <div className="space-y-2 text-xs text-muted">
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
          {status.jpegsHidden > 0 && (
            <p>Imported {pluralize(status.jpegsHidden, "rejected photo")} hidden.</p>
          )}
          {status.unmatched.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setShowUnmatched((v) => !v)}
                className="text-ink underline hover:no-underline"
              >
                {showUnmatched ? "Hide" : "Review"} unmatched ({status.unmatched.length})
              </button>
              {showUnmatched && (
                <div className="mt-2">
                  <UnmatchedReviewPanel files={status.unmatched} onIgnored={job.refresh} />
                </div>
              )}
            </div>
          )}
          {status.rawsUnmatched > 0 && (
            <p>{pluralize(status.rawsUnmatched, "RAW file")} couldn't be matched to a recovered photo.</p>
          )}
          {missingReferenceData.length > 0 && (
            <p>
              {missingReferenceData.length} recovered species {pluralWord(missingReferenceData.length, "is", "are")}{" "}
              missing reference photos/descriptions,{" "}
              <Link
                to={`/offline-packs?missing=${encodeURIComponent(missingReferenceData.join(","))}`}
                className="underline hover:no-underline"
              >
                see which packs would restore them
              </Link>
              .
            </p>
          )}
        </div>
      )}
      <FormMessage error={job.actionError ?? status.error} />
    </Card>
  );
}
