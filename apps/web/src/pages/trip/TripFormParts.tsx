import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import Button from "../../components/Button";
import { FolderBrowser } from "../../components/FolderPicker";
import FolderPath from "../../components/FolderPath";
import { pickFolderNative } from "../../lib/pickFolderNative";

// A read-only folder shown in the shape of a TextField, so it lines up with fields and buttons.
const BOX = "h-9.5 rounded-control border border-control-line px-3 text-callout text-ink";

export const FORM = "max-w-lg space-y-4";

// Label, control, then one hint line, on the Settings type scale.
export function Field({
  label,
  htmlFor,
  hint,
  hintId,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  hintId?: string;
  children: ReactNode;
}) {
  const LabelTag = htmlFor ? "label" : "p";
  return (
    <div className="min-w-0">
      <LabelTag htmlFor={htmlFor} className="mb-1.5 block text-body font-medium text-ink">
        {label}
      </LabelTag>
      {children}
      {hint && (
        <p id={hintId} className="mt-1.5 text-subheadline text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

// A folder shown as Finder names it, with Change opening the Mac's picker or the in-app browser.
// Without a folder or a fallback, only the choose button shows.
export function FolderField({
  folder,
  fallback,
  chooseLabel,
  onChoose,
  children,
}: {
  folder: string | null;
  fallback?: string;
  chooseLabel?: string;
  onChoose: (path: string) => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [browsing, setBrowsing] = useState(false);

  async function choose() {
    const native = await pickFolderNative();
    if (native === undefined) setBrowsing(true);
    else if (native) onChoose(native);
  }

  if (browsing) {
    return (
      <FolderBrowser
        onChoose={(path) => {
          onChoose(path);
          setBrowsing(false);
        }}
        onCancel={() => setBrowsing(false)}
      />
    );
  }
  const shown = folder ?? fallback;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {shown && (
        <div className={`${BOX} flex min-w-0 flex-1 basis-48 items-center bg-surface-muted`}>
          {folder ? (
            <FolderPath path={folder} />
          ) : (
            <span className="truncate" title={fallback}>
              {fallback}
            </span>
          )}
        </div>
      )}
      <Button variant="secondary" onClick={choose} className="shrink-0">
        {shown ? t("trips.create.change") : chooseLabel}
      </Button>
      {children}
    </div>
  );
}

// Cancel beside the form's main action, at the bottom right as in a sheet.
export function FormActions({
  onCancel,
  submitLabel,
  saving,
  disabled,
}: {
  onCancel: () => void;
  submitLabel: string;
  saving: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex justify-end gap-2 pt-2">
      <Button variant="secondary" onClick={onCancel}>
        {t("common.cancel")}
      </Button>
      <Button type="submit" loading={saving} disabled={disabled}>
        {saving ? t("common.creating") : submitLabel}
      </Button>
    </div>
  );
}
