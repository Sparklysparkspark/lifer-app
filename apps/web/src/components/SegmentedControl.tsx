import Pill from "./Pill";
import { formatNumber } from "../lib/format";

// Mutually exclusive options (e.g. RAW: Any/With/Without) as a row of Pills.
export default function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  size = "sm",
  label,
}: {
  value: T;
  /** `count` shows muted after the label, e.g. how many items a tab holds. */
  options: ReadonlyArray<{ value: T; label: string; count?: number }>;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  /** Names the group for screen readers. */
  label?: string;
}) {
  return (
    <div className="flex flex-wrap gap-1" role={label ? "group" : undefined} aria-label={label}>
      {options.map((o) => (
        <Pill key={o.value} size={size} active={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
          {o.count !== undefined && (
            // The space keeps the count a separate word for screen readers; a flex row drops it visually.
            <>
              {" "}
              <span className="ml-1.5 tabular-nums opacity-75">{formatNumber(o.count)}</span>
            </>
          )}
        </Pill>
      ))}
    </div>
  );
}
