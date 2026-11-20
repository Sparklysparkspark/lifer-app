import { useState } from "react";
import { useTranslation } from "react-i18next";
import Button from "./Button";
import FormMessage from "./FormMessage";
import Modal from "./Modal";
import { NameField } from "./TextField";

interface RenameModalProps {
  title: string;
  initialName: string;
  onCancel: () => void;
  onSave: (name: string) => Promise<void>;
}

// Name-only rename for albums and trips. Enter saves through the form.
export default function RenameModal({ title, initialName, onCancel, onSave }: RenameModalProps) {
  const { t } = useTranslation();
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
      setError(t("ui.rename.saveFailed"));
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onCancel}
      title={title}
      onSubmit={(e) => void save(e)}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={!name.trim()} loading={saving}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <NameField
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
        required
        aria-label={title}
        className="mt-1"
      />
      <FormMessage error={error} className="mt-2" />
    </Modal>
  );
}
