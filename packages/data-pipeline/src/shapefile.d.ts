// No official types package exists for "shapefile" (verified: no @types/shapefile on npm).
// Only the convenience `read` function (shp+dbf -> full GeoJSON FeatureCollection) is used
// here, so only that is declared.
declare module "shapefile" {
  export function read(shp: string, dbf?: string): Promise<{ type: "FeatureCollection"; features: unknown[] }>;
}
