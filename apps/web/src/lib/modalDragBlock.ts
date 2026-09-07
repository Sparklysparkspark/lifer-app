// TitleBarDragRegion deliberately sits above everything (z-index: max int32) so window-dragging
// stays reliable no matter what's open — but that means it also wins the browser's hit-test over
// any of a page's OWN fixed/absolute controls that happen to sit in its top-56px band, since it's
// a separate sibling element, not an ancestor those controls could take precedence within (the
// descendant carve-out Tauri's own drag-region handling supports doesn't apply here). Lightbox's
// close/info buttons sit exactly there — this is how a modal that needs those clicks to actually
// land opts itself out of the drag region while it's open, rather than the two fighting via
// z-index (which the drag region would always need to win against everything else).
let count = 0;
const listeners = new Set<() => void>();

export function markDragBlocked(blocked: boolean): void {
  count += blocked ? 1 : -1;
  listeners.forEach((l) => l());
}

export function isDragBlocked(): boolean {
  return count > 0;
}

export function subscribeDragBlocked(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
