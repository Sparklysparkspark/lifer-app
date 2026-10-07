export type ToastTone = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

const TONE: Record<ToastTone, string> = {
  success: "border-line text-ink",
  info: "border-line text-ink",
  error: "border-rose-200 text-rose-700 dark:border-rose-900/50 dark:text-rose-400",
};

const ICON: Record<ToastTone, string> = {
  success: "text-emerald-600 dark:text-emerald-400",
  info: "text-accent",
  error: "text-rose-600 dark:text-rose-400",
};

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  return (
    <div
      className={`pointer-events-auto flex w-full items-start gap-2 rounded-lg border bg-surface px-3 py-2 text-sm shadow-sm ${TONE[toast.tone]}`}
    >
      {/* Errors interrupt (alert); the rest wait their turn (status). The role wraps only the
          message, so a screen reader doesn't read "Dismiss" as part of every toast. */}
      <div role={toast.tone === "error" ? "alert" : "status"} className="flex min-w-0 flex-1 items-start gap-2">
        <span aria-hidden className={`mt-px shrink-0 ${ICON[toast.tone]}`}>
          {toast.tone === "error" ? "!" : toast.tone === "success" ? "✓" : "i"}
        </span>
        <p className="min-w-0 flex-1 break-words">{toast.message}</p>
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss"
        className="shrink-0 text-muted hover:text-ink"
      >
        ✕
      </button>
    </div>
  );
}

// Bottom-right, opposite StatusTray. Each toast carries its own live-region role; the named
// region lets assistive tech (and the e2e checks) tell toasts apart from other alerts on the page.
export function ToastViewport({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  return (
    <section
      aria-label="Notifications"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(22rem,calc(100%-2rem))] flex-col items-end gap-2"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </section>
  );
}
