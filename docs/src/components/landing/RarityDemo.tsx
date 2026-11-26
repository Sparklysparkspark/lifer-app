import { useState } from "react";
import styles from "./landing.module.css";

type Card = [common: string, latin: string, group: "birds" | "mammals" | "reptiles", here: string, worldwide: string];

// Sample cards, not real ratings: how a checklist reads the same species two ways.
const REGIONS: Record<string, Card[]> = {
  Belize: [
    ["Keel-billed Toucan", "Ramphastos sulfuratus", "birds", "Common", "Common"],
    ["Scarlet Macaw", "Ara macao", "birds", "Rare", "Common"],
    ["Jaguar", "Panthera onca", "mammals", "Legendary", "Rare"],
  ],
  Canada: [
    ["Common Loon", "Gavia immer", "birds", "Common", "Common"],
    ["Northern Cardinal", "Cardinalis cardinalis", "birds", "Occasional", "Common"],
    ["Polar Bear", "Ursus maritimus", "mammals", "Rare", "Rare"],
  ],
  Egypt: [
    ["Eurasian Hoopoe", "Upupa epops", "birds", "Common", "Common"],
    ["Nile Crocodile", "Crocodylus niloticus", "reptiles", "Legendary", "Common"],
    ["Fennec Fox", "Vulpes zerda", "mammals", "Rare", "Rare"],
  ],
};

export default function RarityDemo() {
  const [region, setRegion] = useState("Belize");
  return (
    <div className={styles.demo}>
      <div className={styles.demoHead}>
        <span className={styles.demoLabel} id="demo-region">
          Pick a region
        </span>
        <div className={styles.chips} role="group" aria-labelledby="demo-region">
          {Object.keys(REGIONS).map((r) => (
            <button
              key={r}
              type="button"
              className={styles.chip}
              aria-pressed={r === region}
              onClick={() => setRegion(r)}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      <ul className={styles.cards} aria-live="polite" data-region={region}>
        {REGIONS[region].map(([name, latin, group, here, world]) => (
          <li key={name} className={styles.card}>
            <span
              className={styles.cardSwatch}
              style={{ background: `var(--color-taxa-${group})` }}
              aria-hidden="true"
            />
            <span className={styles.cardName}>{name}</span>
            <i className={styles.cardLatin}>{latin}</i>
            <span className={styles.pills}>
              <span className={styles.pill}>{here} here</span>
              <span className={styles.pill}>{world} worldwide</span>
            </span>
          </li>
        ))}
      </ul>
      <p className={styles.demoNote}>Sample cards. Each species gets two rarities on a region's checklist.</p>
    </div>
  );
}
