import { useEffect, useState, type ReactNode } from "react";

/** Shows `children` until `forMs` after `since` (a timestamp), then nothing. Give it
 *  `key={since}` so a new timestamp mounts it afresh: whether it starts visible is decided once,
 *  as it mounts, so an outcome that was already old when it arrived never flashes up. */
export default function ShowForAWhile({
  since,
  forMs,
  children,
}: {
  since: number;
  forMs: number;
  children: ReactNode;
}) {
  const [visible, setVisible] = useState(() => Date.now() - since < forMs);
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => setVisible(false), since + forMs - Date.now());
    return () => clearTimeout(timer);
  }, [visible, since, forMs]);
  return visible ? children : null;
}
