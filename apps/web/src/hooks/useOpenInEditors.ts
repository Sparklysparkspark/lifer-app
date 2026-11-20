import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { tauriInvoke } from "../lib/tauri";
import { useDeploymentMode } from "./useDeploymentMode";
import { useToast } from "./useToast";

export interface PhotoEditor {
  id: string;
  name: string;
}

const LAST_KEY = "lifer:lastEditor";
// Installed editors rarely change while the app runs: asked once.
let editorsAsked: Promise<PhotoEditor[]> | null = null;

function lastEditor(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

/** The last-used editor first, the rest as found. */
export function orderEditors(editors: PhotoEditor[], last: string | null): PhotoEditor[] {
  return [...editors].sort((a, b) => Number(b.id === last) - Number(a.id === last));
}

/** Editors installed on this computer and a way to open captures' files in one. Empty on a server
 *  or in a browser, where the files aren't on this computer; also empty when none is installed. */
export function useOpenInEditors(): {
  editors: PhotoEditor[];
  openIn: (editor: PhotoEditor, captureIds: string[]) => void;
} {
  const { t } = useTranslation();
  const toast = useToast();
  const local = useDeploymentMode() === "desktop";
  const [editors, setEditors] = useState<PhotoEditor[]>([]);

  useEffect(() => {
    const invoke = tauriInvoke();
    if (!local || !invoke) return;
    let live = true;
    editorsAsked ??= invoke("editors_list").then(
      (l) => (Array.isArray(l) ? (l as PhotoEditor[]) : []),
      () => [],
    );
    void editorsAsked.then((l) => live && setEditors(orderEditors(l, lastEditor())));
    return () => {
      live = false;
    };
  }, [local]);

  const openIn = useCallback(
    (editor: PhotoEditor, captureIds: string[]) => {
      const invoke = tauriInvoke();
      if (!invoke) return;
      try {
        localStorage.setItem(LAST_KEY, editor.id);
      } catch {
        // Remembering is a convenience only.
      }
      setEditors((prev) => orderEditors(prev, editor.id));
      void api
        .post("/originals/editor-paths", { captureIds })
        .then(({ paths }) => {
          if (paths.length === 0) throw new Error("none");
          return invoke("open_in", { editorId: editor.id, paths });
        })
        .catch(() => toast.error(t("openIn.failed", { name: editor.name })));
    },
    [t, toast],
  );

  return { editors, openIn };
}
