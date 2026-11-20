import type { App } from "./AppContext";
import { editMark } from "../store/marks";

const newId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Marks a species seen or not, or as a target or not. Kept at once; the hub hears about it when it can. */
export async function changeMark(
  app: Pick<App, "db" | "bump">,
  scientificName: string,
  patch: { state?: "seen" | "collected" | null; isTarget?: boolean },
): Promise<void> {
  await editMark(app.db, scientificName, patch, new Date());
  app.bump();
}

export const newLocalId = newId;
