import { useState } from "react";
import { useTranslation } from "react-i18next";
import FarPhotosConfirm from "../components/FarPhotosConfirm";
import type { Geoprivacy } from "../components/SavedSpots";
import { errorMessage } from "../lib/errorMessage";
import { useFileUnderPlace } from "./useSavedSpots";

export interface ChosenPlace {
  id: string;
  name: string;
  locality: string | null;
  geoprivacy: Geoprivacy | null;
}

const SENT_AS = { obscured: "sendPlace.sentObscured", private: "sendPlace.sentPrivate" } as const;

/** "Will be sent obscured" when a place's privacy isn't open, so a send never surprises. */
export function sentPrivacyLine(t: (key: string) => string, geoprivacy: Geoprivacy | null | undefined) {
  return geoprivacy && geoprivacy !== "open" ? t(SENT_AS[geoprivacy]) : null;
}

/** Files photos under a chosen place, asking inline first when some were taken far from it. */
export function usePlaceFiling(onFiled: () => void) {
  const { t } = useTranslation();
  const filing = useFileUnderPlace(() => {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(work: () => Promise<boolean>) {
    setBusy(true);
    setError(null);
    try {
      if (await work()) onFiled();
    } catch (err) {
      setError(errorMessage(err, t("sendPlace.failed")));
    } finally {
      setBusy(false);
    }
  }

  return {
    busy,
    error,
    file: (place: ChosenPlace, captureIds: string[]) => run(() => filing.file(place.id, captureIds)),
    farNode: filing.far && (
      <FarPhotosConfirm
        far={filing.far}
        busy={busy}
        onFile={(move) => void run(() => filing.confirm(move).then(() => true))}
        onCancel={filing.dismiss}
      />
    ),
  };
}
