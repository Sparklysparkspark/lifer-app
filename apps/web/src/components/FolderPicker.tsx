import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { api } from "../api/client";
import { errorMessage } from "../lib/errorMessage";
import { matches } from "../lib/keymap";
import Button from "./Button";
import FormMessage from "./FormMessage";
import TextField from "./TextField";

interface DirectoryListing {
  // null for a self-hosted server's top level, which lists the allowed roots rather than a folder.
  path: string | null;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
}

// Directory listing of the API's filesystem (GET /settings/browse-directory). A server starts at
// its allowed roots and refuses anything outside them, with the message shown here.
export function FolderBrowser({
  onChoose,
  onCancel,
  initialPath,
}: {
  onChoose: (path: string) => void;
  onCancel: () => void;
  /** Where to open; a folder that's gone falls back to the top level. */
  initialPath?: string;
}) {
  const { t } = useTranslation();
  const [browsing, setBrowsing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set once the server answered with a rooted top level, so an allowed root can step back to it.
  const [rooted, setRooted] = useState(false);
  // The name typed for "New folder", or null while not making one.
  const [newName, setNewName] = useState<string | null>(null);

  useEffect(() => {
    browse(initialPath, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opens once, where it was asked to
  }, []);

  function browse(dirPath?: string, fallBack = false) {
    setError(null);
    api
      .get<DirectoryListing>(`/settings/browse-directory${dirPath ? `?path=${encodeURIComponent(dirPath)}` : ""}`)
      .then((res) => {
        if (res.path === null) setRooted(true);
        setBrowsing(res);
      })
      .catch((err) => {
        if (fallBack && dirPath) browse();
        else setError(errorMessage(err, i18n.t("folderPicker.browseFailed")));
      });
  }

  // Made inside the folder shown, then opened, so "Use this folder" picks it.
  async function makeFolder(parent: string) {
    if (!newName?.trim()) return;
    try {
      const res = await api.post<{ path: string }>("/settings/browse-directory/new-folder", {
        parent,
        name: newName.trim(),
      });
      setNewName(null);
      browse(res.path);
    } catch (err) {
      setError(errorMessage(err, i18n.t("folderPicker.newFolderFailed")));
    }
  }

  if (!browsing)
    return error ? <FormMessage error={error} /> : <p className="text-callout text-muted">{t("common.loading")}</p>;
  const currentPath = browsing.path;

  return (
    <div className="space-y-2 rounded-panel border border-line p-3">
      <p className="truncate text-footnote text-muted">{currentPath ?? t("folderPicker.roots")}</p>
      <div className="max-h-48 space-y-0.5 overflow-y-auto">
        {rooted && currentPath !== null && !browsing.parent && (
          // raw-control: a row of the folder list.
          <button
            type="button"
            onClick={() => browse()}
            className="block w-full rounded-control px-2 py-1 text-left text-callout text-muted hover:bg-surface-muted"
          >
            {t("folderPicker.allFolders")}
          </button>
        )}
        {browsing.parent && (
          // raw-control: a row of the folder list.
          <button
            type="button"
            onClick={() => browse(browsing.parent!)}
            className="block w-full rounded-control px-2 py-1 text-left text-callout text-muted hover:bg-surface-muted"
          >
            {t("folderPicker.upOneLevel")}
          </button>
        )}
        {browsing.entries.map((entry) => (
          // raw-control: a row of the folder list.
          <button
            key={entry.path}
            type="button"
            onClick={() => browse(entry.path)}
            className="block w-full rounded-control px-2 py-1 text-left text-callout text-ink hover:bg-surface-muted"
          >
            {entry.name}
          </button>
        ))}
      </div>
      {newName !== null && currentPath !== null && (
        <div className="flex gap-2">
          <TextField
            size="sm"
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              // Inside a dialog's form, Enter would submit the dialog instead.
              if (matches(e, "confirm")) {
                e.preventDefault();
                void makeFolder(currentPath);
              } else if (matches(e, "close")) {
                e.stopPropagation();
                setNewName(null);
              }
            }}
            placeholder={t("folderPicker.newFolderName")}
            aria-label={t("folderPicker.newFolderName")}
            className="min-w-0 flex-1"
          />
          <Button size="sm" onClick={() => void makeFolder(currentPath)} disabled={!newName.trim()}>
            {t("folderPicker.create")}
          </Button>
        </div>
      )}
      <div className="flex gap-2 pt-1">
        <Button size="sm" onClick={() => currentPath && onChoose(currentPath)} disabled={currentPath === null}>
          {t("folderPicker.use")}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setNewName(newName === null ? "" : null)}
          disabled={currentPath === null}
        >
          {t("folderPicker.newFolder")}
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
      <FormMessage error={error} />
    </div>
  );
}
