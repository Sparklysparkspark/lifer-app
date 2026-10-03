import { useEffect, useState } from "react";

/** Always-editable inline text (a name or description) that saves on blur, and only when the
 * trimmed value changed. A bottom border on hover/focus is the only edit affordance. */
export default function EditableTextField({
  value,
  onSave,
  placeholder,
  hint,
  className,
  multiline,
}: {
  value: string;
  onSave: (next: string) => void;
  placeholder?: string;
  /** Optional caption under the field. */
  hint?: string;
  className?: string;
  multiline?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  function commit() {
    if (draft.trim() !== value.trim()) onSave(draft.trim());
  }

  const shared = `block w-full min-w-0 rounded-sm border-b border-transparent bg-transparent px-0 outline-none transition-colors hover:border-line focus:border-ink ${className ?? ""}`;

  return (
    <div className="min-w-0">
      {multiline ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          placeholder={placeholder}
          rows={2}
          className={`${shared} resize-none`}
        />
      ) : (
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          placeholder={placeholder}
          className={shared}
        />
      )}
      {hint && <p className="mt-0.5 text-[11px] text-muted">{hint}</p>}
    </div>
  );
}
