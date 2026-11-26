import { useEffect, useRef, useState } from "react";
import styles from "./landing.module.css";

const fmt = (n: number) => n.toLocaleString("en-US");

/** A number that counts up once when scrolled into view. The page is built with the final number,
 *  so it shows as is without JavaScript or with reduced motion. */
export default function Counter({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const el = ref.current;
    if (!el || !("IntersectionObserver" in window)) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Already on screen at load: leave it, a count from zero there would only flicker.
    const box = el.getBoundingClientRect();
    if (box.top < window.innerHeight && box.bottom > 0) return;
    setShown(0);
    let raf = 0;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        const t0 = performance.now();
        const tick = (now: number) => {
          const t = Math.min(1, (now - t0) / 1200);
          setShown(Math.round(value * (1 - (1 - t) ** 3)));
          if (t < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [value]);
  return (
    <span ref={ref} data-counter={value}>
      {/* Screen readers get the final number only. */}
      <span aria-hidden="true">{fmt(shown)}</span>
      <span className={styles.srOnly}>{fmt(value)}</span>
    </span>
  );
}
