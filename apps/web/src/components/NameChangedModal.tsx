import { useEffect, useState } from "react";
import { api } from "../api/client";
import { errorMessage } from "../lib/errorMessage";
import Modal from "./Modal";
import Button from "./Button";
import FormMessage from "./FormMessage";

interface SplitOptions {
  captureIds: string[];
  species: Array<{ id: string; scientificName: string; commonName: string | null; photoUrl: string | null }>;
}

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
  const [options, setOptions] = useState<SplitOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<SplitOptions>(`/species/${speciesId}/split`)
      .then((d) => !cancelled && setOptions(d))
      .catch((err) => !cancelled && setError(errorMessage(err, "Couldn't load the new species")));
    return () => {
      cancelled = true;
    };
  }, [speciesId]);

  async function choose(body: { speciesId: string } | { keep: true }, key: string) {
    setSaving(key);
    setError(null);
    try {
      await api.post(`/species/${speciesId}/split`, body);
      onChanged();
      onClose();
    } catch (err) {
      setError(errorMessage(err, "Couldn't update your photos"));
    } finally {
      setSaving(null);
    }
  }

  const count = options?.captureIds.length ?? 0;
  return (
    <Modal open onClose={onClose} title="Name changed" size="sm">
      <FormMessage error={error} />
      {!options ? (
        !error && <p className="text-sm text-muted">Loading…</p>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-muted">
            {speciesName} (<i>{scientificName}</i>) has been split into {options.species.length} species. Which is in
            your {count === 1 ? "photo" : `${count} photos`}?
          </p>
          <ul className="space-y-2">
            {options.species.map((s) => (
              <li key={s.id} className="flex items-center gap-3">
                {s.photoUrl ? (
                  <img src={s.photoUrl} alt="" className="h-12 w-12 shrink-0 rounded-md object-cover" />
                ) : (
                  <div className="h-12 w-12 shrink-0 rounded-md bg-surface-muted" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-ink">{s.commonName ?? s.scientificName}</p>
                  <p className="truncate text-xs italic text-muted">{s.scientificName}</p>
                </div>
                <Button
                  size="sm"
                  loading={saving === s.id}
                  disabled={saving !== null}
                  onClick={() => void choose({ speciesId: s.id }, s.id)}
                >
                  This one
                </Button>
              </li>
            ))}
          </ul>
          <div className="border-t border-line pt-3">
            <Button
              variant="secondary"
              size="sm"
              loading={saving === "keep"}
              disabled={saving !== null}
              onClick={() => void choose({ keep: true }, "keep")}
            >
              Keep {scientificName}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
