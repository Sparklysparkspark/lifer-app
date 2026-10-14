// Same look as the inactive Filters pill beside it; a plain button since it isn't a toggle state.
const CLASSES =
  "inline-flex items-center justify-center h-8 rounded-md border border-line px-3 text-xs font-medium text-muted transition-colors hover:bg-surface-muted";

// The Select/Cancel toggle every multi-select grid uses.
export default function SelectModeToggle({
  active,
  onEnter,
  onExit,
}: {
  active: boolean;
  onEnter: () => void;
  onExit: () => void;
}) {
  return (
    <button type="button" onClick={active ? onExit : onEnter} className={CLASSES}>
      {active ? "Cancel" : "Select"}
    </button>
  );
}
