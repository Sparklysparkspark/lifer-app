import { useEffect, useRef, useState, type ReactNode } from "react";
import { ScreenshotFrame, type Shot } from "../../site-kit/components";
import styles from "./landing.module.css";

export interface Stop {
  title: string;
  text: ReactNode;
  alt: string;
  light: Shot;
  dark?: Shot;
}

/** Numbered stops beside one sticky screenshot that changes as you scroll. Without JavaScript,
 *  or on a narrow screen, each stop shows its own screenshot. */
export default function FeatureTour({ stops }: { stops: Stop[] }) {
  const [active, setActive] = useState(0);
  const [ready, setReady] = useState(false);
  const refs = useRef<(HTMLLIElement | null)[]>([]);
  useEffect(() => {
    if (!("IntersectionObserver" in window)) return;
    setReady(true);
    // A stop is current while it crosses the middle of the window.
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.stop));
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    refs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);
  return (
    <div className={styles.tour} data-ready={ready || undefined}>
      <ol className={styles.tourStops}>
        {stops.map((s, i) => (
          <li
            key={s.title}
            ref={(el) => {
              refs.current[i] = el;
            }}
            data-stop={i}
            className={styles.tourStop}
            aria-current={ready && i === active ? "step" : undefined}
          >
            <span className={styles.tourNum} aria-hidden="true">
              {String(i + 1).padStart(2, "0")}
            </span>
            <h3>{s.title}</h3>
            <p>{s.text}</p>
            <div className={styles.tourInline}>
              <ScreenshotFrame alt={s.alt} light={s.light} dark={s.dark} />
            </div>
          </li>
        ))}
      </ol>
      <div className={styles.tourStage} aria-hidden="true">
        {stops.map((s, i) => (
          <div key={s.title} className={styles.tourFrame} data-on={i === active || undefined}>
            <ScreenshotFrame alt="" light={s.light} dark={s.dark} />
          </div>
        ))}
      </div>
    </div>
  );
}
