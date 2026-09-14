// The plain text-underline Select/Cancel toggle — GalleryPage's own original style, now the one
// standard used everywhere a grid offers multi-select (previously Album had its own bordered
// button ("Select"/"Done") that looked like a different control entirely).
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
