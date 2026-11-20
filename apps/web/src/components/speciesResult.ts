// Its own module so the picker and the add-taxa modal it opens can share it without a cycle.
export interface SpeciesResult {
  id: string;
  scientific_name: string;
  common_name: string | null;
  aba_code?: string | null;
  ebird_code?: string | null;
}
