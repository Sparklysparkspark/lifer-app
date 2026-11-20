import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useState } from "react";
import { api, LIBRARY_FOLDER_UNAVAILABLE } from "../api/client";
import { ignore } from "../lib/ignore";
import { errorMessage } from "../lib/errorMessage";
import { pickFolderNative } from "../lib/pickFolderNative";
import { changeLibraryFolder, resumeDownloadsAfterRestart } from "../lib/libraryFolderChange";
import { useConfirm } from "../hooks/useConfirm";
import Button, { IconButton } from "./Button";
import FolderPath from "./FolderPath";
import Modal from "./Modal";
import { FolderBrowser } from "./FolderPicker";

interface LibraryFolderStatus {
  ok: boolean;
  problems: Array<{ folder: "library" | "appData"; path: string; problem: "missing" | "moved"; message: string }>;
}

const POLL_MS = 60_000;
// Per session: a relaunch, or the next save that fails, brings it back.
const DISMISSED_KEY = "lifer-library-folder-dismissed";

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(value: boolean) {
  try {
    if (value) sessionStorage.setItem(DISMISSED_KEY, "1");
    else sessionStorage.removeItem(DISMISSED_KEY);
  } catch {
    // Storage blocked: dismissed until this page reloads.
  }
}

// Docked under the toolbar on every app page when the library folder has gone missing (moved,
// drive unplugged), since every save fails until it's back. Silent when the check can't run.
export default function LibraryFolderBanner() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [status, setStatus] = useState<LibraryFolderStatus | null>(null);
  const [dismissed, setDismissed] = useState(readDismissed);
  const [changeable, setChangeable] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const check = useCallback(
    () =>
      api
        .get<LibraryFolderStatus>("/library/folder-status")
        .then((res) => {
          setStatus(res);
          return res;
        })
        .catch((err) => {
          ignore("Couldn't check the library folder")(err);
          return null;
        }),
    [],
  );

  useEffect(() => {
    void resumeDownloadsAfterRestart();
  }, []);

  useEffect(() => {
    void check();
    const timer = window.setInterval(check, POLL_MS);
    const onSaveFailed = () => {
      writeDismissed(false);
      setDismissed(false);
      void check();
    };
    window.addEventListener("focus", check);
    window.addEventListener(LIBRARY_FOLDER_UNAVAILABLE, onSaveFailed);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
      window.removeEventListener(LIBRARY_FOLDER_UNAVAILABLE, onSaveFailed);
    };
  }, [check]);

  const broken = status !== null && !status.ok;
  useEffect(() => {
    if (!broken) return;
    api
      .get("/settings/storage")
      .then((res) => setChangeable(res.changeable))
      .catch(ignore("Couldn't read the storage settings"));
  }, [broken]);

  if (!status || status.ok || dismissed) return null;
  const library = status.problems.find((p) => p.folder === "library");
  const first = library ?? status.problems[0];

  async function checkAgain() {
    setChecking(true);
    setNote(null);
    const res = await check();
    setChecking(false);
    if (res && !res.ok) setNote(t("status.libraryFolder.stillMissing"));
  }

  async function apply(dataDir: string) {
    setBrowsing(false);
    setApplying(true);
    setNote(null);
    try {
      const outcome = await changeLibraryFolder(dataDir);
      if (outcome.kind === "restarting") return;
      if (outcome.kind === "importsRunning") setNote(t("settings.storage.location.importsRunning"));
      else if (outcome.kind === "launchConfigFailed")
        setNote(t("settings.storage.location.saveForLaunchFailed", { error: outcome.error, folder: outcome.dataDir }));
      else setNote(t("settings.storage.location.saved"));
    } catch (err) {
      setNote(errorMessage(err, t("settings.storage.location.moveFailed")));
    }
    setApplying(false);
  }

  async function chooseLocation() {
    const ok = await confirm({
      title: t("settings.storage.location.chooseConfirm.title"),
      message: t("settings.storage.location.restartWarning"),
      confirmLabel: t("settings.storage.location.chooseConfirm.confirm"),
    });
    if (!ok) return;
    const native = await pickFolderNative(library?.path);
    if (native === undefined) setBrowsing(true);
    else if (native !== null) await apply(native);
  }

  return (
    <div
      role="alert"
      // design-token: the same rose error tones as FormMessage, which has no theme token yet.
      className="border-b border-rose-200 bg-rose-50 px-6 py-2 text-footnote text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/60 dark:text-rose-200"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1 basis-64">
          <p className="font-medium">{t("status.libraryFolder.cantSave")}</p>
          <p className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0">{t("status.libraryFolder.missing")}</span>
            <FolderPath path={first.path} />
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {changeable && library && (
            <Button variant="secondary" size="sm" onClick={chooseLocation} loading={applying}>
              {t("status.libraryFolder.chooseLocation")}
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={checkAgain} loading={checking}>
            {t("status.libraryFolder.checkAgain")}
          </Button>
          <Button variant="link" size="sm" onClick={() => setShowDetails((v) => !v)} aria-expanded={showDetails}>
            {t("status.libraryFolder.details")}
          </Button>
          <IconButton
            tone="plain"
            onClick={() => {
              writeDismissed(true);
              setDismissed(true);
            }}
            aria-label={t("status.libraryFolder.remindLater")}
          >
            ✕
          </IconButton>
        </div>
      </div>
      {note && <p className="mt-1">{note}</p>}
      {showDetails &&
        status.problems.map((p) => (
          <p key={p.folder} className="mt-1 break-words">
            {/* eslint-disable-next-line no-restricted-syntax -- authored server copy, not error text; translate from p.problem later */}
            {p.message}
          </p>
        ))}
      <Modal
        open={browsing}
        onClose={() => setBrowsing(false)}
        title={t("settings.storage.location.chooseConfirm.title")}
      >
        <FolderBrowser initialPath={library?.path} onChoose={apply} onCancel={() => setBrowsing(false)} />
      </Modal>
    </div>
  );
}
