// The wide detail pane's content: the selection, or a preview of the arc or row the pointer rests
// on. Only this subscribes to the preview, so hovering never re-renders the tree.
import type { ReactNode } from "react";
import { usePreview } from "./previewStore";

export default function PreviewPane({
  selected,
  has,
  render,
  children,
}: {
  selected: string | null;
  /** Whether the tree still holds an id, so a preview from before a region change is dropped. */
  has: (id: string) => boolean;
  /** The pane for a previewed id. */
  render: (id: string) => ReactNode;
  /** The pane for the selection, or the empty prompt. */
  children: ReactNode;
}) {
  const preview = usePreview();
  const id = preview && preview !== selected && has(preview) ? preview : null;
  return (
    <div
      key={id ?? selected ?? ""}
      className="motion-safe:transition-opacity motion-safe:duration-300 motion-safe:starting:opacity-0"
    >
      {id ? render(id) : children}
    </div>
  );
}
