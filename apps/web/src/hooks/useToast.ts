import { createContext, useContext } from "react";
import type { ToastTone } from "../components/Toast";

export interface ToastApi {
  success: (message: string) => number;
  error: (message: string) => number;
  info: (message: string) => number;
  // durationMs: null keeps it until dismissed.
  show: (message: string, options?: { tone?: ToastTone; durationMs?: number | null }) => number;
  dismiss: (id: number) => void;
}

// Provided by components/ToastProvider.tsx.
export const ToastContext = createContext<ToastApi | null>(null);

/** `const toast = useToast(); toast.success("Saved"); toast.error("Couldn't save")` */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
