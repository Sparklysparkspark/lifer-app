import { MenuItem } from "./Menu";
import { useRevealOriginal } from "../hooks/useRevealOriginal";

/** A photo menu's Reveal in Finder (or Copy path, when the file isn't on this computer). */
export default function RevealOriginalMenuItem({
  originalRef,
  onSelect,
}: {
  originalRef: string | null | undefined;
  /** Runs first, e.g. to close the menu. */
  onSelect?: () => void;
}) {
  const reveal = useRevealOriginal()(originalRef);
  if (!reveal) return null;
  return (
    <MenuItem
      onSelect={() => {
        onSelect?.();
        reveal.run();
      }}
    >
      {reveal.label}
    </MenuItem>
  );
}
