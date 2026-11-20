import type { Palette } from "./theme";

export type GroupId = "birds" | "mammals" | "reptiles" | "amphibians" | "fish" | "insects" | "arachnids" | "other";

export interface Group {
  id: GroupId;
  /** Key in en.json under groups. */
  label: `groups.${GroupId}`;
  color: keyof Palette;
}

const GROUPS: Record<GroupId, Group> = {
  birds: { id: "birds", label: "groups.birds", color: "taxa-birds" },
  mammals: { id: "mammals", label: "groups.mammals", color: "taxa-mammals" },
  reptiles: { id: "reptiles", label: "groups.reptiles", color: "taxa-reptiles" },
  amphibians: { id: "amphibians", label: "groups.amphibians", color: "taxa-amphibians" },
  fish: { id: "fish", label: "groups.fish", color: "taxa-fish" },
  insects: { id: "insects", label: "groups.insects", color: "taxa-insects" },
  arachnids: { id: "arachnids", label: "groups.arachnids", color: "taxa-arachnids" },
  other: { id: "other", label: "groups.other", color: "taxa-other" },
};

export const groupById = (id: GroupId): Group => GROUPS[id];

const OF: Record<string, GroupId> = {
  aves: "birds",
  mammalia: "mammals",
  aquatic_mammalia: "mammals",
  squamata: "reptiles",
  testudines: "reptiles",
  reptilia: "reptiles",
  amphibia: "amphibians",
  actinopterygii: "fish",
  elasmobranchii: "fish",
  insecta: "insects",
  arachnida: "arachnids",
};

/** The broad group a taxon class belongs to (the desktop's grouping), with its taxa colour. */
export const groupOf = (taxonClass: string | null): Group => GROUPS[(taxonClass && OF[taxonClass.toLowerCase()]) || "other"];

/** Display order of the broad groups. */
export const GROUP_ORDER: GroupId[] = ["birds", "mammals", "reptiles", "amphibians", "fish", "insects", "arachnids", "other"];

/** The taxon classes that make up a broad group (not "other", which is whatever is left). */
export const classesOf = (id: GroupId): string[] => Object.entries(OF).filter(([, g]) => g === id).map(([c]) => c);
