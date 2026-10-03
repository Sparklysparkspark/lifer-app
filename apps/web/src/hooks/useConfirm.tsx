import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import ConfirmDialog from "../components/ConfirmDialog";

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

interface Pending extends ConfirmOptions {
  id: number;
  resolve: (ok: boolean) => void;
}

const ConfirmContext = createContext<ConfirmFn | null>(null);
let nextId = 0;

// Requests queue up and show one at a time, the way native confirm() calls would.
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Pending[]>([]);
  const queueRef = useRef(queue);
  queueRef.current = queue;

  const confirm = useCallback<ConfirmFn>(
    (options) => new Promise<boolean>((resolve) => setQueue((q) => [...q, { ...options, id: ++nextId, resolve }])),
    [],
  );

  // By id, so a double click can't also dismiss the next queued request.
  const settle = (id: number, ok: boolean) => {
    const target = queueRef.current.find((p) => p.id === id);
    target?.resolve(ok);
    setQueue((q) => q.filter((p) => p.id !== id));
  };

  const current = queue[0];
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {current && (
        <ConfirmDialog
          // Remount per request so focus and Escape registration start fresh.
          key={current.id}
          open
          title={current.title}
          message={current.message}
          confirmLabel={current.confirmLabel}
          cancelLabel={current.cancelLabel}
          danger={current.danger}
          onConfirm={() => settle(current.id, true)}
          onCancel={() => settle(current.id, false)}
        />
      )}
    </ConfirmContext.Provider>
  );
}

/** `if (await confirm({ title, message, confirmLabel, danger: true })) ...` */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within ConfirmProvider");
  return ctx;
}
