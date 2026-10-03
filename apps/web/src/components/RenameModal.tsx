import { useState } from "react";
import Button from "./Button";
import FormMessage from "./FormMessage";
import Modal from "./Modal";

interface RenameModalProps {
  title: string;
  initialName: string;
  onCancel: () => void;
  onSave: (name: string) => Promise<void>;
}

// Name-only rename for albums and trips. Enter saves through the form.
export default function RenameModal({ title, initialName, onCancel, onSave }: RenameModalProps) {
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(name.trim());
    } catch {
      setError("Couldn't save. Try again.");
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onCancel} title={title}>
      <form onSubmit={save}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          required
          aria-label={title}
          className="mt-1 w-full rounded-md border border-line px-3 py-2 text-sm"
        />
        <FormMessage error={error} className="mt-2" />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!name.trim()} loading={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
