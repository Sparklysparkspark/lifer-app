import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import SharedSelect from "../../components/Select";
import Panel from "../../components/Panel";

export function NoValue() {
  const { t } = useTranslation();
  return <span className="text-muted">{t("stats.noValue")}</span>;
}

export function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Panel>
      <p className="text-footnote font-medium text-muted">{label}</p>
      <p className="mt-1 break-words text-title-1 font-semibold text-ink">{value}</p>
      {sub && <p className="mt-0.5 text-footnote text-muted">{sub}</p>}
    </Panel>
  );
}

export function ChartCard({
  title,
  controls,
  children,
  className,
}: {
  title: string;
  controls?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Panel className={className}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-callout font-semibold text-ink">{title}</h3>
        {controls}
      </div>
      {children}
    </Panel>
  );
}

// The shared toolbar Select, fed from an options array.
export function OptionSelect({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  ariaLabel?: string;
}) {
  return (
    <SharedSelect value={value} onChange={(e) => onChange(e.target.value)} aria-label={ariaLabel}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </SharedSelect>
  );
}
