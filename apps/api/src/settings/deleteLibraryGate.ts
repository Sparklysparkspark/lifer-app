// Gate for POST /settings/delete-local-library: the library on this computer may only go once
// it's linked to a server and the push (sync/push.ts) has sent every capture, including the
// ones that failed last time.
export interface PushState {
  linked: boolean;
  pushRunning: boolean;
  lastPushError: string | null;
  /** Captures and species marks changed here that the server doesn't have yet, or has an older copy of. */
  unpushed: number;
}

export function deleteLocalLibraryBlockedReason(state: PushState): string | null {
  if (!state.linked) return "Local files can only be deleted once this library is linked to a server.";
  if (state.pushRunning) return "Photos are still being sent to the server.";
  if (state.unpushed > 0) {
    const n = state.unpushed;
    return `${n} change${n === 1 ? " isn't" : "s aren't"} on the server yet, so local files can't be deleted.`;
  }
  if (state.lastPushError != null)
    return "The last push to the server stopped with an error. Sync again until it finishes.";
  return null;
}
