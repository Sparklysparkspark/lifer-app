// TitleBarDragRegion's strip sits above everything, so it wins hit-tests over a modal's own
// controls in the top band. A modal (Lightbox) raises this to hide the strip while open.
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
