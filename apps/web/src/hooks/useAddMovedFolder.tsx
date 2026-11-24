import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { MOVED_PHOTOS_LOOK_STARTED, movedPhotosChanged } from "./useMovedPhotos";
import { useToast } from "./useToast";
import { errorMessage } from "../lib/errorMessage";
import { pickFolderNative } from "../lib/pickFolderNative";
import { FolderBrowser } from "../components/FolderPicker";
import Modal from "../components/Modal";

/** Picks the folder photos moved to, adds it to the places photos live and looks right away.
 *  Lifer never guesses the new location: the picker only starts near the old one. `node` holds
 *  the in-app picker for when there is no native one, so render it. */
export function useAddMovedFolder() {
  const { t } = useTranslation();
  const toast = useToast();
  const [browseFrom, setBrowseFrom] = useState<string | null>(null);

  async function add(path: string) {
    try {
      await api.post("/moved-photos/places", { path, merge: true });
      movedPhotosChanged();
      await api.post("/moved-photos/look", { manual: true });
      window.dispatchEvent(new Event(MOVED_PHOTOS_LOOK_STARTED));
    } catch (err) {
      toast.error(errorMessage(err, t("movedPhotos.settings.saveFailed")));
    }
  }

  async function choose(start: string) {
    const native = await pickFolderNative(start);
    if (native === undefined) setBrowseFrom(start);
    else if (native) await add(native);
  }

  const node = (
    <Modal open={browseFrom !== null} onClose={() => setBrowseFrom(null)} title={t("movedPhotos.suggest.pickTitle")}>
      <FolderBrowser
        initialPath={browseFrom ?? undefined}
        onChoose={(p) => {
          setBrowseFrom(null);
          void add(p);
        }}
        onCancel={() => setBrowseFrom(null)}
      />
    </Modal>
  );
  return { choose, node };
}
