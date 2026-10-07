import { useCallback, useState, type ReactNode } from "react";
import { ConfirmContext, type ConfirmFn, type ConfirmOptions } from "../hooks/useConfirm";
import ConfirmDialog from "./ConfirmDialog";

interface Pending extends ConfirmOptions {
  id: number;
  resolve: (ok: boolean) => void;
}

let nextId = 0;

// Requests queue up and show one at a time, the way native confirm() calls would.
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Pending[]>([]);

  const confirm = useCallback<ConfirmFn>(
    (options) => new Promise<boolean>((resolve) => setQueue((q) => [...q, { ...options, id: ++nextId, resolve }])),
    [],
  );

  // Removes by id, so a double click can't also dismiss the next queued request. Resolving a
  // promise twice is a no-op, so the second click of a double click does nothing.
  const settle = (request: Pending, ok: boolean) => {
    request.resolve(ok);
    setQueue((q) => q.filter((p) => p.id !== request.id));
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
          onConfirm={() => settle(current, true)}
          onCancel={() => settle(current, false)}
        />
      )}
    </ConfirmContext.Provider>
  );
}
