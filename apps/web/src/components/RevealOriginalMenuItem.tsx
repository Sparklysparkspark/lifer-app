import { MenuItem } from "./Menu";
import { useRevealFiles } from "../hooks/useRevealOriginal";

/** A photo menu's Show in Finder (or Copy path, when the file isn't on this computer), one per
 *  stored file, so an edit and its RAW can each be found. */
export default function RevealOriginalMenuItem({
  refs,
  onSelect,
}: {
  refs: ReadonlyArray<string | null | undefined>;
  /** Runs first, e.g. to close the menu. */
  onSelect?: () => void;
}) {
  return useRevealFiles(refs).map((reveal) => (
    <MenuItem
      key={reveal.label}
      onSelect={() => {
        onSelect?.();
        reveal.run();
      }}
    >
      {reveal.label}
    </MenuItem>
  ));
}
