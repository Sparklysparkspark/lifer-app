import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../../api/client";
import FormMessage from "../../components/FormMessage";
import { NameField } from "../../components/TextField";
import { Field, FolderField, FORM, FormActions } from "./TripFormParts";
import Panel from "../../components/Panel";

// "Add trip from folder": a trip made from a folder that already holds its photos, scanned on open.
export default function ImportTripForm({ onCancel }: { onCancel: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [chosenFolder, setChosenFolder] = useState<string | null>(null);
  // Where the trip's wildlife is filed: null means the suggested "<trip folder>/Wildlife".
  const [destinationFolder, setDestinationFolder] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createTrip(e: React.FormEvent) {
    e.preventDefault();
    if (!chosenFolder) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.post("/trips", {
        name: name.trim() || undefined,
        sourceFolder: chosenFolder,
        destinationFolder: destinationFolder ?? undefined,
      });
      navigate(`/trips/${res.id}`, { state: { scan: true } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("trips.create.failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel as="form" onSubmit={createTrip} className={FORM}>
      <Field label={t("common.name")} htmlFor="import-trip-name">
        <NameField
          id="import-trip-name"
          type="text"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("trips.create.namePlaceholder")}
        />
      </Field>
      <Field label={t("trips.create.folderLabel")} hint={t("trips.create.folderHint")}>
        <FolderField folder={chosenFolder} chooseLabel={t("trips.create.chooseFolder")} onChoose={setChosenFolder} />
      </Field>
      {chosenFolder && (
        <Field label={t("trips.create.destinationLabel")} hint={t("trips.create.destinationHint")}>
          <FolderField folder={destinationFolder ?? `${chosenFolder}/Wildlife`} onChoose={setDestinationFolder} />
        </Field>
      )}
      <FormMessage error={error} />
      <FormActions
        onCancel={onCancel}
        submitLabel={t("trips.create.submit")}
        saving={saving}
        disabled={!chosenFolder}
      />
    </Panel>
  );
}
