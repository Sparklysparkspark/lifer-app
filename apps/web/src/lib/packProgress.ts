import type { TFunction } from "i18next";
import type { PackDownloadStatus, PackLane } from "@lifer/shared";
import { formatBytes } from "./format";

export interface PackProgressRow {
  /** "download" while anything uses the internet, "setup" while only this computer works. */
  key: "prepare" | "download" | "setup";
  title: string;
  /** The pack and its place in the queue. */
  detail: string | null;
  /** Bytes or packs, shown at the row's end. */
  amount: string | null;
  /** 0 to 1 (0 is an empty track), or null for an indeterminate bar: working, amount unknown. */
  fraction: number | null;
  /** "Doesn't use the internet", while the row is setting up. */
  note: string | null;
  /** A pack set up meanwhile, under a download: "Also setting up Belize birds on this computer". */
  also: string | null;
  /** Work done of the row's whole, for its time left; null when it can't be measured. */
  eta: { done: number; total: number } | null;
}

// The pack in progress counts as the share of its bytes fetched so far.
const lanePacks = (lane: PackLane) => ({
  done: lane.processed + (lane.downloadedBytes != null && lane.totalBytes ? lane.downloadedBytes / lane.totalBytes : 0),
  total: lane.total,
});

const bytes = (lane: PackLane, t: TFunction) =>
  lane.downloadedBytes != null && lane.totalBytes
    ? {
        amount: t("ui.job.ofTotal", { done: formatBytes(lane.downloadedBytes), total: formatBytes(lane.totalBytes) }),
        fraction: lane.downloadedBytes / lane.totalBytes,
      }
    : { amount: null, fraction: null };

const count = (done: number, total: number, t: TFunction) =>
  t("ui.job.ofTotal", { done: String(done), total: String(total) });

/** A running pack download as one row: what it downloads (pack files, then photos), with a pack
 *  set up meanwhile as a note; once nothing downloads, the set-up itself. Before any pack starts,
 *  what the job waits for. */
export function packProgressRow(status: PackDownloadStatus, t: TFunction): PackProgressRow {
  const { download, setup, photos } = status.lanes;
  const total = download.total;
  const base = { detail: null, amount: null, fraction: null, note: null, also: null, eta: null };
  if (total === 0) {
    return {
      ...base,
      key: "prepare",
      title:
        status.phase === "updating_catalog" ? t("offlinePacks.phases.updatingCatalog") : t("packProgress.preparing"),
      eta: status.catalogProgress
        ? { done: status.catalogProgress.processed, total: status.catalogProgress.total }
        : null,
    };
  }

  const setupName = setup.currentItem
    ? setup.step === "hotspots"
      ? t("packProgress.places", { name: setup.currentItem })
      : setup.currentItem
    : null;
  const also = setup.currentItem ? t("packProgress.alsoSettingUp", { name: setup.currentItem }) : null;
  if (download.currentItem) {
    return {
      ...base,
      key: "download",
      title: t("packProgress.downloading"),
      detail: t("packProgress.item", {
        name: download.currentItem,
        current: String(Math.min(download.processed + 1, total)),
        total: String(total),
      }),
      ...bytes(download, t),
      also,
      eta: lanePacks(download),
    };
  }
  if (photos.currentItem) {
    return {
      ...base,
      key: "download",
      title: t("packProgress.downloadingPhotos"),
      detail: photos.currentItem,
      ...bytes(photos, t),
      also,
      eta: lanePacks(photos),
    };
  }
  if (setupName) {
    return {
      ...base,
      key: "setup",
      title: t("packProgress.settingUp"),
      detail: setupName,
      amount: count(setup.processed, total, t),
      // The first pack has nothing done yet to measure, so it moves rather than sitting empty.
      fraction: setup.processed === 0 ? null : setup.processed / total,
      note: t("packProgress.offline"),
      eta: { done: setup.processed, total },
    };
  }
  // Between steps: the next pack is about to start, or the run is wrapping up.
  const filesDone = download.processed >= total;
  return {
    ...base,
    key: filesDone ? "setup" : "download",
    title: filesDone ? t("packProgress.settingUp") : t("packProgress.downloading"),
    amount: count(filesDone ? setup.processed : download.processed, total, t),
    fraction: (filesDone ? setup.processed : download.processed) / total,
    note: filesDone ? t("packProgress.offline") : null,
  };
}

/** Whether onboarding can let the user go in before the first pack is set up: once the catalog
 *  is loaded (its first load locks the species tables) and packs are on their way. */
export function canContinueInBackground(status: PackDownloadStatus | null): boolean {
  return !!status?.running && status.lanes.download.total > 0 && !status.catalogProgress && !status.cancelRequested;
}

export type PackSetupState = "idle" | "working" | "ready" | "failed" | "cancelled";

/** Where a download started from onboarding stands. "ready" once the first pack's checklist is
 *  in, so the user can go in while the rest carries on. */
export function packSetupState(status: PackDownloadStatus | null, startedHere: boolean): PackSetupState {
  if (!startedHere || !status) return "idle";
  const firstIn = (status.lanes?.setup.processed ?? 0) >= 1 || (status.result?.packsApplied ?? 0) > 0;
  if (status.running) return firstIn ? "ready" : "working";
  if (status.finishedAt == null) return "idle";
  if (status.error) return firstIn ? "ready" : "failed";
  if (firstIn) return "ready";
  return status.cancelled ? "cancelled" : "idle";
}
