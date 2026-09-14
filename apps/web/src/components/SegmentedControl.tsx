import Pill from "./Pill";

// A 3(+)-way toggle for mutually-exclusive options (e.g. RAW files: Any/With/Without, Media
// type: Both/Photos/Videos) — replaces pairs of independent checkboxes that could contradict
// each other. Built on the same Pill component as every other toggle button in the app, so this
// reads as one consistent control language rather than its own separate widget.
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
    <div className="flex gap-1">
      {options.map((o) => (
        <Pill key={o.value} size={size} active={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </Pill>
      ))}
    </div>
  );
}
