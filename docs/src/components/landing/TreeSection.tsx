import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import styles from "./landing.module.css";

/** Loads the interactive circle only when it nears the screen; until then, and without
 *  JavaScript, `fallback` (a screenshot) shows. */
export default function TreeSection({ fallback }: { fallback: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [Demo, setDemo] = useState<ComponentType | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const load = () => import("./TreeDemo").then((m) => setDemo(() => m.default));
    if (!("IntersectionObserver" in window)) return void load();
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        load();
      },
      { rootMargin: "400px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={styles.treeSlot}>
      {Demo ? <Demo /> : fallback}
    </div>
  );
}
