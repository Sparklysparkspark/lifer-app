import { onPackDownloadAbandoned, onPackDownloadFinish, type PackDownloadStatus } from "./packDownloadStore";

/** Waits for the shared pack-download job to finish downloading any of `packIds`. Call before
 *  starting the job, so a run that ends on the very first poll isn't missed, and `cancel` if the
 *  job never starts. Rejects when the store stops following the job (signed out, server gone). */
export function nextPackDownloadFinish(packIds: string[]): { finished: Promise<PackDownloadStatus>; cancel: () => void } {
  let cancel = () => {};
  const finished = new Promise<PackDownloadStatus>((resolve, reject) => {
    const stop = () => {
      offFinish();
      offAbandon();
    };
    // Another download (another tab, another pack) finishing isn't this one.
    const offFinish = onPackDownloadFinish((status) => {
      if (!packIds.some((id) => status.packIds.includes(id))) return;
      stop();
      resolve(status);
    });
    const offAbandon = onPackDownloadAbandoned((reason) => {
      stop();
      reject(new Error(reason));
    });
    cancel = stop;
  });
  return { finished, cancel };
}
