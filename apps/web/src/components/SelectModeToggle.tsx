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
  return active ? (
    <button onClick={onExit} className="text-xs text-muted hover:underline">
      Cancel
    </button>
  ) : (
    <button onClick={onEnter} className="text-xs text-muted hover:underline">
      Select
    </button>
  );
}
