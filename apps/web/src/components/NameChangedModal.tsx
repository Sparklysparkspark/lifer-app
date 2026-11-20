import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { api, apiPath } from "../api/client";
import { errorMessage } from "../lib/errorMessage";
import Modal from "./Modal";
import { useToast } from "../hooks/useToast";
import Button from "./Button";
import FormMessage from "./FormMessage";
import { useSpeciesName } from "../lib/speciesName";

interface SplitOptions {
  captureIds: string[];
  species: Array<{ id: string; scientificName: string; commonName: string | null; photoUrl: string | null }>;
}

const KEEP = "keep";

// A species you have photos of was split, and location doesn't settle which one they are.
// Picking one moves the photos there; keeping the old name stops the question for these photos.
export default function NameChangedModal({
  speciesId,
  speciesName,
  scientificName,
  onClose,
  onChanged,
}: {
  speciesId: string;
  speciesName: string;
  scientificName: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const nameOf = useSpeciesName();
  const [options, setOptions] = useState<SplitOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<SplitOptions>(`/species/${speciesId}/split`)
      .then((d) => !cancelled && setOptions(d))
      .catch((err) => !cancelled && setError(errorMessage(err, t("nameChanged.loadFailed"))));
    return () => {
      cancelled = true;
    };
  }, [speciesId, t]);

  async function choose(body: { speciesId: string } | { keep: true }, key: string) {
    setSaving(key);
    setError(null);
    try {
      await api.post(apiPath("/species/{id}/split", { id: speciesId }), body);
      onChanged();
      onClose();
      toast.success(t("nameChanged.updated"));
    } catch (err) {
      setError(errorMessage(err, t("nameChanged.updateFailed")));
    } finally {
      setSaving(null);
    }
  }

  const count = options?.captureIds.length ?? 0;
  return (
    <Modal
      open
      onClose={onClose}
      title={t("nameChanged.title")}
      footer={
        options && (
          <Button
            variant="secondary"
            loading={saving === KEEP}
            disabled={saving !== null}
            onClick={() => void choose({ keep: true }, KEEP)}
          >
            {t("nameChanged.keep", { scientificName })}
          </Button>
        )
      }
    >
      <FormMessage error={error} />
      {!options ? (
        !error && <p className="text-callout text-muted">{t("common.loading")}</p>
      ) : (
        <div className="space-y-3 text-callout">
          <p className="text-muted">
            <Trans
              i18nKey="nameChanged.splitInto"
              values={{ name: speciesName, scientificName, count: options.species.length, photos: count }}
              components={{ i: <i /> }}
            />
          </p>
          <ul className="space-y-2">
            {options.species.map((s) => (
              <li key={s.id} className="flex items-center gap-3">
                {s.photoUrl ? (
                  <img src={s.photoUrl} alt="" className="h-12 w-12 shrink-0 rounded-badge object-cover" />
                ) : (
                  <div className="h-12 w-12 shrink-0 rounded-badge bg-surface-muted" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-ink">{nameOf(s)}</p>
                  <p className="truncate text-footnote italic text-muted">{s.scientificName}</p>
                </div>
                <Button
                  size="sm"
                  loading={saving === s.id}
                  disabled={saving !== null}
                  onClick={() => void choose({ speciesId: s.id }, s.id)}
                >
                  {t("nameChanged.thisOne")}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}
