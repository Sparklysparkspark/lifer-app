import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { tauriInvoke } from "../lib/tauri";
import { useDeploymentMode } from "./useDeploymentMode";
import { useToast } from "./useToast";

export interface PhotoEditor {
  id: string;
  name: string;
}

export const SYSTEM_EDITOR_ID = "system";
const CHOICE_KEY = "lifer:photoEditor";
// Installed editors rarely change while the app runs: asked once, and again after Other...
let editorsAsked: Promise<PhotoEditor[]> | null = null;
// A chosen editor that's gone is said once a run, not on every viewer.
let fallbackSaid = false;

function readChoice(): string | null {
  try {
    return localStorage.getItem(CHOICE_KEY);
  } catch {
    return null;
  }
}

/** The chosen editor first, the rest in Lifer's suggested order (the desktop app lists them so).
 *  With no choice, or one no longer installed, the first found leads. */
export function orderEditors(editors: PhotoEditor[], chosen: string | null): PhotoEditor[] {
  return [...editors].sort((a, b) => Number(b.id === chosen) - Number(a.id === chosen));
}

/** Photos to open: a photo id is one exact version, a capture id the photo it shows. `edited`
 *  opens the edited file of a photo that also has a RAW, rather than the RAW. */
export type EditorTargets = ({ captureIds: string[] } | { photoIds: string[] }) & { edited?: boolean };

/** Editors installed on this computer, the chosen one first, and a way to open photos' files in
 *  one. Empty on a server or in a browser, where the files aren't on this computer; also empty
 *  when none is installed. */
export function useOpenInEditors(): {
  editors: PhotoEditor[];
  openIn: (editor: PhotoEditor, targets: EditorTargets) => void;
  /** Settings' Edit photos with: remembered on this computer. */
  choose: (id: string) => void;
  /** Other...: the system's file picker chooses an app, which then becomes the choice. */
  pickOther: () => Promise<void>;
} {
  const { t } = useTranslation();
  const toast = useToast();
  const local = useDeploymentMode() === "desktop";
  const [found, setFound] = useState<PhotoEditor[]>([]);
  const [choice, setChoice] = useState(readChoice);

  const load = useCallback(
    (fresh: boolean) => {
      const invoke = tauriInvoke();
      if (!invoke) return Promise.resolve([]);
      if (fresh) editorsAsked = null;
      editorsAsked ??= invoke("editors_list").then(
        (l) => (Array.isArray(l) ? (l as PhotoEditor[]) : []),
        () => [],
      );
      return editorsAsked;
    },
    [],
  );

  useEffect(() => {
    if (!local) return;
    let live = true;
    void load(false).then((l) => {
      if (!live) return;
      setFound(l);
      const chosen = readChoice();
      if (chosen && l.length > 0 && !l.some((e) => e.id === chosen) && !fallbackSaid) {
        fallbackSaid = true;
        toast.info(t("openIn.fallback", { name: l[0].name }));
      }
    });
    return () => {
      live = false;
    };
  }, [local, load, t, toast]);

  const choose = useCallback((id: string) => {
    try {
      localStorage.setItem(CHOICE_KEY, id);
    } catch {
      // Remembering is a convenience only: this run still uses it.
    }
    setChoice(id);
  }, []);

  const pickOther = useCallback(async () => {
    const invoke = tauriInvoke();
    if (!invoke) return;
    try {
      const picked = (await invoke("editor_pick_other")) as PhotoEditor | null;
      if (!picked) return;
      setFound(await load(true));
      choose(picked.id);
    } catch {
      toast.error(t("openIn.pickFailed"));
    }
  }, [choose, load, t, toast]);

  const openIn = useCallback(
    (editor: PhotoEditor, targets: EditorTargets) => {
      const invoke = tauriInvoke();
      if (!invoke) return;
      void api
        .post("/originals/editor-paths", targets)
        .then(({ paths }) => {
          if (paths.length === 0) throw new Error("none");
          return invoke("open_in", { editorId: editor.id, paths });
        })
        .catch(() => toast.error(t("openIn.failed", { name: editor.name })));
    },
    [t, toast],
  );

  const editors = useMemo(() => orderEditors(found, choice), [found, choice]);
  return { editors, openIn, choose, pickOther };
}
