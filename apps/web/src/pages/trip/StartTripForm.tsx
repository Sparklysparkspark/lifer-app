import { useId, useState } from "react";
import Button from "../../components/Button";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { localIsoDate } from "@lifer/shared";
import { api, ApiError } from "../../api/client";
import FormMessage from "../../components/FormMessage";
import TextField, { NameField } from "../../components/TextField";
import RegionBrowser from "../../components/RegionBrowser";
import { Field, FolderField, FORM, FormActions } from "./TripFormParts";
import Panel from "../../components/Panel";

// WebKit greys today's date into an empty date field, which reads as filled in; hide it until focused.
const EMPTY_DATE = "[&:not(:focus)::-webkit-datetime-edit]:opacity-0";

// "Start a trip": made now, before any photos, so imports can join it as they happen. Its folder
// is Trips/<name> in the library unless the user picks one.
export default function StartTripForm({ onCancel }: { onCancel: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState(localIsoDate);
  const [endDate, setEndDate] = useState("");
  const [regionId, setRegionId] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endHintId = useId();
  // An empty name starts "Untitled Trip", as the folder preview shows.
  const tripName = name.trim() || t("trips.create.untitled");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await api.post("/trips/start", {
        name: tripName,
        startDate,
        endDate: endDate || null,
        regionId,
        folder: folder ?? undefined,
      });
      navigate(`/trips/${res.id}?mode=build`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("trips.create.failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel as="form" onSubmit={submit} className={FORM}>
      <Field label={t("common.name")} htmlFor="start-trip-name">
        <NameField
          id="start-trip-name"
          type="text"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("trips.create.namePlaceholder")}
        />
      </Field>
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <Field label={t("trips.start.startDate")} htmlFor="start-trip-start">
          <TextField
            id="start-trip-start"
            type="date"
            required
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </Field>
        <Field
          label={t("trips.start.endDate")}
          htmlFor="start-trip-end"
          hint={t("trips.start.endDateHint")}
          hintId={endHintId}
        >
          <TextField
            id="start-trip-end"
            type="date"
            min={startDate}
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            aria-describedby={endHintId}
            className={endDate ? "" : EMPTY_DATE}
          />
        </Field>
      </div>
      <Field label={t("trips.start.region")}>
        <RegionBrowser regionId={regionId} onChange={setRegionId} hint={t("trips.start.regionHint")} size="md" />
      </Field>
      <Field label={t("trips.start.folder")} hint={t("trips.start.folderHint")}>
        <FolderField folder={folder} fallback={t("trips.start.libraryFolder", { name: tripName })} onChoose={setFolder}>
          {folder && (
            <Button variant="link" onClick={() => setFolder(null)} className="shrink-0 text-link">
              {t("trips.start.useLibrary")}
            </Button>
          )}
        </FolderField>
      </Field>
      <FormMessage error={error} />
      <FormActions onCancel={onCancel} submitLabel={t("trips.start.submit")} saving={saving} />
    </Panel>
  );
}
