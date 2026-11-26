import type { ReactNode } from "react";
import { ScreenshotFrame, type Shot } from "../../site-kit/components";
import type { Beat } from "../../data/features";
import styles from "./landing.module.css";

// A crop narrower than a full screenshot (a settings panel) shows at its own scale.
function Media({ alt, light, dark }: { alt: string; light: Shot; dark: Shot }) {
  return (
    <div className={styles.beatMedia} style={light.width < 1200 ? { maxWidth: "36rem" } : undefined}>
      <ScreenshotFrame alt={alt} light={light} dark={dark} />
    </div>
  );
}

/** A line of beats, each with its screenshot; the beat marked `tree` shows `last` instead, and a
 *  beat with neither is text alone. */
export default function TripStory({
  beats,
  shot,
  last,
}: {
  beats: Beat[];
  shot: (name: string) => { light: Shot; dark: Shot };
  last: ReactNode;
}) {
  return (
    <ol className={styles.story}>
      {beats.map((b) => (
        <li key={b.title} className={styles.beat}>
          <div className={styles.beatText}>
            <p className={styles.kicker}>{b.kicker}</p>
            <h3>{b.title}</h3>
            <p>{b.text}</p>
          </div>
          {b.image ? <Media alt={b.alt ?? ""} {...shot(b.image)} /> : b.tree && last}
        </li>
      ))}
    </ol>
  );
}
