import { createPortal } from "react-dom";
import { ModalPanel, type ModalProps } from "./Modal";

export type SidePanelProps = Omit<ModalProps, "size" | "dismissOnBackdrop" | "onSubmit"> & {
  /** Dims and blocks the page like a dialog. Off by default, so the list beside it stays usable. */
  backdrop?: boolean;
};

/** One item's details and actions on the right, beside the list it came from. The shared Modal's
 *  focus trap, Escape layering and focus return; a dialog or the viewer opens above it. Below
 *  640 px it fills the window. Galleries, confirms and short one-field dialogs stay a Modal. */
export default function SidePanel({ backdrop = false, ...props }: SidePanelProps) {
  if (!props.open || typeof document === "undefined") return null;
  return createPortal(<ModalPanel {...props} side backdrop={backdrop} dismissOnBackdrop={backdrop} />, document.body);
}
