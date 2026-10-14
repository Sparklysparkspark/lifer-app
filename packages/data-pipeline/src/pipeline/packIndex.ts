// The shape of pack-index.json, shared by the pack builder and the pack store writer.
export interface IndexPack {
  id: string;
  type: "region" | "seaZone";
  region?: string;
  seaZone?: string;
  taxon?: string | null;
  variant?: "full" | "small";
  sizeBytes: number;
  speciesCount: number;
  contentVersion: string;
  scientificNames: string[];
  /** The pack store shard holding it, with `range` [offset, length] and the archive's `sha256`
   *  (pipeline/packStore.ts). */
  url: string;
  range?: [number, number];
  sha256?: string;
  format?: number;
  seaZoneDependencies?: string[];
}
export interface PackIndex {
  generatedAt: string;
  packs: IndexPack[];
}
