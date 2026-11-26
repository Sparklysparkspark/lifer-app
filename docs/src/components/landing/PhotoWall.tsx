import useBaseUrl from "@docusaurus/useBaseUrl";
import { COLLECTION_TREE, type TreeNode } from "./collectionTree";
import styles from "./landing.module.css";

// Hand-picked from the trip's photos for sharpness and variety; names as in the tree data.
const PICKS = [
  "Vermilion Flycatcher",
  "Boat-Billed Heron",
  "Brown Anole",
  "Tropical Kingbird",
  "Common Black Hawk",
  "Summer Tanager",
  "Morelet's Crocodile",
  "Snowy Egret",
  "Fork-Tailed Flycatcher",
  "Green Kingfisher",
  "Spotted Sandpiper",
  "Black Spiny-Tailed Iguana",
  "Magnolia Warbler",
  "Limpkin",
  "Ruddy Ground-Dove",
  "Blue-Gray Gnatcatcher",
];
const species = (n: TreeNode): TreeNode[] =>
  n.rank === "species" ? (n.photo ? [n] : []) : n.children.flatMap(species);
const byName = new Map(species(COLLECTION_TREE).map((s) => [s.name, s]));
// A pick missing after a new export is skipped rather than shown blank.
const picks = PICKS.flatMap((name) => byName.get(name) ?? []);

/** A grid of species photos from the trip in the story below. */
export default function PhotoWall() {
  const base = useBaseUrl("/img/tree/");
  return (
    <ul className={styles.wall} aria-label="Species photographed on the trip">
      {picks.map((s) => (
        <li key={s.id}>
          <img src={`${base}${s.photo}.jpg`} alt={s.name} title={s.name} width={240} height={240} />
        </li>
      ))}
    </ul>
  );
}
