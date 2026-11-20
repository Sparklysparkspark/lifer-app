import type { ChangeEvent } from "react";

/** The select tick in the corner of a photo or card: one look for every grid. With `onChange` it is
 *  the control itself (the Gallery's photos); without, it only shows the state of an item whose
 *  whole body is what's clicked (species and iNaturalist cards). */
export default function SelectMark({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
}) {
  // left-2 top-2 on a 16px box has its centre where the 20px overlay pills at right-2 top-1.5 have
  // theirs, so the corners line up. z-[1]: a caller's own overlay would otherwise sit on top.
  const place = "absolute left-2 top-2 z-[1] h-4 w-4 accent-accent";
  return onChange ? (
    // raw-control: a bare overlay on the photo, with no label beside it.
    <input type="checkbox" checked={checked} onChange={onChange} className={place} aria-label={label} />
  ) : (
    // raw-control: shows state only; the item around it takes the click.
    <input
      type="checkbox"
      checked={checked}
      readOnly
      tabIndex={-1}
      aria-label={label}
      className={`${place} pointer-events-none`}
    />
  );
}
