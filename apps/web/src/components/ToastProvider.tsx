import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ToastContext, type ToastApi } from "../hooks/useToast";
import { ToastViewport, type ToastItem, type ToastTone } from "./Toast";

const TOAST_DURATION_MS: Record<ToastTone, number> = { success: 4000, info: 4000, error: 6000 };
const MAX_VISIBLE = 5;
// Long enough to read the message and reach for Undo.
const ACTION_DURATION_MS = 8000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const show = useCallback<ToastApi["show"]>(
    (message, options = {}) => {
      const tone = options.tone ?? "info";
      const id = ++nextId.current;
      // Oldest drop off first once the stack is full.
      setToasts((list) => [...list, { id, tone, message, actions: options.actions }].slice(-MAX_VISIBLE));
      const fallback = options.actions?.length ? ACTION_DURATION_MS : TOAST_DURATION_MS[tone];
      const duration = options.durationMs === undefined ? fallback : options.durationMs;
      if (duration != null)
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => map.forEach(clearTimeout);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show,
      dismiss,
      success: (m) => show(m, { tone: "success" }),
      error: (m) => show(m, { tone: "error" }),
      info: (m) => show(m, { tone: "info" }),
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}
