import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { JobStatus } from "@lifer/shared";
import { apiPath } from "../../api/client";
import Button from "../../components/Button";
import { FolderBrowser } from "../../components/FolderPicker";
import FormMessage from "../../components/FormMessage";
import JobProgress from "../../components/JobProgress";
import Modal from "../../components/Modal";
import Select from "../../components/Select";
import Switch from "../../components/Switch";
import { useDeploymentMode, useIsTauri } from "../../hooks/useDeploymentMode";
import { useJobPoll } from "../../hooks/useJobPoll";
import { useToast } from "../../hooks/useToast";
import { pickFolderNative } from "../../lib/pickFolderNative";
import { revealPlace } from "../../lib/platform";

type ExportStatus = JobStatus<null> & {
  albumId: string | null;
  destination: string | null;
  copied: number;
  skipped: number;
  missing: number;
  withheld: number;
};

const LAST_FOLDER_KEY = "lifer:albumExportFolder";
const HIDE_SENSITIVE_KEY = "lifer:albumExportHideSensitive";

// Off unless the user chose it last time: an export is often for their own use.
function lastHideSensitive(): boolean {
  try {
    return localStorage.getItem(HIDE_SENSITIVE_KEY) === "1";
  } catch {
    return false;
  }
}

function lastExportFolder(): string | undefined {
  try {
    return localStorage.getItem(LAST_FOLDER_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

// Copies an album's photos into a folder of the user's choice. The library's files stay as they are.
export default function ExportAlbumModal({
  albumId,
  albumName,
  onClose,
}: {
  albumId: string;
  albumName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  // Only a run of this album that finished while the dialog was open is reported, not an older one.
  const [finishedHere, setFinishedHere] = useState(false);
  const job = useJobPoll<ExportStatus>("/albums/export/status", {
    onFinish: (s) => setFinishedHere(s.albumId === albumId),
  });
  const status = job.status;
  const [browsing, setBrowsing] = useState(false);
  // Picking: the native dialog is open, so the button can't open a second one.
  const [picking, setPicking] = useState(false);
  const [raw, setRaw] = useState(false);
  const [sidecars, setSidecars] = useState(false);
  const [structure, setStructure] = useState<"flat" | "bySpecies">("flat");
  const [hideSensitive, setHideSensitive] = useState(lastHideSensitive);
  // The Finder reveal runs on this machine, so only for the desktop app's own local API.
  const isTauri = useIsTauri();
  const deploymentMode = useDeploymentMode();
  const canReveal = isTauri && deploymentMode === "desktop";

  const running = !!status?.running;
  const busy = job.starting || running || picking;
  const finished = finishedHere && !running && status != null;

  // Export opens the folder picker; picking a folder starts the copy, cancelling returns here.
  async function chooseAndExport() {
    setPicking(true);
    const native = await pickFolderNative(lastExportFolder());
    setPicking(false);
    if (native === undefined) setBrowsing(true);
    else if (native !== null) await start(native);
  }

  async function start(destination: string) {
    try {
      localStorage.setItem(LAST_FOLDER_KEY, destination);
      localStorage.setItem(HIDE_SENSITIVE_KEY, hideSensitive ? "1" : "0");
    } catch {
      // Storage blocked: the picker just opens at its default next time.
    }
    setBrowsing(false);
    setFinishedHere(false);
    await job.start(apiPath("/albums/{id}/export", { id: albumId }), {
      destination,
      include: { raw, sidecars },
      structure,
      hideSensitiveLocations: hideSensitive,
    });
  }

  async function reveal(folder: string) {
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(folder);
    } catch {
      toast.error(t("albums.export.revealFailed"));
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t("albums.export.title", { name: albumName })}
      footer={
        browsing ? undefined : finished ? (
          <>
            {canReveal && status.destination && !status.error && (
              <Button variant="secondary" onClick={() => reveal(status.destination!)}>
                {t("albums.export.reveal", { place: revealPlace() })}
              </Button>
            )}
            <Button onClick={onClose}>{t("common.done")}</Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              {running ? t("albums.export.hide") : t("common.cancel")}
            </Button>
            {!running && (
              <Button onClick={chooseAndExport} disabled={picking} loading={job.starting}>
                {t("albums.export.action")}
              </Button>
            )}
          </>
        )
      }
    >
      <div className="space-y-4 text-callout">
        {running ? (
          <JobProgress
            status={status}
            phases={{ copying: { label: t("albums.export.copying"), progress: "bytes" } }}
            detail={t("albums.export.progress", { done: status.processed ?? 0, total: status.total ?? 0 })}
            onCancel={() => job.cancel("/albums/export/cancel")}
            cancelling={job.cancelling}
          />
        ) : finished ? (
          <div className="space-y-1">
            {status.error ? (
              <FormMessage error={status.error} />
            ) : (
              <p className="text-ink">
                {t(status.cancelled ? "albums.export.done.stopped" : "albums.export.done.copied", {
                  count: status.copied,
                  folder: status.destination ?? "",
                })}
              </p>
            )}
            {status.skipped > 0 && (
              <p className="text-footnote text-muted">{t("albums.export.done.skipped", { count: status.skipped })}</p>
            )}
            {status.missing > 0 && (
              <p className="text-footnote text-muted">{t("albums.export.done.missing", { count: status.missing })}</p>
            )}
            {status.withheld > 0 && (
              <p className="text-footnote text-muted">{t("albums.export.done.withheld", { count: status.withheld })}</p>
            )}
          </div>
        ) : browsing ? (
          <FolderBrowser initialPath={lastExportFolder()} onChoose={start} onCancel={() => setBrowsing(false)} />
        ) : (
          <>
            <p className="text-muted">{t("albums.export.intro")}</p>
            <div className="flex items-center justify-between gap-3">
              <span className="text-ink">{t("albums.export.includeRaw")}</span>
              <Switch label={t("albums.export.includeRaw")} checked={raw} onChange={setRaw} disabled={busy} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-ink">{t("albums.export.includeSidecars")}</span>
              <Switch
                label={t("albums.export.includeSidecars")}
                checked={sidecars}
                onChange={setSidecars}
                disabled={busy}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="album-export-structure" className="text-ink">
                {t("albums.export.folders")}
              </label>
              <Select
                id="album-export-structure"
                variant="form"
                value={structure}
                onChange={(e) => setStructure(e.target.value as "flat" | "bySpecies")}
                disabled={busy}
              >
                <option value="flat">{t("albums.export.flat")}</option>
                <option value="bySpecies">{t("albums.export.bySpecies")}</option>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-ink">{t("albums.export.hideSensitive")}</span>
              <Switch
                label={t("albums.export.hideSensitive")}
                checked={hideSensitive}
                onChange={setHideSensitive}
                disabled={busy}
              />
            </div>
          </>
        )}
        <FormMessage error={job.actionError} />
      </div>
    </Modal>
  );
}
