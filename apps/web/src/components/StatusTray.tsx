import UploadQueueBanner from "./UploadQueueBanner";
import CrashReportSheet from "./CrashReportSheet";
import PackDownloadTray from "./PackDownloadTray";
import TripFileMoveTray from "./TripFileMoveTray";
import MovedPhotosTray from "./MovedPhotosTray";

// Bottom-left stack for progress of work the user started, and the crash report offer. Toasts use
// the bottom-right; the persistent updates notice sits in flow under AppNav.
export default function StatusTray() {
  return (
    <div className="pointer-events-none fixed bottom-4 left-4 z-50 flex max-w-[calc(100%-2rem)] flex-col items-start gap-2 [&>*]:pointer-events-auto">
      <CrashReportSheet />
      <PackDownloadTray />
      <TripFileMoveTray />
      <MovedPhotosTray />
      <UploadQueueBanner />
    </div>
  );
}
