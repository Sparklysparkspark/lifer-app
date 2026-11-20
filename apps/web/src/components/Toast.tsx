import { useTranslation } from "react-i18next";
import { IconButton } from "./Button";

export type ToastTone = "success" | "error" | "info";

/** A button on a toast, like View or Undo. Clicking it also dismisses the toast. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
  actions?: ToastAction[];
}

const TONE: Record<ToastTone, string> = {
  success: "border-line text-ink",
  info: "border-line text-ink",
  error: "border-rose-200 text-rose-700 dark:border-rose-900/50 dark:text-rose-400",
};

// Plain news has no mark: a lone "i" read as clutter. Success and errors keep theirs.
const GLYPH: Record<ToastTone, string | null> = { success: "✓", info: null, error: "!" };

const ICON: Record<ToastTone, string> = {
  success: "text-emerald-600 dark:text-emerald-400",
  info: "text-accent",
  error: "text-rose-600 dark:text-rose-400",
};

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  const { t } = useTranslation();
  return (
    <div
      // One centre line for the mark, the text (one line or several), the actions and the close X:
      // each sits in a box as tall as the X.
      className={`pointer-events-auto flex w-full items-center gap-2 rounded-panel border bg-surface px-3 py-2 text-callout shadow-sm ${TONE[toast.tone]}`}
    >
      {/* Errors interrupt (alert); the rest wait their turn (status). The role wraps only the
          message, so a screen reader doesn't read "Dismiss" as part of every toast. */}
      <div role={toast.tone === "error" ? "alert" : "status"} className="flex min-w-0 flex-1 items-center gap-2">
        {GLYPH[toast.tone] && (
          <span aria-hidden className={`flex h-6 w-4 shrink-0 items-center justify-center ${ICON[toast.tone]}`}>
            {GLYPH[toast.tone]}
          </span>
        )}
        {/* eslint-disable-next-line no-restricted-syntax -- not an error object: callers pass copy, they must use userMessage() for errors */}
        <p className="min-w-0 flex-1 break-words">{toast.message}</p>
      </div>
      {toast.actions?.map((a) => (
        // raw-control: a toast action, in the toast's link colour.
        <button
          key={a.label}
          type="button"
          onClick={() => {
            onDismiss(toast.id);
            a.onClick();
          }}
          className="inline-flex h-6 shrink-0 items-center font-medium text-link hover:underline"
        >
          {a.label}
        </button>
      ))}
      <IconButton
        tone="plain"
        onClick={() => onDismiss(toast.id)}
        aria-label={t("ui.toast.dismiss")}
        className="shrink-0"
      >
        ✕
      </IconButton>
    </div>
  );
}

// Bottom-right, opposite StatusTray. Each toast carries its own live-region role; the named
// region lets assistive tech (and the e2e checks) tell toasts apart from other alerts on the page.
export function ToastViewport({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t("ui.toast.region")}
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(22rem,calc(100%-2rem))] flex-col items-end gap-2"
    >
      {toasts.map((item) => (
        <ToastCard key={item.id} toast={item} onDismiss={onDismiss} />
      ))}
    </section>
  );
}
