import UploadQueueBanner from "./UploadQueueBanner";

// Bottom-left stack for progress of work the user started. Toasts use the bottom-right; the
// persistent updates notice sits in flow under AppNav.
export default function StatusTray() {
  return (
    <div className="pointer-events-none fixed bottom-4 left-4 z-50 flex max-w-[calc(100%-2rem)] flex-col items-start gap-2 [&>*]:pointer-events-auto">
      <UploadQueueBanner />
    </div>
  );
}
