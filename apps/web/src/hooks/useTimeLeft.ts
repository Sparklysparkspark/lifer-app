import { useState } from "react";
import { initialTimeLeft, nextTimeLeft, type TimeLeft } from "../lib/timeLeft";
import { useNow } from "./useNow";

const MEASURING: TimeLeft = { kind: "measuring" };
const TICK_MS = 250;

/** Time left for work `done` of `total`, read a few times a second so it counts down between polls
 *  and notices a stall. */
export function useTimeLeft(done: number | null, total: number | null): TimeLeft {
  const now = useNow(TICK_MS);
  const [seen, setSeen] = useState({ state: initialTimeLeft(), now: 0, value: MEASURING });
  if (done == null || total == null) return MEASURING;
  if (now !== seen.now) {
    // Adjusted while rendering (React's "storing information from previous renders"), once per tick.
    const next = nextTimeLeft(seen.state, now, done, total);
    setSeen({ state: next.state, now, value: next.value });
    return next.value;
  }
  return seen.value;
}
