import { createContext, useEffect, useState } from "react";

// Below this width photo grids switch to a phone layout: square thumbnails edge to edge with
// hairline gaps, like a phone's photo app. Tailwind's sm.
const PHONE_MAX_PX = 640;

/** True inside a grid in phone layout: tiles drop their rounded corners and captions. */
export const CompactGridContext = createContext(false);

export function useIsPhoneWidth(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.innerWidth < PHONE_MAX_PX);
  useEffect(() => {
    const update = () => setPhone(window.innerWidth < PHONE_MAX_PX);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return phone;
}
