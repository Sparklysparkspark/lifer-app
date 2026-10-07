import { useLayoutEffect, useRef, type RefObject } from "react";

/** A ref that always holds the newest `value`, for listeners, timers and request callbacks that
 *  outlive the render that created them. Written in a layout effect rather than during render, so
 *  a render React discards never leaks in, and it's current before any passive effect runs. */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
