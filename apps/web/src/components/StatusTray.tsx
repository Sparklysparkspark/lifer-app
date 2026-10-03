import UpdatesBanner from "./UpdatesBanner";
import UploadQueueBanner from "./UploadQueueBanner";

// One bottom-left stack for the background-status pills so they don't overlap. Toasts use the bottom-right.
export default function StatusTray() {
  return (
    <div className="pointer-events-none fixed bottom-4 left-4 z-50 flex max-w-[calc(100%-2rem)] flex-col items-start gap-2 [&>*]:pointer-events-auto">
      <UploadQueueBanner />
      <UpdatesBanner />
    </div>
  );
}
