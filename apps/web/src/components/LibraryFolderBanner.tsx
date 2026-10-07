import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { api } from "../api/client";

interface LibraryFolderStatus {
  ok: boolean;
  problems: Array<{ folder: "library" | "appData"; path: string; problem: "missing" | "moved"; message: string }>;
}

const POLL_MS = 60_000;

// Warns on every page when the photo library folder has gone missing (moved, drive unplugged),
// since every upload fails until it's back. Silent when the check can't run (signed out, offline).
export default function LibraryFolderBanner() {
  const { t } = useTranslation();
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
      className="fixed left-1/2 top-4 z-50 w-[min(40rem,calc(100%-2rem))] -translate-x-1/2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 shadow-sm dark:border-rose-900/50 dark:bg-rose-950/80 dark:text-rose-300"
    >
      <p className="font-medium">{t("status.libraryFolder.cantSave")}</p>
      {status.problems.map((p) => (
        <p key={p.folder} className="mt-1 text-xs">
          {p.message}
        </p>
      ))}
    </div>
  );
}
