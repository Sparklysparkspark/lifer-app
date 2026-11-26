import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/** The system Reduce Motion setting, kept current while mounted. */
export function useReduceMotion(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => alive && setOn(v));
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setOn);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return on;
}

/** How many neighbours the filmstrip shows each side: up to `max`, fewer when the window is too narrow for 44 pt targets. */
export function filmstripSide(windowWidth: number, thumb: number, gap: number, max: number): number {
  const fit = Math.floor((windowWidth - 32 + gap) / (thumb + gap));
  return Math.max(0, Math.min(max, Math.floor((fit - 1) / 2)));
}
