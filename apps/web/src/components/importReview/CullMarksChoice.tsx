import type { CullMarksOption } from "@lifer/shared";
import { useTranslation } from "react-i18next";
import Select from "../Select";
import { formatNumber } from "../../lib/format";

const OPTIONS: Array<{ value: CullMarksOption; labelKey: string }> = [
  { value: "skip", labelKey: "import.cullMarks.skip" },
  { value: "hide", labelKey: "import.cullMarks.hide" },
  { value: "ignore", labelKey: "import.cullMarks.ignore" },
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
  const { t } = useTranslation();
  if (rejected === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control border border-line bg-surface-muted px-3 py-2 text-callout text-muted">
      <span data-testid="cull-summary">
        {t("import.cullMarks.summary", { count: total, rejected: formatNumber(rejected) })}
      </span>
      <Select
        label={t("import.cullMarks.label")}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as CullMarksOption)}
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {t(o.labelKey)}
          </option>
        ))}
      </Select>
      {value === "hide" && <span className="text-footnote">{t("import.cullMarks.hiddenHint")}</span>}
    </div>
  );
}
