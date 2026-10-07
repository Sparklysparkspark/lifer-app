// Species you add to a region's or a sea zone's checklist yourself (apps/api
// regions/checklistAdditions.ts), from the species page or a region's checklist.
import type { RegionSummary } from "@lifer/shared";
import { api } from "../api/client";
import i18n from "../i18n";

export interface AddToChecklistResult {
  ok: boolean;
  /** False when you'd already added it there. */
  added: boolean;
  /** The catalog already lists the species there. */
  alreadyOnChecklist: boolean;
}

/** Where an addition goes: a region (country, province or state) or a sea zone. */
export type ChecklistKind = "region" | "seaZone";

export interface ChecklistTarget {
  kind: ChecklistKind;
  id: string;
  name: string;
}

export interface SpeciesChecklistAddition {
  regionId: string;
  regionName: string;
  addedAt: string;
  alreadyOnChecklist: boolean;
}

export interface SpeciesSeaZoneAddition {
  seaZoneId: string;
  seaZoneName: string;
  addedAt: string;
  alreadyOnChecklist: boolean;
  /** A region whose checklist offers this sea zone as nearby water, to view the addition from. */
  nearRegionId: string | null;
}

export interface SeaZoneSummary {
  id: string;
  name: string;
}

const additionPath = (kind: ChecklistKind, id: string, speciesId: string) =>
  `/${kind === "seaZone" ? "sea-zones" : "regions"}/${encodeURIComponent(id)}/checklist-additions/${encodeURIComponent(speciesId)}`;

export const addToChecklist = (id: string, speciesId: string, kind: ChecklistKind = "region") =>
  api.put<AddToChecklistResult>(additionPath(kind, id, speciesId));

export const removeFromChecklist = (id: string, speciesId: string, kind: ChecklistKind = "region") =>
  api.delete<{ ok: boolean }>(additionPath(kind, id, speciesId));

export const listSpeciesChecklistAdditions = (speciesId: string) =>
  api.get<{ items: SpeciesChecklistAddition[]; seaZones: SpeciesSeaZoneAddition[] }>(
    `/species/${encodeURIComponent(speciesId)}/checklist-additions`,
  );

export const listSeaZones = () => api.get<{ zones: SeaZoneSummary[] }>("/sea-zones").then((res) => res.zones);

/** The checklist view that shows a sea zone addition: a nearby region with only that zone's water. */
export const seaZoneViewPath = (addition: SpeciesSeaZoneAddition) =>
  addition.nearRegionId ? `/?region=${addition.nearRegionId}&seaZones=${addition.seaZoneId}&includeLand=0` : null;

/** Whether a region has a checklist of its own to add to: a country (it has a code) or a region
 *  inside one. World and the continents don't. The server checks the same thing. */
export function regionHasChecklist(region: RegionSummary | undefined, byId: Map<string, RegionSummary>): boolean {
  if (!region) return false;
  if (region.hasScopedChecklist) return true;
  const parent = region.parentId ? byId.get(region.parentId) : undefined;
  return parent?.hasScopedChecklist ?? false;
}

/** How a checklist reads in a sentence: "British Columbia's checklist", "the Gulf of Alaska checklist". */
export function checklistLabel(target: Pick<ChecklistTarget, "kind" | "name">): string {
  return i18n.t("regions.checklist.label", { kind: target.kind, name: target.name });
}

/** The toast after an add. */
export function addedMessage(
  result: AddToChecklistResult,
  speciesName: string,
  target: Pick<ChecklistTarget, "kind" | "name">,
): string {
  const values = { species: speciesName, kind: target.kind, name: target.name };
  if (result.alreadyOnChecklist) return i18n.t("regions.checklist.alreadyOn", values);
  if (!result.added) return i18n.t("regions.checklist.alreadyAdded", values);
  return i18n.t("regions.checklist.added", values);
}

/** The toast after taking your own addition off a checklist again. */
export function removedMessage(speciesName: string, target: Pick<ChecklistTarget, "kind" | "name">): string {
  return i18n.t("regions.checklist.removed", { species: speciesName, kind: target.kind, name: target.name });
}
