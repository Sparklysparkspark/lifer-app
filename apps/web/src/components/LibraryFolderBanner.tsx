import { useEffect, useState } from "react";
import { api } from "../api/client";

interface LibraryFolderStatus {
  ok: boolean;
  problems: Array<{ folder: "library" | "appData"; path: string; problem: "missing" | "moved"; message: string }>;
}

const POLL_MS = 60_000;

// Warns on every page when the photo library folder has gone missing under a running server
// (moved or renamed on the NAS, a drive unplugged). Until it's back, every upload fails, so this
// says so before anyone tries, with the fix spelled out. Silent when the check itself can't run
// (signed out, server unreachable): other parts of the app already cover those.
export default function LibraryFolderBanner() {
  const [status, setStatus] = useState<LibraryFolderStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      api
        .get<LibraryFolderStatus>("/library/folder-status")
        .then((res) => {
          if (!cancelled) setStatus(res);
        })
        .catch(() => {});
    };
    check();
    const timer = window.setInterval(check, POLL_MS);
    window.addEventListener("focus", check);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, []);

  if (!status || status.ok) return null;
  return (
    <div
      role="alert"
      className="fixed left-1/2 top-4 z-50 w-[min(40rem,calc(100%-2rem))] -translate-x-1/2 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 shadow-sm"
    >
      <p className="font-medium">Lifer can't save photos right now</p>
      {status.problems.map((p) => (
        <p key={p.folder} className="mt-1 text-xs">
          {p.message}
        </p>
      ))}
    </div>
  );
}
