import { createContext, useContext } from "react";
import type { ApiResponse } from "../api/client";

export type SendHints = ApiResponse<"/places/send-hints", "post">;
export type LooksLike = NonNullable<SendHints["looksLike"]>;

export interface PlaceStepRequest {
  /** The photos the chosen place is applied to. */
  captureIds: string[];
  /** A located photo's point, for Nearby. Local only. */
  near: { lat: number; lon: number } | null;
  looksLike: LooksLike | null;
  /** The main button is Send (the caller sends after); otherwise Set place. */
  send: boolean;
  /** Says the photos have no location, and offers "Send without a location". */
  offerWithout?: boolean;
}
/** "placed" once the place is applied, "without" to send as they are, null when cancelled. */
export type PlaceStepResult = "placed" | "without" | null;
export type PlaceStepFn = (request: PlaceStepRequest) => Promise<PlaceStepResult>;

// Provided by components/PlaceStep.tsx.
export const PlaceStepContext = createContext<PlaceStepFn | null>(null);

/** Asks for a place for some photos before sending them; null outside the provider. */
export function usePlaceStep(): PlaceStepFn | null {
  return useContext(PlaceStepContext);
}
