import { useState } from "react";
import Modal from "../../components/Modal";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import SegmentedControl from "../../components/SegmentedControl";
import SpeciesPicker, { type SpeciesResult } from "../../components/SpeciesPicker";
import { useToast } from "../../hooks/useToast";
import { addToChecklist, addedMessage, type ChecklistTarget } from "../../lib/checklistAdditions";
import { errorMessage } from "../../lib/errorMessage";

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
  const toast = useToast();
  const [targetId, setTargetId] = useState(targets[0]?.id ?? "");
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const target = targets.find((t) => t.id === targetId) ?? targets[0];
  const regionName = targets.find((t) => t.kind === "region")?.name ?? target?.name ?? "";

  async function add(species: SpeciesResult) {
    if (!target) return;
    const name = species.common_name ?? species.scientific_name;
    setAdding(name);
    setError(null);
    try {
      const result = await addToChecklist(target.id, species.id, target.kind);
      toast.success(addedMessage(result, name, target));
      onAdded();
      onClose();
    } catch (err) {
      setError(errorMessage(err, `Couldn't add ${name}. Try again.`));
    } finally {
      setAdding(null);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Add a species to ${regionName}`}
      size="md"
      footer={
        <Button variant="secondary" size="sm" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <p className="mb-3 text-sm text-muted">
        Search for a species this checklist is missing, like one you imported by hand for another region. It shows here
        marked "Added by you", and its card's menu can take it off again.
      </p>
      {targets.length > 1 && (
        <div className="mb-3 space-y-1.5">
          <p className="text-xs font-medium text-ink">Add it to</p>
          <SegmentedControl
            value={target?.id ?? ""}
            options={targets.map((t) => ({ value: t.id, label: t.kind === "seaZone" ? `${t.name} (sea)` : t.name }))}
            onChange={setTargetId}
          />
        </div>
      )}
      {/* The panel scrolls, which would clip the picker's floating list, so the body keeps room for it. */}
      <div className="min-h-[20rem]">
        <SpeciesPicker onSelect={add} autoFocus placeholder="Search species to add…" />
        {adding && <p className="mt-2 text-xs text-muted">Adding {adding}…</p>}
        <FormMessage error={error} className="mt-2" />
      </div>
    </Modal>
  );
}
