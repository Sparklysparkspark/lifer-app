// Keys added to en.json ahead of the code that uses them, so check:i18n's unused-key rule passes
// meanwhile. Whoever wires a key deletes its line here; this list may only shrink. When a key's
// replacement goes live, delete the key it replaces from en.json too.
export const PENDING_KEYS = [
  // PlaceNameInput: count for metaLine([region, count]) (X-8)
  "placeName.photoCount",
  // Shared selection bar
  "ui.selection.selected",
] as const;
