import type { CullMarksOption } from "@lifer/shared";
import Select from "../Select";
import { pluralize } from "../../lib/pluralize";

const OPTIONS: Array<{ value: CullMarksOption; label: string }> = [
  { value: "skip", label: "Skip them" },
  { value: "hide", label: "Import them hidden" },
  { value: "ignore", label: "Import them anyway" },
];

/** "212 photos, 37 marked rejected by your culling app" and what to do with those, on an import
 *  screen. Nothing when no photo was rejected. See docs/docs/guides/culling-with-other-apps.md. */
export default function CullMarksChoice({
  total,
  rejected,
  value,
  onChange,
  disabled,
}: {
  total: number;
  rejected: number;
  value: CullMarksOption;
  onChange: (value: CullMarksOption) => void;
  disabled?: boolean;
}) {
  if (rejected === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface-muted px-3 py-2 text-sm text-muted">
      <span data-testid="cull-summary">
        {pluralize(total, "photo")}, {rejected.toLocaleString()} marked rejected by your culling app.
      </span>
      <Select
        label="Rejected photos"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as CullMarksOption)}
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
      {value === "hide" && (
        <span className="text-xs">
          Hidden photos stay out of your gallery and life list. Find them with the Gallery's Hidden filter.
        </span>
      )}
    </div>
  );
}
