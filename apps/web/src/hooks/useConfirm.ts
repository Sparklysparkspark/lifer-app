import { createContext, useContext, type ReactNode } from "react";

export interface ConfirmOptions {
  title: ReactNode;
  message?: ReactNode;
  // Defaults to "OK".
  confirmLabel?: string;
  // Defaults to "Cancel"; null makes it an OK-only notice (a window.alert replacement).
  cancelLabel?: string | null;
  danger?: boolean;
}

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

// Provided by components/ConfirmProvider.tsx.
export const ConfirmContext = createContext<ConfirmFn | null>(null);

/** `if (await confirm({ title, message, confirmLabel, danger: true })) ...` */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within ConfirmProvider");
  return ctx;
}
