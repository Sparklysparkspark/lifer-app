import Pill from "./Pill";

// Mutually exclusive options (e.g. RAW: Any/With/Without) as a row of Pills.
export default function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  size = "sm",
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  size?: "sm" | "md";
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => (
        <Pill key={o.value} size={size} active={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </Pill>
      ))}
    </div>
  );
}
