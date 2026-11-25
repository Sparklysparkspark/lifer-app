import { useState } from "react";
import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { api, apiPath } from "../../api/client";
import Modal from "../../components/Modal";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import SegmentedControl from "../../components/SegmentedControl";
import SpeciesPicker, { type SpeciesResult } from "../../components/SpeciesPicker";
import { useToast } from "../../hooks/useToast";
import { addToChecklist, addedMessage, type ChecklistTarget } from "../../lib/checklistAdditions";
import { errorMessage } from "../../lib/errorMessage";
import { useSpeciesName } from "../../lib/speciesName";
import { useServerSetting } from "../settings/useServerSetting";
import Checkbox from "../../components/Checkbox";

// Puts a species the checklist is missing on it: picked by search from every species Lifer has,
// including ones you imported by hand. `targets` is what the view shows: the region, plus any sea
// zone ticked on it, so with several the dialog asks which checklist it's for. The first is picked
// to start with.
export default function AddSpeciesToChecklistModal({
  targets,
  onClose,
  onAdded,
}: {
  targets: ChecklistTarget[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const speciesName = useSpeciesName();
  const [targetId, setTargetId] = useState(targets[0]?.id ?? "");
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [markSeen, setMarkSeen] = useState(true);
  // Lifer's own lists are vertebrates, so without this a moth or orchid looks unaddable.
  const inatSearch = useServerSetting("anyTaxaSearchEnabled", "/settings/any-taxa-search");
  const target = targets.find((c) => c.id === targetId) ?? targets[0];
  const regionName = targets.find((c) => c.kind === "region")?.name ?? target?.name ?? "";

  async function add(species: SpeciesResult) {
    if (!target) return;
    const name = speciesName(species);
    setAdding(name);
    setError(null);
    try {
      const result = await addToChecklist(target.id, species.id, target.kind);
      // Already on the checklist by now, so a failure here mustn't read as "couldn't add".
      if (markSeen)
        await api
          .patch(apiPath("/species/{id}/seen", { id: species.id }))
          .catch(() => toast.error(t("collection.addSpecies.markSeenFailed", { name })));
      toast.success(addedMessage(result, name, target));
      onAdded();
      onClose();
    } catch (err) {
      setError(errorMessage(err, t("collection.addSpecies.addFailed", { name })));
    } finally {
      setAdding(null);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t("collection.addSpecies.title", { region: regionName })}
      footerStart={
        <p className="text-footnote text-muted">
          <Trans
            i18nKey="collection.addSpecies.ebirdHint"
            components={{
              a: <Link to="/settings/species#ebird-import" className="underline hover:text-ink" />,
            }}
          />
        </p>
      }
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t("common.cancel")}
        </Button>
      }
    >
      <p className="mb-3 text-callout text-muted">{t("collection.addSpecies.intro")}</p>
      {targets.length > 1 && (
        <div className="mb-3 space-y-1.5">
          <p className="text-footnote font-medium text-ink">{t("collection.addSpecies.addTo")}</p>
          <SegmentedControl
            value={target?.id ?? ""}
            options={targets.map((c) => ({
              value: c.id,
              label: c.kind === "seaZone" ? t("collection.addSpecies.seaZone", { name: c.name }) : c.name,
            }))}
            onChange={setTargetId}
          />
        </div>
      )}
      <Checkbox checked={markSeen} onChange={setMarkSeen} className="mb-3">
        {t("collection.addSpecies.markSeen")}
      </Checkbox>
      <Checkbox
        checked={inatSearch.value ?? false}
        disabled={inatSearch.value === null || inatSearch.saving}
        onChange={(checked) => void inatSearch.save(checked)}
        description={t("collection.addSpecies.inatSearchHint")}
        className="mb-3"
      >
        {t("collection.addSpecies.inatSearch")}
      </Checkbox>
      <FormMessage error={inatSearch.error} className="mb-3" />
      <div>
        <SpeciesPicker onSelect={add} autoFocus inline placeholder={t("collection.addSpecies.placeholder")} />
        {adding && (
          <p className="mt-2 text-footnote text-muted">{t("collection.addSpecies.adding", { name: adding })}</p>
        )}
        <FormMessage error={error} className="mt-2" />
      </div>
    </Modal>
  );
}
